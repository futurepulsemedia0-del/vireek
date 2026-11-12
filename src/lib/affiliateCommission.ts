/**
 * Affiliate / partner commission guardrails — pure (no I/O).
 *
 * The three limits below are PROPOSED DEFAULTS — UNVALIDATED. They have not been checked against
 * real unit economics, a signed partner agreement, or counsel. Change them here AND in
 * supabase/migrations/20290303000000_affiliate_commission_guardrails.sql (the SQL functions
 * affiliate_max_commission_pct / affiliate_max_months / affiliate_min_payout_cents);
 * affiliateCommission.test.ts fails if the two drift apart.
 */
import { PRICING_PLANS, parseOverageRate } from './pricing';
import { grossMargin } from './unitEconomics';
import { revenueFor, type PlanTerms } from './marginModel';

/** Proposed default, unvalidated: highest commission rate (percent of the commission base) without a staff override. */
export const AFFILIATE_MAX_COMMISSION_PCT = 20;
/** Proposed default, unvalidated: longest commission term (months) without a staff override. */
export const AFFILIATE_MAX_MONTHS = 12;
/** Proposed default, unvalidated: minimum approved balance (USD cents) before a payout may be marked paid. */
export const AFFILIATE_MIN_PAYOUT_CENTS = 5000;

/** Minimum length of the audit-logged reason a staff override needs (mirrors affiliate_override_min_reason_chars()). */
export const AFFILIATE_OVERRIDE_MIN_REASON_CHARS = 10;
/** Absolute sanity ceiling for a term even WITH an override (not a business rule; mirrors affiliate_months_sanity_ceiling()). */
export const AFFILIATE_MONTHS_SANITY_CEILING = 60;

export type CommissionTermsCheck =
  | { ok: true; override: boolean }
  | { ok: false; error: string };

/**
 * Client-side mirror of the database rule. The database is the authority; this exists for forms and tests.
 * Above either limit the terms are only valid with an explicit staff override reason.
 */
export function validateCommissionTerms(input: { ratePct: number; months: number; overrideReason?: string | null }): CommissionTermsCheck {
  const { ratePct, months } = input;
  if (!Number.isFinite(ratePct) || ratePct < 0 || ratePct > 100) return { ok: false, error: 'Commission rate must be between 0 and 100 percent.' };
  if (!Number.isInteger(months) || months < 1 || months > AFFILIATE_MONTHS_SANITY_CEILING) {
    return { ok: false, error: `Commission term must be a whole number of months between 1 and ${AFFILIATE_MONTHS_SANITY_CEILING}.` };
  }
  const override = ratePct > AFFILIATE_MAX_COMMISSION_PCT || months > AFFILIATE_MAX_MONTHS;
  if (!override) return { ok: true, override: false };
  const reason = (input.overrideReason ?? '').trim();
  if (reason.length < AFFILIATE_OVERRIDE_MIN_REASON_CHARS) {
    return {
      ok: false,
      error: `Rates above ${AFFILIATE_MAX_COMMISSION_PCT}% or terms above ${AFFILIATE_MAX_MONTHS} months need a staff override reason of at least ${AFFILIATE_OVERRIDE_MIN_REASON_CHARS} characters.`,
    };
  }
  return { ok: true, override: true };
}

/**
 * Commission base = net revenue actually collected, excluding tax and refunds (USD cents).
 * NOTE: nothing in the app records collected revenue per partner referral yet, so this is a specification
 * plus test, not wired into the database trigger (see the report: "does not exist yet").
 */
export function commissionBaseCents(input: { collectedCents: number; taxCents: number; refundedCents: number }): number {
  const { collectedCents, taxCents, refundedCents } = input;
  for (const v of [collectedCents, taxCents, refundedCents]) {
    if (!Number.isInteger(v) || v < 0) throw new RangeError('commission base inputs must be non-negative integer cents');
  }
  return Math.max(0, collectedCents - taxCents - refundedCents);
}

