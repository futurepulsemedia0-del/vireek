import { describe, expect, it } from "vitest";
import {
  attachOutboundCall,
  blockedBody,
  buildBlocked,
  capDurationSeconds,
  gateCustomerOutbound,
  gateDestinationOnly,
  planMaxCallSeconds,
  releaseOutboundReservation,
  resolveInboundCap,
  secondsUntilNextUtcDay,
} from "./outboundGate.ts";
import { EMERGENCY_HANDOFF_DAILY_CEILING, MARKETING_CAP_SHARE, type FraudDb } from "./guard.ts";
import { NOW, UK, US, baseCtx, makeDb } from "./testDb.ts";
import { PLAN_LIMITS, callReservationCents } from "./planLimits.ts";

const smsReq = (over: Record<string, unknown> = {}) => ({ userId: "u1", kind: "sms" as const, to: US, purpose: "service" as const, source: "test", now: NOW, ...over });
const callReq = (over: Record<string, unknown> = {}) => ({ userId: "u1", kind: "call" as const, to: US, purpose: "service" as const, source: "test", now: NOW, ...over });

describe("gateCustomerOutbound: blocked / allowed / shadow", () => {
  it("allows a verified account and returns the plan duration cap", async () => {
    const { db } = makeDb(baseCtx({ plan: "professional" }));
    const g = await gateCustomerOutbound(db, callReq());
    expect(g.allowed).toBe(true);
    if (g.allowed) {
      expect(g.maxCallSeconds).toBe(PLAN_LIMITS.professional.maxCallSeconds);
      expect(g.e164).toBe(US);
      expect(g.eventRef).toBeTruthy();
    }
  });

  it("ENFORCE: unverified account is blocked with a typed, non-retryable result", async () => {
    const { db, events } = makeDb(baseCtx({ outbound_unlocked: false }));
    const g = await gateCustomerOutbound(db, smsReq({ purpose: "marketing" }));
    expect(g.allowed).toBe(false);
    if (!g.allowed) {
      expect(g.blocked.code).toBe("VERIFICATION_REQUIRED");
      expect(g.blocked.httpStatus).toBe(403);
      expect(g.blocked.retryable).toBe(false);
      expect(g.blocked.retryAfterSeconds).toBeNull();
      expect(g.blocked.retryAt).toBeNull();
    }
    expect(events.length).toBe(1);
    expect((events[0].detail as { shadow: boolean }).shadow).toBe(false);
  });

  it("SHADOW (default when the key is missing): same send is allowed, would-block is logged", async () => {
    const ctx = baseCtx({ outbound_unlocked: false });
    delete ctx.outbound_guard_mode; // migration not applied yet => shadow
    const { db, events } = makeDb(ctx);
    const g = await gateCustomerOutbound(db, smsReq({ purpose: "marketing" }));
    expect(g.allowed).toBe(true);
    if (g.allowed) {
      expect(g.shadowDenied).toBe("VERIFICATION_REQUIRED");
      expect(g.e164).toBe(US); // original number when the guard did not normalise it
    }
    expect(events.length).toBe(1);
    expect((events[0].detail as { shadow: boolean }).shadow).toBe(true);
  });

  it("SHADOW: outbound_guard_mode = 'shadow' allows, and the global enforce=false also forces shadow", async () => {
    const a = makeDb(baseCtx({ outbound_unlocked: false, outbound_guard_mode: "shadow" }));
    expect((await gateCustomerOutbound(a.db, smsReq())).allowed).toBe(true);
    const b = makeDb(baseCtx({ outbound_unlocked: false, outbound_guard_mode: "enforce", enforce: false }));
    expect((await gateCustomerOutbound(b.db, smsReq())).allowed).toBe(true);
  });

  it("the global enforce switch (OTP / inbound) is NOT changed by outbound_guard_mode", async () => {
    // rollout 'global' (the default used by OTP / inbound) still enforces when enforce=true, whatever outbound mode says
    const { guardOutbound } = await import("./guard.ts");
    const { db } = makeDb(baseCtx({ outbound_unlocked: false, outbound_guard_mode: "shadow" }));
    const r = await guardOutbound(db, { userId: "u1", kind: "sms", to: US, purpose: "service", source: "otp-like", now: NOW });
    expect(r.ok).toBe(false);
  });

  it("shadow still reserves budget for sends that WOULD be allowed (accounting stays correct)", async () => {
    const { db, usage } = makeDb(baseCtx({ outbound_guard_mode: "shadow" }));
    await gateCustomerOutbound(db, smsReq());
    expect(usage.get("2030-01-15")?.sms).toBe(1);
  });

  it("ENFORCE: kill switch, suspension and destination policy block with distinct codes", async () => {
    const kill = makeDb(baseCtx({ kill_sms: true }));
    const k = await gateCustomerOutbound(kill.db, smsReq());
    expect(!k.allowed && k.blocked.code).toBe("KILL_SWITCH");
    if (!k.allowed) { expect(k.blocked.retryable).toBe(true); expect(k.blocked.retryAfterSeconds).toBe(900); }

    const susp = makeDb(baseCtx({ status: "suspended" }));
    const s = await gateCustomerOutbound(susp.db, smsReq());
    expect(!s.allowed && s.blocked.code).toBe("ORG_SUSPENDED");
    if (!s.allowed) expect(s.blocked.retryable).toBe(false);

    const intl = makeDb(baseCtx());
    const i = await gateCustomerOutbound(intl.db, smsReq({ to: UK }));
    expect(!i.allowed && i.blocked.code).toBe("INTERNATIONAL_LOCKED");

    const premium = makeDb(baseCtx());
    const p = await gateCustomerOutbound(premium.db, callReq({ to: "+19005551234" }));
    expect(!p.allowed && p.blocked.code).toBe("PREMIUM_RATE");
  });

  it("fails closed with a retryable GUARD_UNAVAILABLE when the fraud store is down; never throws", async () => {
    const { db } = makeDb("error");
    const g = await gateCustomerOutbound(db, smsReq());
    expect(g.allowed).toBe(false);
    if (!g.allowed) { expect(g.blocked.code).toBe("GUARD_UNAVAILABLE"); expect(g.blocked.retryAfterSeconds).toBe(120); }

    const boom: FraudDb = { rpc: () => { throw new Error("boom"); }, from: () => { throw new Error("boom"); } };
    const g2 = await gateCustomerOutbound(boom, smsReq());
    expect(g2.allowed).toBe(false);
  });
});

