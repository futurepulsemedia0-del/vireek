// supabase/functions/_shared/fraud/planLimits.ts
//
// Per-plan abuse limits, the worst-case cost model, and the "maximum possible loss per signup"
// calculation. Pure functions (no Deno globals, no I/O) so Vitest and edge functions share them.
//
// Keep FREE_MINUTES in sync with FREE_MINUTES_INCLUDED in ../billing/planCatalog.ts
// (a test asserts they match).
//
// COST MODEL = ASSUMPTIONS. The unit costs below are deliberately pessimistic ceilings, not invoices.
// Calibrate them against your Twilio / Vapi / ElevenLabs bills (see report: "Decisions for the owner").
// The loss BOUND is only as good as these numbers; the DB-enforced caps (cost cents) are what make the
// bound hold even when a single unit cost is mis-estimated.
//
// The unit-cost ceilings below are intentionally ABOVE the real blended cost. A measured blended cost of
// roughly $0.107/min (base case) is an ASSUMPTION-based estimate, NOT an invoice: re-measure it from real
// Twilio / Vapi / ElevenLabs bills before relying on it. Do not lower the ceilings on the strength of it.
//
// dailyCostCents rationale (ASSUMPTION, not an invoice): each paid-plan daily cap is about 5x the average
// DAILY cost of fully using the plan's included minutes at the 12c/min domestic ceiling. The 5x headroom
// absorbs bursty-but-legitimate days; anything beyond it is what the cap is meant to stop.
//
// maxNumbers is the plan BASE. The entitlements work (an `extra_numbers` column) does not exist in this
// snapshot (no migration or code references it), so it is NOT wired in. When it lands, the effective limit
// must be `PLAN_LIMITS[plan].maxNumbers + extra_numbers`. The same applies to `bonus_minutes` and
// `paid_overage_policy`: the overage-aware scaling of dailyCostCents is deliberately not implemented yet.

import type { CountryTier } from "./countries.ts";

export type PlanId = "free" | "starter" | "professional" | "business" | "enterprise";
export type Purpose = "marketing" | "service" | "emergency" | "otp";

export const FREE_MINUTES = 50;

/** Blended telephony + STT/TTS + voice-platform ceiling, cents per call minute, by destination tier. */
export const CALL_CENTS_PER_MIN: Readonly<Record<CountryTier, number>> = {
  domestic: 12, // matches DEFAULT_VOICE_COST_PER_MIN = 0.12 in src/lib/staffUsage.ts
  standard: 30,
  extended: 60,
  high_cost: 300,
};

/** One SMS (all segments of one message) ceiling, cents, by destination tier. */
export const SMS_CENTS: Readonly<Record<CountryTier, number>> = {
  domestic: 2,
  standard: 8,
  extended: 15,
  high_cost: 50,
};

export const NUMBER_RENTAL_CENTS_PER_MONTH = 115;

/**
 * Stolen-card / chargeback exposure. List prices mirror PRICING_PLANS in src/lib/pricing.ts (a test asserts they
 * match). The dispute fee is an ASSUMPTION (Stripe's standard card-dispute fee): confirm against your Stripe account.
 * Enterprise is custom-priced, so only the fee is modelled for it.
 */
export const PLAN_PRICE_CENTS: Readonly<Record<PlanId, number>> = {
  free: 0, starter: 7900, professional: 19900, business: 39900, enterprise: 0,
};
export const DISPUTE_FEE_CENTS = 1500;
export const VOICE_CLONE_CENTS = 500;

export interface PlanLimits {
  /** Outbound calls / SMS campaigns need verification before they unlock on this plan. */
  outboundRequiresVerification: boolean;
  dailyOutboundCalls: number;
  dailySms: number;
  /** Hard cap on worst-case reserved spend per UTC day (cents). */
  dailyCostCents: number;
  /** Hard cap on all discretionary spend over the account's life (cents); null = none (paid plans). */
  lifetimeCostCents: number | null;
  /** Enforced at the provider as a per-call duration limit; also used to price the reservation. */
  maxCallSeconds: number;
  /** SMS verification codes one account may trigger over its life (free) or per day (paid). */
  otpSendsPerPeriod: number;
  maxNumbers: number;
  allowVoiceClone: boolean;
}

