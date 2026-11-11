import { describe, it, expect } from "vitest";
import {
  CALL_CENTS_PER_MIN,
  PLAN_LIMITS,
  callReservationCents,
  effectiveCaps,
  maxLossPerSignupCents,
  tryReserve,
  type LedgerState,
  type PlanId,
} from "./planLimits";
import { guardOutbound, type FraudDb } from "./guard";

const PLANS: PlanId[] = ["free", "starter", "professional", "business", "enterprise"];

describe("PLAN_LIMITS (new plan alignment)", () => {
  it("keeps outboundRequiresVerification true on every plan", () => {
    for (const p of PLANS) expect(PLAN_LIMITS[p].outboundRequiresVerification).toBe(true);
  });

  it("free (Trial) values", () => {
    expect(PLAN_LIMITS.free).toMatchObject({
      dailyOutboundCalls: 10, dailySms: 20, maxCallSeconds: 300, otpSendsPerPeriod: 5,
      allowVoiceClone: false, maxNumbers: 1, lifetimeCostCents: 800, dailyCostCents: 400,
    });
  });

  it("paid plan values", () => {
    expect(PLAN_LIMITS.starter).toMatchObject({ maxCallSeconds: 600, maxNumbers: 1, allowVoiceClone: false, dailyCostCents: 400 });
    expect(PLAN_LIMITS.professional).toMatchObject({ maxCallSeconds: 600, maxNumbers: 2, allowVoiceClone: false, dailyCostCents: 1200 });
    expect(PLAN_LIMITS.business).toMatchObject({ maxCallSeconds: 900, maxNumbers: 3, allowVoiceClone: false, dailyCostCents: 3000 });
    expect(PLAN_LIMITS.enterprise).toMatchObject({ maxCallSeconds: 900, maxNumbers: 200, allowVoiceClone: true, dailyCostCents: 12000 });
  });

  it("fields that were not part of the change are untouched", () => {
    expect(PLAN_LIMITS.starter).toMatchObject({ dailyOutboundCalls: 100, dailySms: 200, otpSendsPerPeriod: 20, lifetimeCostCents: null });
    expect(PLAN_LIMITS.professional).toMatchObject({ dailyOutboundCalls: 400, dailySms: 800, otpSendsPerPeriod: 40, lifetimeCostCents: null });
    expect(PLAN_LIMITS.business).toMatchObject({ dailyOutboundCalls: 1500, dailySms: 3000, otpSendsPerPeriod: 100, lifetimeCostCents: null });
    expect(PLAN_LIMITS.enterprise).toMatchObject({ dailyOutboundCalls: 5000, dailySms: 10000, otpSendsPerPeriod: 300, lifetimeCostCents: null });
  });

  it("only enterprise may clone voices", () => {
    expect(PLANS.filter((p) => PLAN_LIMITS[p].allowVoiceClone)).toEqual(["enterprise"]);
  });
});

describe("ramp floor keeps new accounts usable without raising the bound", () => {
  it("every plan can afford at least one domestic call at every account age", () => {
    for (const p of PLANS) {
      for (const age of [0, 1, 3, 7, 15, 30, 365]) {
        const c = effectiveCaps(p, age);
        expect(c.dailyCostCents).toBeGreaterThan(callReservationCents("domestic", c.maxCallSeconds) - 1);
      }
    }
  });

  it("the ramped daily cap never exceeds the plan's own cap", () => {
    for (const p of PLANS) {
      for (const age of [0, 1, 7, 30, 365]) {
        expect(effectiveCaps(p, age).dailyCostCents).toBeLessThanOrEqual(PLAN_LIMITS[p].dailyCostCents);
      }
    }
  });

  it("day-0 values: floor applies only where 10% of the cap is below one call", () => {
    expect(effectiveCaps("free", 0).dailyCostCents).toBe(60);
    expect(effectiveCaps("starter", 0).dailyCostCents).toBe(120);
    expect(effectiveCaps("professional", 0).dailyCostCents).toBe(120);
    expect(effectiveCaps("business", 0).dailyCostCents).toBe(300);
    expect(effectiveCaps("enterprise", 0).dailyCostCents).toBe(12000);
  });

  it("mature accounts are unaffected", () => {
    for (const p of PLANS) expect(effectiveCaps(p, 365).dailyCostCents).toBe(PLAN_LIMITS[p].dailyCostCents);
  });
});

describe("free-plan lifetime cap binds, not the estimate", () => {
  it("800c covers 60 min x 12c (720c) plus SMS headroom", () => {
    const sixtyMinutes = 60 * CALL_CENTS_PER_MIN.domestic;
    expect(sixtyMinutes).toBe(720);
    expect(PLAN_LIMITS.free.lifetimeCostCents!).toBeGreaterThan(sixtyMinutes);
  });

  it("verified free discretionary loss equals the DB lifetime cap", () => {
    const loss = maxLossPerSignupCents("free", { verified: true });
    expect(loss.discretionaryCents).toBe(PLAN_LIMITS.free.lifetimeCostCents);
  });

  it("no sequence of allowed reservations exceeds the lifetime cap", () => {
    const caps = effectiveCaps("free", 365); // ramp 1: most permissive
    let state: LedgerState = { dayCalls: 0, daySms: 0, dayCostCents: 0, lifeCostCents: 0 };
    const callCost = callReservationCents("domestic", caps.maxCallSeconds);
    for (let i = 0; i < 1000; i++) {
      const r = tryReserve(state, { calls: 1, sms: 0, costCents: callCost }, caps);
      if (!r.ok) { state = { ...state, dayCalls: 0, dayCostCents: 0 }; continue; } // new UTC day
      state = r.state;
    }
    expect(state.lifeCostCents).toBeLessThanOrEqual(PLAN_LIMITS.free.lifetimeCostCents!);
  });
});