describe("typed block result: retryAfter", () => {
  it("daily caps are retryable until the next UTC day; permanent blocks are not", async () => {
    const { db } = makeDb(baseCtx({ plan: "free", outbound_guard_mode: "enforce" }));
    const cap = Math.floor(PLAN_LIMITS.free.dailySms * MARKETING_CAP_SHARE); // 16 marketing sms/day on a mature free account
    for (let i = 0; i < cap; i++) expect((await gateCustomerOutbound(db, smsReq({ purpose: "marketing" }))).allowed).toBe(true);
    const over = await gateCustomerOutbound(db, smsReq({ purpose: "marketing" }));
    expect(over.allowed).toBe(false);
    if (!over.allowed) {
      expect(over.blocked.code).toBe("DAILY_SMS");
      expect(over.blocked.httpStatus).toBe(429);
      expect(over.blocked.retryable).toBe(true);
      expect(over.blocked.retryAfterSeconds).toBe(secondsUntilNextUtcDay(NOW));
      expect(over.blocked.retryAt).toBe(new Date(NOW.getTime() + secondsUntilNextUtcDay(NOW) * 1000).toISOString());
      expect(new Date(over.blocked.retryAt as string).getUTCDate()).toBe(16);
    }
  });

  it("secondsUntilNextUtcDay never returns less than 60 and handles the last second of the day", () => {
    expect(secondsUntilNextUtcDay(new Date("2030-01-15T23:59:59.000Z"))).toBe(60);
    expect(secondsUntilNextUtcDay(new Date("2030-01-15T00:00:00.000Z"))).toBe(86405);
  });

  it("blockedBody exposes a stable HTTP-friendly shape", () => {
    const b = buildBlocked("DAILY_COST", "Daily spend limit reached.", 429, NOW);
    expect(blockedBody(b)).toEqual({ error: "DAILY_COST", message: "Daily spend limit reached.", retryable: true, retry_after_seconds: secondsUntilNextUtcDay(NOW) });
  });
});

