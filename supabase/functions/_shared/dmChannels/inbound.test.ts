import { describe, it, expect } from "vitest";
import { persistInbound, recordSystemReply } from "./inbound.ts";
import type { InboundMessage } from "./protocol.ts";

type Row = Record<string, unknown>;
interface Opts { hideNextConvSelect?: boolean; failMessageInsert?: boolean }

/** Minimal in-memory stand-in for the service-role Supabase client (just what inbound.ts uses). */
function fakeAdmin(opts: Opts = {}) {
  const tables: Record<string, Row[]> = { dm_conversations: [], dm_messages: [] };
  let seq = 0;
  let hide = opts.hideNextConvSelect === true;

  const from = (name: string) => {
    const st = { op: "select", filters: [] as Array<[string, unknown]>, patch: null as Row | null, row: null as Row | null };
    const match = (r: Row) => st.filters.every(([c, v]) => r[c] === v);
    const exec = async (): Promise<{ data: Row | null; error: { code?: string; message: string } | null }> => {
      const t = tables[name];
      if (st.op === "select") {
        if (name === "dm_conversations" && hide) { hide = false; return { data: null, error: null }; }
        return { data: t.find(match) ?? null, error: null };
      }
      if (st.op === "insert") {
        const row = st.row as Row;
        if (name === "dm_messages" && opts.failMessageInsert) return { data: null, error: { code: "XX000", message: "boom" } };
        const dup = name === "dm_conversations"
          ? t.some((r) => r.user_id === row.user_id && r.channel === row.channel && r.customer_external_id === row.customer_external_id)
          : row.provider_message_id != null && t.some((r) => r.conversation_id === row.conversation_id && r.direction === row.direction && r.provider_message_id === row.provider_message_id);
        if (dup) return { data: null, error: { code: "23505", message: "duplicate key" } };
        const stored = { id: `${name}-${++seq}`, ...row };
        t.push(stored);
        return { data: stored, error: null };
      }
      t.filter(match).forEach((r) => Object.assign(r, st.patch));
      return { data: null, error: null };
    };
    const b = {
      select: () => b,
      insert: (row: Row) => { st.op = "insert"; st.row = row; return b; },
      update: (patch: Row) => { st.op = "update"; st.patch = patch; return b; },
      eq: (c: string, v: unknown) => { st.filters.push([c, v]); return b; },
      maybeSingle: exec,
      single: exec,
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec().then(res, rej),
    };
    return b;
  };
  return { admin: { from } as never, tables };
}

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "telegram", externalAccountId: "bot1", customerId: "555", customerName: "Ada", providerMessageId: "1",
  text: "hello", sentAt: "2026-10-27T11:59:00.000Z", ...over,
});

describe("persistInbound", () => {
  it("creates the conversation and stores the message", async () => {
    const { admin, tables } = fakeAdmin();
    const out = await persistInbound(admin, "u1", msg());
    expect(out).toMatchObject({ duplicate: false, keyword: null });
    expect(tables.dm_conversations).toHaveLength(1);
    expect(tables.dm_conversations[0]).toMatchObject({
      user_id: "u1", channel: "telegram", customer_external_id: "555", customer_name: "Ada", unread: true, last_inbound_at: "2026-10-27T11:59:00.000Z",
    });
    expect(tables.dm_messages[0]).toMatchObject({ direction: "inbound", body: "hello", provider_message_id: "1" });
  });

  it("reuses the conversation for later messages and refreshes read state", async () => {
    const { admin, tables } = fakeAdmin();
    await persistInbound(admin, "u1", msg());
    tables.dm_conversations[0].unread = false;
    await persistInbound(admin, "u1", msg({ providerMessageId: "2", text: "again", sentAt: "2026-10-27T12:30:00.000Z" }));
    expect(tables.dm_conversations).toHaveLength(1);
    expect(tables.dm_messages).toHaveLength(2);
    expect(tables.dm_conversations[0]).toMatchObject({ unread: true, last_inbound_at: "2026-10-27T12:30:00.000Z" });
  });

  it("treats a provider retry as a no-op duplicate", async () => {
    const { admin, tables } = fakeAdmin();
    await persistInbound(admin, "u1", msg());
    tables.dm_conversations[0].unread = false;
    const retry = await persistInbound(admin, "u1", msg());
    expect(retry.duplicate).toBe(true);
    expect(retry.keyword).toBeNull();
    expect(tables.dm_messages).toHaveLength(1);
    expect(tables.dm_conversations[0].unread).toBe(false);
  });

  it("keeps tenants and channels separate", async () => {
    const { admin, tables } = fakeAdmin();
    await persistInbound(admin, "u1", msg());
    await persistInbound(admin, "u2", msg());
    await persistInbound(admin, "u1", msg({ channel: "messenger", providerMessageId: "m.1" }));
    expect(tables.dm_conversations).toHaveLength(3);
  });

  it("applies STOP and START to the conversation", async () => {
    const { admin, tables } = fakeAdmin();
    const stop = await persistInbound(admin, "u1", msg({ text: " STOP " }));
    expect(stop.keyword).toBe("stop");
    expect(typeof tables.dm_conversations[0].opted_out_at).toBe("string");
    const start = await persistInbound(admin, "u1", msg({ providerMessageId: "2", text: "start" }));
    expect(start.keyword).toBe("start");
    expect(tables.dm_conversations[0].opted_out_at).toBeNull();
    const plain = await persistInbound(admin, "u1", msg({ providerMessageId: "3", text: "cancel my appointment" }));
    expect(plain.keyword).toBeNull();
  });

  it("resolves a missing name once, and survives a failing lookup", async () => {
    const a = fakeAdmin();
    let calls = 0;
    await persistInbound(a.admin, "u1", msg({ channel: "messenger", customerName: null }), async () => { calls++; return "Grace Hopper"; });
    expect(a.tables.dm_conversations[0].customer_name).toBe("Grace Hopper");
    await persistInbound(a.admin, "u1", msg({ channel: "messenger", customerName: null, providerMessageId: "2" }), async () => { calls++; return "X"; });
    expect(calls).toBe(1);

    const b = fakeAdmin();
    const out = await persistInbound(b.admin, "u1", msg({ customerName: null }), async () => { throw new Error("graph down"); });
    expect(out.duplicate).toBe(false);
    expect(b.tables.dm_conversations[0].customer_name).toBeNull();
  });

  it("recovers when a concurrent webhook created the conversation first", async () => {
    const { admin, tables } = fakeAdmin({ hideNextConvSelect: true });
    tables.dm_conversations.push({ id: "pre", user_id: "u1", channel: "telegram", customer_external_id: "555", customer_name: null });
    const out = await persistInbound(admin, "u1", msg());
    expect(out.conversationId).toBe("pre");
    expect(tables.dm_messages[0].conversation_id).toBe("pre");
  });

  it("throws on unexpected database errors so the provider retries", async () => {
    const { admin } = fakeAdmin({ failMessageInsert: true });
    await expect(persistInbound(admin, "u1", msg())).rejects.toThrow("boom");
  });
});

describe("recordSystemReply", () => {
  it("stores the acknowledgement as a system message and ignores duplicates", async () => {
    const { admin, tables } = fakeAdmin();
    await recordSystemReply(admin, "c1", "You're unsubscribed", "p1");
    await recordSystemReply(admin, "c1", "You're unsubscribed", "p1");
    expect(tables.dm_messages).toHaveLength(1);
    expect(tables.dm_messages[0]).toMatchObject({ direction: "outbound", sent_by: "system", provider_message_id: "p1" });
  });
});
