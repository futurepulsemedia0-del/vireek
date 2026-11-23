import { describe, expect, it } from "vitest";
import { buildCallStartPlan } from "./callStartPlan";
import { finalizeCallRecording, recordCallStartPlan } from "./callRecordingLedger";

type Row = Record<string, unknown>;
/** Tiny in-memory stand-in for the supabase client: only what the ledger glue uses. */
function fakeAdmin(opts: { failUpsert?: boolean } = {}) {
  const rows: Row[] = [];
  const admin = {
    rows,
    from(_t: string) {
      const filters: Array<[string, unknown]> = [];
      let patch: Row | null = null;
      const match = () => rows.filter((r) => filters.every(([k, v]) => r[k] === v));
      const q: any = {
        upsert: async (row: Row, o: { ignoreDuplicates?: boolean }) => {
          if (opts.failUpsert) return { error: { message: "boom" } };
          const dup = rows.find((r) => r.user_id === row.user_id && r.vapi_call_id === row.vapi_call_id);
          if (!dup || !o?.ignoreDuplicates) rows.push({ ...row });
          return { error: null };
        },
        select: () => q,
        update: (p: Row) => { patch = p; return q; },
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
        maybeSingle: async () => ({ data: match()[0] ?? null }),
        then: (res: (v: unknown) => void) => { if (patch) match().forEach((r) => Object.assign(r, patch)); res({ error: null }); },
      };
      return q;
    },
  };
  return admin;
}

const plan = (o = {}) => buildCallStartPlan({ aiDisclosureText: "AI.", language: "en", callerNumber: "+14155550100", businessCountry: "US", greeting: "Hi.", gateMode: "enforce", ...o });
const msgs = (...t: Array<["bot" | "user", string]>) => ({ artifact: { messages: t.map(([role, message]) => ({ role, message })) } });

describe("recordCallStartPlan", () => {
  it("writes one pending row, idempotently, without any caller phone number", async () => {
    const a = fakeAdmin();
    const p = plan();
    expect(await recordCallStartPlan(a as any, { userId: "u1", vapiCallId: "c1", plan: p, businessCountry: "US" })).toBe(true);
    await recordCallStartPlan(a as any, { userId: "u1", vapiCallId: "c1", plan: p, businessCountry: "US" });
    expect(a.rows.length).toBe(1);
    expect(a.rows[0].consent_outcome).toBe("pending");
    expect(a.rows[0].caller_state).toBe("CA");
    expect(a.rows[0].decision).toBe("no_recording_consent_gate");
    expect(JSON.stringify(a.rows[0])).not.toContain("4155550100");
    expect(typeof a.rows[0].notice_sha256).toBe("string");
  });
  it("does nothing without a call id and never throws on db errors", async () => {
    const a = fakeAdmin({ failUpsert: true });
    expect(await recordCallStartPlan(a as any, { userId: "u1", vapiCallId: null, plan: plan(), businessCountry: "US" })).toBe(false);
    expect(await recordCallStartPlan(a as any, { userId: "u1", vapiCallId: "c1", plan: plan(), businessCountry: "US" })).toBe(false);
  });
});

describe("finalizeCallRecording", () => {
  it("returns null when no plan row exists (keep today's behaviour)", async () => {
    expect(await finalizeCallRecording(fakeAdmin() as any, { userId: "u1", vapiCallId: "none", message: {} })).toBeNull();
  });
  it("enforce + consent gate: refusal keeps nothing and the row is finalized with the evidence", async () => {
    const a = fakeAdmin();
    const p = plan();
    await recordCallStartPlan(a as any, { userId: "u1", vapiCallId: "c1", plan: p, businessCountry: "US" });
    const r = await finalizeCallRecording(a as any, { userId: "u1", vapiCallId: "c1", message: msgs(["bot", p.firstMessage], ["user", "No thanks"]) });
    expect(r?.outcome).toBe("declined");
    expect(r?.storage.storeRecording).toBe(false);
    expect(r?.storage.storeTranscript).toBe(false);
    expect(a.rows[0].consent_outcome).toBe("declined");
    expect(a.rows[0].notice_in_first_turn).toBe(true);
    expect(a.rows[0].recording_stored).toBe(false);
  });
  it("enforce + consent gate: an explicit yes keeps the transcript only", async () => {
    const a = fakeAdmin();
    const p = plan();
    await recordCallStartPlan(a as any, { userId: "u1", vapiCallId: "c2", plan: p, businessCountry: "US" });
    const r = await finalizeCallRecording(a as any, { userId: "u1", vapiCallId: "c2", message: msgs(["bot", p.firstMessage], ["user", "Yes, that's fine"]) });
    expect(r?.storage).toMatchObject({ storeRecording: false, storeTranscript: true });
  });
  it("is idempotent: a redelivered report never rewrites a final row", async () => {
    const a = fakeAdmin();
    const p = plan();
    await recordCallStartPlan(a as any, { userId: "u1", vapiCallId: "c3", plan: p, businessCountry: "US" });
    await finalizeCallRecording(a as any, { userId: "u1", vapiCallId: "c3", message: msgs(["bot", p.firstMessage], ["user", "no"]) });
    const again = await finalizeCallRecording(a as any, { userId: "u1", vapiCallId: "c3", message: msgs(["bot", p.firstMessage], ["user", "yes"]) });
    expect(again?.outcome).toBe("declined");
    expect(a.rows[0].consent_outcome).toBe("declined");
  });
  it("flags the notice as NOT in the first assistant turn when the provider ignored the override", async () => {
    const a = fakeAdmin();
    const p = plan({ callerNumber: "+12145550100", gateMode: "shadow" });
    await recordCallStartPlan(a as any, { userId: "u1", vapiCallId: "c4", plan: p, businessCountry: "US" });
    await finalizeCallRecording(a as any, { userId: "u1", vapiCallId: "c4", message: msgs(["bot", "Hi, thanks for calling."], ["user", "hello"]) });
    expect(a.rows[0].notice_in_first_turn).toBe(false);
  });
});
