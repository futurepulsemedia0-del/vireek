// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("../notify/deliver.ts", () => ({ sendEmail: vi.fn().mockResolvedValue({ ok: true }) }));
import { planDisclosure, recordDisclosureOutcome } from "./ledger.ts";

const D = "This call is answered by an AI voice assistant, not a live person.";

/** Minimal chainable fake of the supabase-js surface the ledger uses. */
function fakeAdmin(opts: { existing?: Record<string, unknown> | null; versions?: unknown[]; lang?: string } = {}) {
  const upserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    const ret = () => chain;
    for (const m of ["select", "eq", "order", "limit"]) chain[m] = ret;
    chain.maybeSingle = () => Promise.resolve({
      data: table === "call_ai_disclosures" ? opts.existing ?? null : { ai_disclosure_script: D, ai_disclosure_language: opts.lang ?? "en" },
    });
    chain.then = (res: (v: unknown) => unknown) => res({ data: table === "ai_disclosure_versions" ? opts.versions ?? [] : [] });
    chain.upsert = (row: Record<string, unknown>) => { upserts.push(row); return Promise.resolve({ error: null }); };
    chain.update = (row: Record<string, unknown>) => { updates.push(row); return chain; };
    return chain;
  };
  return {
    upserts, updates, rpcs,
    from: builder,
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return Promise.resolve({ data: fn === "ai_disclosure_raise_alert" ? true : "ver-1", error: null });
    },
    auth: { admin: { getUserById: () => Promise.resolve({ data: { user: { email: "o@x.com" } } }) } },
  };
}

const base = { userId: "u1", vapiCallId: "vc1", callId: "c1", callStartedAt: "2027-01-01T10:00:00.000Z", durationSeconds: 90 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAdmin = (a: unknown) => a as any;

describe("planDisclosure", () => {
  it("registers the version and writes a pending proof row", async () => {
    const admin = fakeAdmin();
    const plan = await planDisclosure(asAdmin(admin), { userId: "u1", vapiCallId: "vc1", callerLanguage: "es" });
    expect(plan).toMatchObject({ language: "es", source: "builtin_translation", versionId: "ver-1" });
    expect(admin.rpcs[0].fn).toBe("ai_disclosure_register_version");
    expect(admin.upserts[0]).toMatchObject({ status: "pending", vapi_call_id: "vc1", language: "es" });
  });
  it("does not write a row when the call id is unknown, but still returns the plan", async () => {
    const admin = fakeAdmin();
    const plan = await planDisclosure(asAdmin(admin), { userId: "u1", vapiCallId: null, callerLanguage: null });
    expect(plan?.text).toBe(D);
    expect(admin.upserts).toHaveLength(0);
  });
});

describe("recordDisclosureOutcome", () => {
  it("records delivered proof with timestamp, offset and transcript hash; no alert", async () => {
    const admin = fakeAdmin();
    const out = await recordDisclosureOutcome(asAdmin(admin), {
      ...base,
      message: { artifact: { messages: [{ role: "bot", message: `${D} Hi!`, secondsFromStart: 1.5 }, { role: "user", message: "hello", secondsFromStart: 6 }] } },
      transcript: `AI: ${D} Hi!\nUser: hello`,
    });
    expect(out?.status).toBe("delivered");
    expect(admin.upserts[0]).toMatchObject({
      status: "delivered", offset_seconds: 1.5, matched_via: "planned", language: "en",
      delivered_at: "2027-01-01T10:00:01.500Z", call_id: "c1",
    });
    expect(String(admin.upserts[0].transcript_sha256)).toHaveLength(64);
    expect(admin.rpcs.some((r) => r.fn === "ai_disclosure_raise_alert")).toBe(false);
  });
  it("missing disclosure -> missing row + alert RPC + alerted_at stamp", async () => {
    const admin = fakeAdmin();
    const out = await recordDisclosureOutcome(asAdmin(admin), {
      ...base,
      message: { artifact: { messages: [{ role: "bot", message: "Hello, thanks for calling Acme.", secondsFromStart: 1 }] } },
      transcript: "AI: Hello, thanks for calling Acme.",
    });
    expect(out?.status).toBe("missing");
    expect(admin.rpcs.find((r) => r.fn === "ai_disclosure_raise_alert")?.args).toMatchObject({ p_user_id: "u1", p_type: "ai_disclosure_missing" });
    expect(admin.updates[0]).toHaveProperty("alerted_at");
  });
  it("falls back to the plain transcript when Vapi sends no message array", async () => {
    const admin = fakeAdmin();
    const out = await recordDisclosureOutcome(asAdmin(admin), { ...base, message: {}, transcript: `AI: ${D}\nUser: ok` });
    expect(out?.status).toBe("delivered");
    expect(admin.upserts[0].transcript_char_offset).toBe(4);
  });
  it("flags a language mismatch when the caller clearly spoke another language", async () => {
    const admin = fakeAdmin();
    await recordDisclosureOutcome(asAdmin(admin), {
      ...base,
      message: {},
      transcript: `AI: ${D}\nUser: Hola, necesito que alguien venga a revisar mi aire acondicionado, por favor, no funciona desde ayer.`,
    });
    expect(admin.upserts[0]).toMatchObject({ detected_language: "es", language_mismatch: true });
  });
  it("is idempotent: a finished proof row is never rewritten", async () => {
    const admin = fakeAdmin({ existing: { id: "x", status: "delivered" } });
    const out = await recordDisclosureOutcome(asAdmin(admin), { ...base, message: {}, transcript: "AI: hi" });
    expect(out?.status).toBe("delivered");
    expect(admin.upserts).toHaveLength(0);
  });
  it("never throws, even if the database client blows up", async () => {
    const broken = { from: () => { throw new Error("db down"); }, rpc: () => { throw new Error("db down"); } };
    await expect(recordDisclosureOutcome(asAdmin(broken), { ...base, message: {}, transcript: null })).resolves.toBeNull();
  });
});
