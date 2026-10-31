import { describe, expect, it } from "vitest";
import {
  MAX_ATTEMPTS, STALE_PROCESSING_MS, buildReplayPayload, claimEvent, completeEvent, decideClaim, failEvent,
  supabaseLedgerStore, type LedgerRow, type LedgerStore,
} from "./ledger.ts";

const KEY = { userId: "u1", vapiCallId: "call-1", eventType: "end-of-call-report" };

/** In-memory store with the same unique-key + optimistic-lock semantics as the SQL table. */
function memStore(opts: { failClaim?: boolean } = {}) {
  const rows = new Map<string, LedgerRow & { last_error?: string | null; payload?: unknown }>();
  let clock = 1_000_000;
  const store: LedgerStore & { rows: typeof rows; tick(ms: number): void } = {
    rows,
    tick: (ms) => { clock += ms; },
    async claim(k) {
      if (opts.failClaim) throw new Error("relation voice_webhook_events does not exist");
      const id = `${k.vapiCallId}|${k.eventType}`;
      const ex = rows.get(id);
      if (ex) return { row: { ...ex }, created: false };
      const row = { id, status: "processing" as const, attempts: 1, updated_at: new Date(clock).toISOString() };
      rows.set(id, row);
      return { row: { ...row }, created: true };
    },
    async reclaim(r) {
      const ex = rows.get(r.id)!;
      if (ex.status !== r.status || ex.attempts !== r.attempts) return null;
      ex.status = "processing"; ex.attempts += 1; ex.updated_at = new Date(clock).toISOString();
      return { ...ex };
    },
    async mark(id, patch) {
      const ex = rows.get(id)!;
      Object.assign(ex, patch, { updated_at: new Date(clock).toISOString() });
    },
  };
  return { store, now: () => clock };
}

describe("decideClaim", () => {
  const row = (status: LedgerRow["status"], attempts = 1, ageMs = 0): LedgerRow => ({ id: "x", status, attempts, updated_at: new Date(1_000_000 - ageMs).toISOString() });
  it("new -> process", () => expect(decideClaim(row("processing"), true, 1_000_000)).toBe("process"));
  it("processed / replayed -> duplicate", () => {
    expect(decideClaim(row("processed"), false, 1_000_000)).toBe("duplicate");
    expect(decideClaim(row("replayed"), false, 1_000_000)).toBe("duplicate");
  });
  it("fresh processing -> duplicate (in flight); stale processing -> retry", () => {
    expect(decideClaim(row("processing", 1, 1_000), false, 1_000_000)).toBe("duplicate");
    expect(decideClaim(row("processing", 1, STALE_PROCESSING_MS + 1), false, 1_000_000)).toBe("retry");
  });
  it("failed -> retry until MAX_ATTEMPTS, then dead", () => {
    expect(decideClaim(row("failed", 1), false, 1_000_000)).toBe("retry");
    expect(decideClaim(row("failed", MAX_ATTEMPTS), false, 1_000_000)).toBe("dead");
    expect(decideClaim(row("dead", 1), false, 1_000_000)).toBe("dead");
  });
  it("garbage timestamp on a processing row is retried, not wedged forever", () => {
    expect(decideClaim({ id: "x", status: "processing", attempts: 1, updated_at: "nope" }, false, 1_000_000)).toBe("retry");
  });
});