export const PLAN_LIMITS: Readonly<Record<PlanId, PlanLimits>> = {
  free: {
    outboundRequiresVerification: true,
    dailyOutboundCalls: 10,
    dailySms: 20,
    dailyCostCents: 400,
    lifetimeCostCents: 800,
    maxCallSeconds: 300,
    otpSendsPerPeriod: 5,
    maxNumbers: 1,
    allowVoiceClone: false,
  },
  starter: {
    outboundRequiresVerification: true,
    dailyOutboundCalls: 100,
    dailySms: 200,
    dailyCostCents: 400,
    lifetimeCostCents: null,
    maxCallSeconds: 600,
    otpSendsPerPeriod: 20,
    maxNumbers: 1,
    allowVoiceClone: false,
  },
  professional: {
    outboundRequiresVerification: true,
    dailyOutboundCalls: 400,
    dailySms: 800,
    dailyCostCents: 1200,
    lifetimeCostCents: null,
    maxCallSeconds: 600,
    otpSendsPerPeriod: 40,
    maxNumbers: 2,
    allowVoiceClone: false,
  },
  business: {
    outboundRequiresVerification: true,
    dailyOutboundCalls: 1500,
    dailySms: 3000,
    dailyCostCents: 3000,
    lifetimeCostCents: null,
    maxCallSeconds: 900,
    otpSendsPerPeriod: 100,
    maxNumbers: 3,
    allowVoiceClone: false,
  },
  enterprise: {
    outboundRequiresVerification: true,
    dailyOutboundCalls: 5000,
    dailySms: 10000,
    dailyCostCents: 12000,
    lifetimeCostCents: null,
    maxCallSeconds: 900,
    otpSendsPerPeriod: 300,
    maxNumbers: 200, // custom: negotiated per contract
    allowVoiceClone: true,
  },
};

export function normalizePlan(plan: string | null | undefined): PlanId {
  return plan && plan in PLAN_LIMITS ? (plan as PlanId) : "free"; // unknown => most restrictive
}

/** New accounts get a fraction of their caps while they build history (stolen-card / farming ramp). */
export function rampFactor(accountAgeDays: number, plan: PlanId): number {
  if (plan === "enterprise") return 1;
  if (accountAgeDays < 1) return 0.1;
  if (accountAgeDays < 7) return 0.25;
  if (accountAgeDays < 30) return 0.5;
  return 1;
}

export interface EffectiveCaps {
  dailyOutboundCalls: number;
  dailySms: number;
  dailyCostCents: number;
  lifetimeCostCents: number | null;
  maxCallSeconds: number;
}

export function effectiveCaps(plan: PlanId, accountAgeDays: number): EffectiveCaps {
  const l = PLAN_LIMITS[plan];
  const f = rampFactor(accountAgeDays, plan);
  // Ramp floor: a ramped daily cost cap must never be smaller than ONE worst-case domestic call on this plan,
  // otherwise a legitimate new account could not place a single call for days (with the tightened caps, starter
  // would be locked out until day 7). The floor is bounded by the plan's own daily cap, so the worst-case loss
  // bound (which uses ramp factor 1) is unchanged, and the DB-enforced lifetime cap still binds on free.
  const oneCall = Math.min(l.dailyCostCents, callReservationCents("domestic", l.maxCallSeconds));
  return {
    dailyOutboundCalls: Math.floor(l.dailyOutboundCalls * f),
    dailySms: Math.floor(l.dailySms * f),
    dailyCostCents: Math.max(Math.floor(l.dailyCostCents * f), oneCall),
    lifetimeCostCents: l.lifetimeCostCents,
    maxCallSeconds: l.maxCallSeconds,
  };
}

/** Worst-case cost (cents) reserved BEFORE a call is placed. Every started minute is billed. */
export function callReservationCents(tier: CountryTier, maxCallSeconds: number): number {
  return Math.ceil(maxCallSeconds / 60) * CALL_CENTS_PER_MIN[tier];
}

export function smsReservationCents(tier: CountryTier): number {
  return SMS_CENTS[tier];
}

// ---------------------------------------------------------------------------
// Ledger rule. The SQL function fraud_reserve() implements EXACTLY this rule atomically; this pure
// version is what the tests use to prove the bound. Both are: "add the request if and only if it fits
// every cap, otherwise change nothing".
// ---------------------------------------------------------------------------

export interface LedgerState {
  dayCalls: number;
  daySms: number;
  dayCostCents: number;
  lifeCostCents: number;
}

