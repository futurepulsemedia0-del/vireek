import { describe, expect, it } from "vitest";
import { sendViaTwilioGuarded, type TwilioSendDeps } from "./sendSms.ts";
import { sendGuardedSms } from "./gatedSend.ts";
import { PLAN_LIMITS } from "../fraud/planLimits.ts";
import { MARKETING_CAP_SHARE } from "../fraud/guard.ts";
import { NOW, UK, US, baseCtx, makeDb } from "../fraud/testDb.ts";

const ENV: Record<string, string> = { TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "tok", TWILIO_MESSAGING_SERVICE_SID: "MGtest" };

function harness(db: ReturnType<typeof makeDb>["db"]) {
  const calls: { url: string; body: string }[] = [];
  const usage: unknown[] = [];
  const deps: TwilioSendDeps = {
    env: (k) => ENV[k],
    fetchImpl: async (url, init) => { calls.push({ url, body: String(init?.body) }); return new Response(JSON.stringify({ sid: "SM1" }), { status: 201 }); },
    recordUsage: async (_a, u) => { usage.push(u); },
  };
  return { admin: db as never, calls, usage, deps };
}

describe("sendCompliantSms Twilio step: fraud guard before the provider", () => {
  it("ALLOWED: one Twilio request, usage recorded", async () => {
    const { db } = makeDb(baseCtx());
    const h = harness(db);
    const r = await sendViaTwilioGuarded(h.admin, "u1", US, "hi", { purpose: "service", source: "t" }, h.deps);
    expect(r).toEqual({ ok: true, sid: "SM1" });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toContain("/Messages.json");
    expect(h.usage).toHaveLength(1);
  });

  it("BLOCKED (enforce): Twilio is never called, typed result, no usage", async () => {
    const { db } = makeDb(baseCtx({ outbound_unlocked: false }));
    const h = harness(db);
    const r = await sendViaTwilioGuarded(h.admin, "u1", US, "hi", { purpose: "marketing", source: "t" }, h.deps);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "FRAUD_BLOCKED") {
      expect(r.block.code).toBe("VERIFICATION_REQUIRED");
      expect(r.block.retryable).toBe(false);
    } else throw new Error("expected FRAUD_BLOCKED");
    expect(h.calls).toHaveLength(0);
    expect(h.usage).toHaveLength(0);
  });

  it("SHADOW: would-block is logged but the SMS is sent", async () => {
    const { db, events } = makeDb(baseCtx({ outbound_unlocked: false, outbound_guard_mode: "shadow" }));
    const h = harness(db);
    const r = await sendViaTwilioGuarded(h.admin, "u1", US, "hi", { purpose: "service", source: "t" }, h.deps);
    expect(r.ok).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("PURPOSE: service/emergency survive a marketing-exhausted cap; emergency survives suspension; marketing does not", async () => {
    const { db } = makeDb(baseCtx({ plan: "starter" }));
    const h = harness(db);
    const cap = Math.floor(PLAN_LIMITS.starter.dailySms * MARKETING_CAP_SHARE);
    for (let i = 0; i < cap; i++) await sendViaTwilioGuarded(h.admin, "u1", US, "m", { fraudPurpose: "marketing", source: "t" }, h.deps);
    const before = h.calls.length;
    const m = await sendViaTwilioGuarded(h.admin, "u1", US, "m", { fraudPurpose: "marketing", source: "t" }, h.deps);
    expect(m.ok).toBe(false);
    expect(h.calls.length).toBe(before); // blocked marketing never reached Twilio
    const s = await sendViaTwilioGuarded(h.admin, "u1", US, "appointment confirmed", { purpose: "service", source: "t" }, h.deps);
    expect(s.ok).toBe(true);

    const susp = makeDb(baseCtx({ status: "suspended", kill_sms: true, outbound_unlocked: false }));
    const hs = harness(susp.db);
    expect((await sendViaTwilioGuarded(hs.admin, "u1", US, "dispatch", { purpose: "emergency", source: "t" }, hs.deps)).ok).toBe(true);
    expect((await sendViaTwilioGuarded(hs.admin, "u1", US, "promo", { purpose: "marketing", source: "t" }, hs.deps)).ok).toBe(false);
  });

  it("fraudPurpose overrides purpose for the guard only (quiet-hours purpose is untouched)", async () => {
    const { db, rpcLog } = makeDb(baseCtx(), { consent_mode: "enforce", has_consent: false, approval_required: false, campaign_status: "approved" });
    const h = harness(db);
    const r = await sendViaTwilioGuarded(h.admin, "u1", US, "hi", { purpose: "service", fraudPurpose: "marketing", source: "t" }, h.deps);
    expect(r.ok).toBe(false); // marketing consent gate applied
    expect(rpcLog.some((x) => x.fn === "fraud_marketing_checks")).toBe(true);
  });

  it("international destination is refused by the guard (enforce) before Twilio", async () => {
    const { db } = makeDb(baseCtx());
    const h = harness(db);
    const r = await sendViaTwilioGuarded(h.admin, "u1", UK, "hi", { source: "t" }, h.deps);
    expect(!r.ok && r.reason === "FRAUD_BLOCKED" && r.block.code).toBe("INTERNATIONAL_LOCKED");
    expect(h.calls).toHaveLength(0);
  });

  it("Twilio not configured: reports NOT_CONFIGURED and does not reserve guard budget", async () => {
    const { db, rpcLog } = makeDb(baseCtx());
    const h = harness(db);
    const r = await sendViaTwilioGuarded(h.admin, "u1", US, "hi", { source: "t" }, { ...h.deps, env: () => undefined });
    expect(!r.ok && r.reason).toBe("NOT_CONFIGURED");
    expect(rpcLog.some((x) => x.fn === "fraud_reserve")).toBe(false);
  });

  it("no retry loop: one blocked send = one guard evaluation = zero provider calls", async () => {
    const { db, rpcLog } = makeDb(baseCtx({ status: "suspended" }));
    const h = harness(db);
    const r = await sendViaTwilioGuarded(h.admin, "u1", US, "x", { source: "t" }, h.deps);
    expect(!r.ok && r.reason).toBe("FRAUD_BLOCKED");
    expect(rpcLog.filter((x) => x.fn === "fraud_guard_context")).toHaveLength(1);
    expect(h.calls).toHaveLength(0);
  });
});

describe("sendGuardedSms (customer SMS that bypassed the A2P funnel)", () => {
  it("ALLOWED / BLOCKED / SHADOW with a mocked provider", async () => {
    const sent: string[] = [];
    const deps = { sendSms: async (to: string) => { sent.push(to); return { ok: true }; } };

    const ok = makeDb(baseCtx());
    expect((await sendGuardedSms(ok.db as never, "u1", US, "b", { source: "t" }, deps)).ok).toBe(true);
    expect(sent).toEqual([US]);

    const blocked = makeDb(baseCtx({ status: "suspended" }));
    const r = await sendGuardedSms(blocked.db as never, "u1", US, "b", { source: "t" }, deps);
    expect(r.ok).toBe(false);
    expect(r.blocked?.code).toBe("ORG_SUSPENDED");
    expect(r.error).toBeTruthy();
    expect(sent).toHaveLength(1); // provider not called again

    const shadow = makeDb(baseCtx({ status: "suspended", outbound_guard_mode: "shadow" }));
    expect((await sendGuardedSms(shadow.db as never, "u1", US, "b", { source: "t" }, deps)).ok).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("a daily-cap block is retryable and exposes retryAt so callers reschedule instead of looping", async () => {
    const { db, usage } = makeDb(baseCtx({ plan: "free" }));
    usage.set(new Date().toISOString().slice(0, 10), { calls: 0, sms: 9999, cost: 0 }); // the guard uses the real clock here
    const r = await sendGuardedSms(db as never, "u1", US, "b", { source: "t" }, { sendSms: async () => ({ ok: true }) });
    expect(r.ok).toBe(false);
    expect(r.blocked?.code).toBe("DAILY_SMS");
    expect(r.blocked?.retryable).toBe(true);
    expect(Date.parse(r.blocked?.retryAt ?? "")).toBeGreaterThan(Date.now());
  });
});