/** Commission in cents for a base amount; rounds half up like the SQL round(). */
export function commissionCents(baseCents: number, ratePct: number): number {
  if (!Number.isInteger(baseCents) || baseCents < 0) throw new RangeError('baseCents must be a non-negative integer');
  if (!Number.isFinite(ratePct) || ratePct < 0 || ratePct > 100) throw new RangeError('ratePct must be within 0..100');
  return Math.round((baseCents * ratePct) / 100);
}

/** True when the approved balance is large enough to be paid out. */
export function isPayoutEligible(approvedBalanceCents: number): boolean {
  return Number.isFinite(approvedBalanceCents) && approvedBalanceCents >= AFFILIATE_MIN_PAYOUT_CENTS;
}

export interface MarginAfterCommission {
  planId: string;
  minutes: number;
  revenueUsd: number;
  costUsd: number;
  commissionUsd: number;
  marginBeforeUsd: number;
  marginBeforePct: number | null;
  marginAfterUsd: number;
  marginAfterPct: number | null;
  /** True when commissionPct is above AFFILIATE_MAX_COMMISSION_PCT (a what-if outside the guardrail). */
  exceedsGuardrail: boolean;
  /** Commission % of revenue at which gross margin reaches exactly zero (= marginBeforePct); null when revenue is 0. */
  breakEvenCommissionPct: number | null;
}

function parseIncludedMinutes(label: string): number {
  const n = Number(label.replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Gross margin of one subscriber-month before and after paying a commission, from the plan LIST prices in
 * pricing.ts and the margin helpers in marginModel/unitEconomics.
 *
 * - utilisation: share of the plan's included minutes used (0.55 = 55%, 1 = 100%, >1 adds metered overage).
 * - commissionPct: percent of revenue (list price + overage) paid to the partner; refunds/tax are 0 in this model.
 * - costPerMinuteUsd is REQUIRED: this repo has no sourced provider rate, so none is invented here.
 *   Use measuredCostPerMinute() or provider_cost_rates in production code.
 * The result is an ESTIMATE; it never changes a price or a commission.
 */
export function marginAfterCommission(
  planId: string,
  utilisation: number,
  commissionPct: number,
  costPerMinuteUsd: number,
  fixedCostUsd = 0,
): MarginAfterCommission {
  const plan = PRICING_PLANS.find((p) => p.id === planId);
  if (!plan || plan.monthly === null || !(plan.monthly > 0)) throw new RangeError(`plan "${planId}" has no list price`);
  const includedMinutes = parseIncludedMinutes(plan.minutes);
  if (!(includedMinutes > 0)) throw new RangeError(`plan "${planId}" has no included-minutes allowance`);
  if (!Number.isFinite(utilisation) || utilisation < 0) throw new RangeError('utilisation must be a finite number >= 0');
  if (!Number.isFinite(commissionPct) || commissionPct < 0 || commissionPct > 100) throw new RangeError('commissionPct must be within 0..100');
  if (!Number.isFinite(costPerMinuteUsd) || costPerMinuteUsd < 0) throw new RangeError('costPerMinuteUsd must be a finite number >= 0');
  if (!Number.isFinite(fixedCostUsd) || fixedCostUsd < 0) throw new RangeError('fixedCostUsd must be a finite number >= 0');

  const terms: PlanTerms = { planId: plan.id, priceUsd: plan.monthly, includedMinutes, overageRateUsd: parseOverageRate(plan.overage) };
  const minutes = includedMinutes * utilisation;
  const revenueUsd = revenueFor(terms, minutes);
  const costUsd = minutes * costPerMinuteUsd + fixedCostUsd;
  const commissionUsd = (revenueUsd * commissionPct) / 100;
  const before = grossMargin(revenueUsd, costUsd);
  const after = grossMargin(revenueUsd, costUsd + commissionUsd);
  return {
    planId: plan.id,
    minutes,
    revenueUsd,
    costUsd,
    commissionUsd,
    marginBeforeUsd: before.marginUsd,
    marginBeforePct: before.marginPct,
    marginAfterUsd: after.marginUsd,
    marginAfterPct: after.marginPct,
    exceedsGuardrail: commissionPct > AFFILIATE_MAX_COMMISSION_PCT,
    breakEvenCommissionPct: before.marginPct,
  };
}