export interface ReservationRequest {
  calls: number;
  sms: number;
  costCents: number;
}

export type ReservationDenial = "DAILY_CALLS" | "DAILY_SMS" | "DAILY_COST" | "LIFETIME_COST";

export function tryReserve(
  state: LedgerState,
  req: ReservationRequest,
  caps: EffectiveCaps,
): { ok: true; state: LedgerState } | { ok: false; reason: ReservationDenial } {
  if (state.dayCalls + req.calls > caps.dailyOutboundCalls) return { ok: false, reason: "DAILY_CALLS" };
  if (state.daySms + req.sms > caps.dailySms) return { ok: false, reason: "DAILY_SMS" };
  if (state.dayCostCents + req.costCents > caps.dailyCostCents) return { ok: false, reason: "DAILY_COST" };
  if (caps.lifetimeCostCents !== null && state.lifeCostCents + req.costCents > caps.lifetimeCostCents) {
    return { ok: false, reason: "LIFETIME_COST" };
  }
  return {
    ok: true,
    state: {
      dayCalls: state.dayCalls + req.calls,
      daySms: state.daySms + req.sms,
      dayCostCents: state.dayCostCents + req.costCents,
      lifeCostCents: state.lifeCostCents + req.costCents,
    },
  };
}

// ---------------------------------------------------------------------------
// Maximum possible loss per signup
// ---------------------------------------------------------------------------

export interface LossBreakdown {
  plan: PlanId;
  verified: boolean;
  horizonMonths: number;
  /** Included AI voice minutes (free tier: FREE_MINUTES) at the domestic ceiling. */
  includedMinutesCents: number;
  numberRentalCents: number;
  /** Signup / verification SMS codes at the most expensive destination tier the plan can reach. */
  otpCents: number;
  /** Outbound calls + SMS + clone, bounded by the DB-enforced cost caps. */
  discretionaryCents: number;
  /** Paid plans: refunded first payment + dispute fee if the card turns out to be stolen. */
  disputeCents: number;
  totalCents: number;
}

const WORST_ALLOWED_OTP_TIER: CountryTier = "standard"; // OTP SMS is only enabled for allowlisted countries

/**
 * Upper bound on what one signup on `plan` can cost us over `horizonMonths`, under the limits above.
 *
 * - Unverified accounts cannot place outbound calls/SMS or clone voices, so discretionary = 0.
 * - Verified FREE accounts are bounded by lifetimeCostCents (a hard, DB-enforced lifetime cap).
 * - Paid accounts are bounded by dailyCostCents x 30 x horizon at ramp factor 1 (the ramp only lowers it).
 */
export function maxLossPerSignupCents(plan: PlanId, opts: { verified: boolean; horizonMonths?: number }): LossBreakdown {
  const horizonMonths = opts.horizonMonths ?? 1;
  const l = PLAN_LIMITS[plan];
  const includedMinutes = plan === "free" ? FREE_MINUTES : 0; // paid-plan minutes are paid for
  const includedMinutesCents = includedMinutes * CALL_CENTS_PER_MIN.domestic;
  const numberRentalCents = l.maxNumbers === 0 ? 0 : (plan === "free" ? 1 : l.maxNumbers) * NUMBER_RENTAL_CENTS_PER_MONTH * horizonMonths;
  // Free: otpSendsPerPeriod is a LIFETIME budget. Paid: it is per day.
  const otpPeriods = plan === "free" ? 1 : 30 * horizonMonths;
  const otpCents = l.otpSendsPerPeriod * otpPeriods * SMS_CENTS[WORST_ALLOWED_OTP_TIER];

  let discretionaryCents = 0;
  if (opts.verified || !l.outboundRequiresVerification) {
    discretionaryCents =
      l.lifetimeCostCents !== null ? l.lifetimeCostCents : l.dailyCostCents * 30 * horizonMonths;
  }
  const disputeCents = plan === "free" ? 0 : PLAN_PRICE_CENTS[plan] + DISPUTE_FEE_CENTS;
  const totalCents = includedMinutesCents + numberRentalCents + otpCents + discretionaryCents + disputeCents;
  return { plan, verified: opts.verified, horizonMonths, includedMinutesCents, numberRentalCents, otpCents, discretionaryCents, disputeCents, totalCents };
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