describe("purpose semantics: service and emergency are never starved by marketing", () => {
  it("a marketing blast that exhausts its share cannot block appointment confirmations (service)", async () => {
    const { db } = makeDb(baseCtx({ plan: "starter" }));
    const marketingCap = Math.floor(PLAN_LIMITS.starter.dailySms * MARKETING_CAP_SHARE);
    for (let i = 0; i < marketingCap; i++) await gateCustomerOutbound(db, smsReq({ purpose: "marketing" }));
    const m = await gateCustomerOutbound(db, smsReq({ purpose: "marketing" }));
    expect(!m.allowed && m.blocked.code).toBe("DAILY_SMS");
    // the reserved headroom is still there for service traffic
    const headroom = PLAN_LIMITS.starter.dailySms - marketingCap;
    expect(headroom).toBeGreaterThan(0);
    for (let i = 0; i < headroom; i++) expect((await gateCustomerOutbound(db, smsReq({ purpose: "service" }))).allowed).toBe(true);
    expect((await gateCustomerOutbound(db, smsReq({ purpose: "service" }))).allowed).toBe(false); // the FULL cap still holds
  });

  it("service traffic is not subject to the marketing gates (consent ledger / campaign approval)", async () => {
    const m = { consent_mode: "enforce", has_consent: false, approval_required: true, campaign_status: "pending" };
    const marketingDb = makeDb(baseCtx(), m);
    const blocked = await gateCustomerOutbound(marketingDb.db, smsReq({ purpose: "marketing" }));
    expect(!blocked.allowed && blocked.blocked.code).toBe("CAMPAIGN_APPROVAL_REQUIRED");
    if (!blocked.allowed) expect(blocked.blocked.retryable).toBe(true);

    const serviceDb = makeDb(baseCtx(), m);
    expect((await gateCustomerOutbound(serviceDb.db, smsReq({ purpose: "service" }))).allowed).toBe(true);
    expect(serviceDb.rpcLog.some((r) => r.fn === "fraud_marketing_checks")).toBe(false);
  });

  it("marketing consent is enforced (CONSENT_REQUIRED) and is permanent, not retryable", async () => {
    const { db } = makeDb(baseCtx(), { consent_mode: "enforce", has_consent: false, approval_required: false, campaign_status: "approved" });
    const g = await gateCustomerOutbound(db, callReq({ purpose: "marketing" }));
    expect(!g.allowed && g.blocked.code).toBe("CONSENT_REQUIRED");
    if (!g.allowed) expect(g.blocked.retryable).toBe(false);
  });

  it("EMERGENCY to a domestic number passes kill switches, suspension, missing verification and exhausted daily caps", async () => {
    const { db, usage } = makeDb(baseCtx({ kill_sms: true, kill_outbound_calls: true, status: "suspended", outbound_unlocked: false, plan: "free" }));
    usage.set("2030-01-15", { calls: 9999, sms: 9999, cost: 99999 }); // normal ledger is exhausted
    const sms = await gateCustomerOutbound(db, smsReq({ purpose: "emergency" }));
    const call = await gateCustomerOutbound(db, callReq({ purpose: "emergency" }));
    expect(sms.allowed).toBe(true);
    expect(call.allowed).toBe(true);
    if (sms.allowed && call.allowed) { expect(sms.emergency).toBe(true); expect(call.reservedCents).toBe(0); }
  });

  it("EMERGENCY still passes while the fraud store is unreachable (domestic only)", async () => {
    const { db } = makeDb("error");
    expect((await gateCustomerOutbound(db, smsReq({ purpose: "emergency" }))).allowed).toBe(true);
    expect((await gateCustomerOutbound(db, smsReq({ purpose: "emergency", to: UK }))).allowed).toBe(false);
  });

  it("EMERGENCY is not exempt from the destination policy, and has its own runaway ceiling", async () => {
    const { db, usage } = makeDb(baseCtx());
    const intl = await gateCustomerOutbound(db, smsReq({ purpose: "emergency", to: UK }));
    expect(!intl.allowed && intl.blocked.code).toBe("INTERNATIONAL_LOCKED");
    usage.set("handoff:2030-01-15", { calls: 0, sms: EMERGENCY_HANDOFF_DAILY_CEILING, cost: 0 });
    const ceiling = await gateCustomerOutbound(db, smsReq({ purpose: "emergency" }));
    expect(!ceiling.allowed && ceiling.blocked.code).toBe("DAILY_SMS");
  });

  it("throttled accounts keep service traffic flowing at a reduced rate but never touch emergency", async () => {
    const { db } = makeDb(baseCtx({ status: "throttled", plan: "starter" }));
    expect((await gateCustomerOutbound(db, smsReq({ purpose: "service" }))).allowed).toBe(true);
    const em = await gateCustomerOutbound(db, smsReq({ purpose: "emergency" }));
    expect(em.allowed).toBe(true);
  });
});