describe("idempotent end-of-call-report flow", () => {
  it("first delivery processes; an identical second delivery is a duplicate (side effects must not rerun)", async () => {
    const { store, now } = memStore();
    const a = await claimEvent(store, KEY, now());
    expect(a.decision).toBe("process");
    await completeEvent(store, a.decision === "process" ? a.id : null);
    expect((await claimEvent(store, KEY, now())).decision).toBe("duplicate");
    expect([...store.rows.values()][0].status).toBe("processed");
  });
  it("two concurrent first deliveries: exactly one processes", async () => {
    const { store, now } = memStore();
    const [a, b] = await Promise.all([claimEvent(store, KEY, now()), claimEvent(store, KEY, now())]);
    expect([a.decision, b.decision].sort()).toEqual(["duplicate", "process"]);
  });
  it("persist failure -> failed row keeps minimal facts; redelivery retries with attempts+1 and then succeeds", async () => {
    const { store, now } = memStore();
    const a = await claimEvent(store, KEY, now());
    if (a.decision !== "process") throw new Error("expected process");
    const payload = buildReplayPayload({ callerPhone: "+15551230000", callerName: "Ann", durationSeconds: 61.6, summary: "Leaking water heater", endedReason: "customer-ended-call" });
    expect(await failEvent(store, a.id, a.attempts, "calls upsert failed", payload)).toEqual({ dead: false });
    const row = [...store.rows.values()][0];
    expect(row.status).toBe("failed");
    expect(row.payload).toMatchObject({ caller_phone: "+15551230000", duration_seconds: 62, summary: "Leaking water heater" });

    const b = await claimEvent(store, KEY, now());
    expect(b).toMatchObject({ decision: "process", attempts: 2 });
    if (b.decision !== "process") throw new Error();
    await completeEvent(store, b.id);
    expect(row.status).toBe("processed");
  });
  it("after MAX_ATTEMPTS failures the event is dead-lettered (provider told 200 so it stops) and never reprocessed", async () => {
    const { store, now } = memStore();
    let last: { dead: boolean } = { dead: false };
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const c = await claimEvent(store, KEY, now());
      if (c.decision !== "process") throw new Error(`attempt ${i}: ${c.decision}`);
      expect(c.attempts).toBe(i);
      last = await failEvent(store, c.id, c.attempts, "boom", {});
    }
    expect(last.dead).toBe(true);
    expect([...store.rows.values()][0].status).toBe("dead");
    expect((await claimEvent(store, KEY, now())).decision).toBe("dead");
  });
  it("a crashed worker (stuck 'processing') is taken over after the stale window, but only once under a race", async () => {
    const { store, now } = memStore();
    await claimEvent(store, KEY, now());
    store.tick(STALE_PROCESSING_MS + 5_000);
    const [a, b] = await Promise.all([claimEvent(store, KEY, now()), claimEvent(store, KEY, now())]);
    expect([a.decision, b.decision].sort()).toEqual(["duplicate", "process"]);
  });
  it("fails OPEN when the ledger is unavailable (migration not applied): event still processed, nothing throws", async () => {
    const { store } = memStore({ failClaim: true });
    const r = await claimEvent(store, KEY);
    expect(r).toEqual({ decision: "process", id: null, attempts: 1 });
    await expect(completeEvent(store, null)).resolves.toBeUndefined();
    expect(await failEvent(store, null, 1, "x", {})).toEqual({ dead: false });
  });
  it("last_error is truncated; replay payload never carries transcript or recording", async () => {
    const { store, now } = memStore();
    const c = await claimEvent(store, KEY, now());
    if (c.decision !== "process") throw new Error();
    await failEvent(store, c.id, 1, "e".repeat(5000), {});
    expect(([...store.rows.values()][0].last_error as string).length).toBe(500);
    expect(Object.keys(buildReplayPayload({ callerPhone: null, callerName: null, durationSeconds: null, summary: null, endedReason: null })).sort())
      .toEqual(["caller_name", "caller_phone", "duration_seconds", "ended_reason", "summary"]);
  });
});

describe("supabaseLedgerStore adapter", () => {
  function fakeAdmin(script: Array<{ data?: unknown; error?: { code?: string; message?: string } | null }>) {
    const log: string[] = [];
    let i = 0;
    const chain: Record<string, unknown> = {};
    const q = new Proxy(chain, {
      get: (_t, prop: string) => {
        if (prop === "maybeSingle") return async () => script[i++] ?? { data: null, error: null };
        if (prop === "then") return undefined;
        return (...args: unknown[]) => { log.push(`${prop}:${JSON.stringify(args)}`); return q; };
      },
    });
    return { admin: { from: (t: string) => { log.push(`from:${t}`); return q; } }, log };
  }
  it("insert ok -> created", async () => {
    const { admin } = fakeAdmin([{ data: { id: "1", status: "processing", attempts: 1, updated_at: "t" } }]);
    expect(await supabaseLedgerStore(admin).claim(KEY)).toMatchObject({ created: true });
  });
  it("unique violation 23505 -> falls back to select of the existing row", async () => {
    const { admin } = fakeAdmin([{ data: null, error: { code: "23505" } }, { data: { id: "1", status: "processed", attempts: 1, updated_at: "t" } }]);
    expect(await supabaseLedgerStore(admin).claim(KEY)).toMatchObject({ created: false, row: { status: "processed" } });
  });
  it("any other insert error throws (caller fails open)", async () => {
    const { admin } = fakeAdmin([{ data: null, error: { code: "42P01", message: "no table" } }]);
    await expect(supabaseLedgerStore(admin).claim(KEY)).rejects.toThrow("no table");
  });
});