describe("recomputed maximum possible loss per signup (30 days)", () => {
  const expected: Record<PlanId, { unverified: number; verified: number; discretionary: number }> = {
    free: { unverified: 755, verified: 1555, discretionary: 800 },
    starter: { unverified: 14315, verified: 26315, discretionary: 12000 },
    professional: { unverified: 31230, verified: 67230, discretionary: 36000 },
    business: { unverified: 65745, verified: 155745, discretionary: 90000 },
    enterprise: { unverified: 96500, verified: 456500, discretionary: 360000 },
  };
  for (const p of PLANS) {
    it(`${p}`, () => {
      expect(maxLossPerSignupCents(p, { verified: false }).totalCents).toBe(expected[p].unverified);
      const v = maxLossPerSignupCents(p, { verified: true });
      expect(v.totalCents).toBe(expected[p].verified);
      expect(v.discretionaryCents).toBe(expected[p].discretionary);
    });
  }

  it("every plan's worst case is lower than or equal to before for paid plans (tightened)", () => {
    const old: Record<string, number> = { starter: 59545, professional: 182150, business: 521150, enterprise: 1596500 };
    for (const p of ["starter", "professional", "business", "enterprise"] as const) {
      expect(maxLossPerSignupCents(p, { verified: true }).totalCents).toBeLessThan(old[p]);
    }
  });
});

describe("emergency-classified traffic is never blocked by these caps", () => {
  type Ctx = Record<string, unknown>;

  function fakeDb(ctx: Ctx | null, reserveResult: string | null = null) {
    const calls: Array<{ fn: string; args?: Record<string, unknown> }> = [];
    const db: FraudDb = {
      rpc(fn, args) {
        calls.push({ fn, args });
        if (fn === "fraud_guard_context") {
          return Promise.resolve(ctx ? { data: ctx, error: null } : { data: null, error: { message: "down" } });
        }
        if (fn === "fraud_reserve") return Promise.resolve({ data: reserveResult, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      from() {
        return { insert: () => Promise.resolve({ error: null }) };
      },
    };
    return { db, calls };
  }

  const hostile = (plan: string): Ctx => ({
    enforce: true, kill_outbound_calls: true, kill_sms: true, kill_international: true,
    status: "suspended", status_reason: "test", outbound_unlocked: false, international_unlocked: false,
    voice_clone_unlocked: false, allowed_countries: [], plan, account_age_days: 0,
  });

  for (const plan of PLANS) {
    it(`${plan}: emergency call + sms to a domestic number pass despite kill switch, suspension, no verification, day-0 ramp`, async () => {
      for (const kind of ["call", "sms"] as const) {
        const { db, calls } = fakeDb(hostile(plan));
        const r = await guardOutbound(db, { userId: "u1", kind, to: "+12025550123", purpose: "emergency", source: "test" });
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.emergency).toBe(true);
          expect(r.reservedCents).toBe(0); // nothing counted against dailyCostCents / lifetimeCostCents
        }
        // the only ledger touch is the separate hand-off bucket, with a zero cost
        for (const c of calls.filter((x) => x.fn === "fraud_reserve")) {
          expect(String(c.args?.p_day)).toMatch(/^handoff:/);
          expect(c.args?.p_cost).toBe(0);
        }
      }
    });
  }

  it("911 passes with no ledger interaction at all", async () => {
    const { db, calls } = fakeDb(hostile("free"));
    const r = await guardOutbound(db, { userId: "u1", kind: "call", to: "911", purpose: "emergency", source: "test" });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.fn === "fraud_reserve")).toBe(false);
  });

  it("a fraud-store outage does not block a domestic emergency hand-off", async () => {
    const { db } = fakeDb(null);
    const r = await guardOutbound(db, { userId: "u1", kind: "call", to: "+12025550123", purpose: "emergency", source: "test" });
    expect(r.ok).toBe(true);
  });

  it("a ledger error in the hand-off bucket does not block it", async () => {
    const { db } = fakeDb({ ...hostile("starter"), status: "active", kill_outbound_calls: false });
    db.rpc = () => Promise.reject(new Error("ledger down")) as never;
    const r = await guardOutbound(db, { userId: "u1", kind: "sms", to: "+12025550123", purpose: "emergency", source: "test" });
    expect(r.ok).toBe(true);
  });

  it("control: the same account is still capped for non-emergency traffic", async () => {
    const { db } = fakeDb({ ...hostile("starter"), status: "active", kill_outbound_calls: false, outbound_unlocked: true, account_age_days: 400 }, "DAILY_COST");
    const r = await guardOutbound(db, { userId: "u1", kind: "call", to: "+12025550123", purpose: "service", source: "test" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DAILY_COST");
  });
});