describe("duration cap", () => {
  it("every plan's maxCallSeconds is what the gate returns; an unknown plan is the most restrictive", async () => {
    for (const plan of Object.keys(PLAN_LIMITS) as (keyof typeof PLAN_LIMITS)[]) {
      const { db } = makeDb(baseCtx({ plan }));
      const g = await gateCustomerOutbound(db, callReq());
      expect(g.allowed && g.maxCallSeconds).toBe(PLAN_LIMITS[plan].maxCallSeconds);
    }
    const { db } = makeDb(baseCtx({ plan: "platinum-ultra" }));
    const g = await gateCustomerOutbound(db, callReq());
    expect(g.allowed && g.maxCallSeconds).toBe(PLAN_LIMITS.free.maxCallSeconds);
    expect(planMaxCallSeconds(undefined)).toBe(PLAN_LIMITS.free.maxCallSeconds);
    expect(planMaxCallSeconds("enterprise")).toBe(PLAN_LIMITS.enterprise.maxCallSeconds);
  });

  it("the reservation is priced with the same cap that is sent to the provider", async () => {
    const { db, callEvents } = makeDb(baseCtx({ plan: "starter" }));
    const g = await gateCustomerOutbound(db, callReq());
    expect(g.allowed && g.reservedCents).toBe(callReservationCents("domestic", PLAN_LIMITS.starter.maxCallSeconds));
    expect([...callEvents.values()][0].reserved).toBe(callReservationCents("domestic", PLAN_LIMITS.starter.maxCallSeconds));
  });

  it("capDurationSeconds: plan cap by default, lower of the two for normal legs, never lowers an emergency leg", () => {
    expect(capDurationSeconds(900)).toBe(900);
    expect(capDurationSeconds(900, 45)).toBe(45); // a 45 s test call stays 45 s
    expect(capDurationSeconds(300, 3600)).toBe(300); // existing higher limit on a normal leg is lowered to the plan
    expect(capDurationSeconds(300, 3600, { emergency: true })).toBe(3600); // transfer / emergency keeps its higher limit
    expect(capDurationSeconds(300, 60, { emergency: true })).toBe(300);
    expect(capDurationSeconds(5)).toBe(10); // provider minimum
    expect(capDurationSeconds(900, Number.NaN)).toBe(900);
    expect(capDurationSeconds(900, 0)).toBe(900);
  });

  it("resolveInboundCap: plan cap with the enforce flag; null (fail open) when the plan cannot be read", async () => {
    const ok = makeDb(baseCtx({ plan: "business", outbound_guard_mode: "enforce" }));
    expect(await resolveInboundCap(ok.db, "u1")).toEqual({ seconds: PLAN_LIMITS.business.maxCallSeconds, enforce: true });
    const shadow = makeDb(baseCtx({ plan: "business", outbound_guard_mode: "shadow" }));
    expect(await resolveInboundCap(shadow.db, "u1")).toEqual({ seconds: PLAN_LIMITS.business.maxCallSeconds, enforce: false });
    const down = makeDb("error");
    expect(await resolveInboundCap(down.db, "u1")).toBeNull();
  });
});

describe("reservation lifecycle: reserved cost is released", () => {
  it("a call the provider never placed gets its whole reservation back", async () => {
    const { db, usage, life } = makeDb(baseCtx({ plan: "starter" }));
    const g = await gateCustomerOutbound(db, callReq());
    expect(g.allowed).toBe(true);
    const reserved = g.allowed ? g.reservedCents : 0;
    expect(reserved).toBeGreaterThan(0);
    expect(usage.get("2030-01-15")?.cost).toBe(reserved);
    await releaseOutboundReservation(db, g);
    expect(usage.get("2030-01-15")?.cost).toBe(0);
    expect(life.cost).toBe(0);
  });

  it("attachOutboundCall links the provider call id to the reservation (so settleCall can find it)", async () => {
    const { db, callEvents, rpcLog } = makeDb(baseCtx());
    const g = await gateCustomerOutbound(db, callReq());
    await attachOutboundCall(db, g, "vapi-call-123");
    const attach = rpcLog.find((r) => r.fn === "fraud_call_attach");
    expect(attach?.args.p_external_id).toBe("vapi-call-123");
    expect([...callEvents.values()][0].external).toBe("vapi-call-123");
  });

  it("attach/release are no-ops for blocked sends, shadow denials and SMS (no event ref)", async () => {
    const blocked = makeDb(baseCtx({ status: "suspended" }));
    const g = await gateCustomerOutbound(blocked.db, callReq());
    await attachOutboundCall(blocked.db, g, "x");
    await releaseOutboundReservation(blocked.db, g);
    expect(blocked.rpcLog.some((r) => r.fn === "fraud_call_attach" || r.fn === "fraud_call_finish")).toBe(false);

    const sms = makeDb(baseCtx());
    const s = await gateCustomerOutbound(sms.db, smsReq());
    await releaseOutboundReservation(sms.db, s);
    expect(sms.rpcLog.some((r) => r.fn === "fraud_call_finish")).toBe(false);
  });
});

describe("gateDestinationOnly (owner-own numbers, bridge legs)", () => {
  it("ENFORCE blocks a premium number; SHADOW logs and allows; clean numbers always pass", async () => {
    const enforce = makeDb(baseCtx());
    const e = await gateDestinationOnly(enforce.db, "u1", "+19005551234", "voice-studio-test-call", NOW);
    expect(!e.allowed && e.blocked.code).toBe("PREMIUM_RATE");

    const shadow = makeDb(baseCtx({ outbound_guard_mode: "shadow" }));
    const s = await gateDestinationOnly(shadow.db, "u1", "+19005551234", "voice-studio-test-call", NOW);
    expect(s.allowed).toBe(true);
    expect(shadow.events.length).toBe(1);
    expect((shadow.events[0].detail as { shadow: boolean }).shadow).toBe(true);

    const ok = await gateDestinationOnly(enforce.db, "u1", US, "voice-studio-test-call", NOW);
    expect(ok.allowed && ok.maxCallSeconds).toBe(PLAN_LIMITS.free.maxCallSeconds);
    expect(ok.allowed && ok.reservedCents).toBe(0);
  });
});
