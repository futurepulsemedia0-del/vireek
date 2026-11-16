// Pure, dependency-light logic for the churn-save offers inside
// supabase/functions/manage-subscription-cancellation. No Deno globals, no I/O,
// so it is unit-tested by Vitest (same pattern as cancellationLogic.ts).
//
// Cap enforcement itself lives in SQL (churn_save_check / churn_save_claim in
// 20290305000000_churn_save_offers.sql) so it is atomic. This file only:
//   * turns the existing staff health signals into a risk band (reuse of computeHealth)
//   * normalises DB rows into validated offer terms
//   * checks the LIVE Stripe state can accept an offer (pause / discount / downgrade)
//   * maps denial codes to safe customer-facing errors

import { computeHealth, type AccountSignals, type HealthBand } from "../staff/accountExplorer.ts";
import { canModifySubscription, offerTermsFromCoupon, type SubscriptionState } from "./cancellationLogic.ts";
import { isPurchasablePlan, minutesForPlan, planRank, type PurchasablePlanId } from "./planCatalog.ts";

export const SAVE_OFFER_KINDS = ["pause", "downgrade", "discount"] as const;
export type SaveOfferKind = (typeof SAVE_OFFER_KINDS)[number];

/** Hard ceilings, mirrored by CHECK constraints in the migration. */
export const MAX_DISCOUNT_PERCENT = 50;
export const MAX_DISCOUNT_MONTHS = 6;
export const MAX_PAUSE_MONTHS = 3;

export interface SaveOfferRow {
  id: string;
  kind: string;
  name: string;
  priority?: number;
  pause_months: number | null;
  downgrade_plan: string | null;
  discount_percent: number | string | null;
  discount_months: number | null;
}

export type SaveOfferTerms =
  | { kind: "pause"; months: number }
  | { kind: "downgrade"; plan: PurchasablePlanId }
  | { kind: "discount"; percentOff: number; months: number };

/** Validates a DB row into terms. Returns null for anything inconsistent (defence in depth over the CHECKs). */
export function termsOf(row: SaveOfferRow): SaveOfferTerms | null {
  if (row.kind === "pause") {
    const m = Number(row.pause_months);
    return Number.isInteger(m) && m >= 1 && m <= MAX_PAUSE_MONTHS ? { kind: "pause", months: m } : null;
  }
  if (row.kind === "downgrade") {
    return isPurchasablePlan(row.downgrade_plan) && row.downgrade_plan !== "business"
      ? { kind: "downgrade", plan: row.downgrade_plan }
      : null;
  }
  if (row.kind === "discount") {
    const p = Number(row.discount_percent);
    const m = Number(row.discount_months);
    const ok = Number.isFinite(p) && p > 0 && p <= MAX_DISCOUNT_PERCENT && Number.isInteger(m) && m >= 1 && m <= MAX_DISCOUNT_MONTHS;
    return ok ? { kind: "discount", percentOff: p, months: m } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Risk (reuses the staff health score; nothing is re-implemented)
// ---------------------------------------------------------------------------

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Maps one row of churn_save_account_signals() onto AccountSignals. */
export function signalsFromRow(row: unknown): AccountSignals | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.created_at !== "string") return null;
  const status = r.status === "suspended" || r.status === "canceled" ? r.status : "active";
  const sub = r.subscription_status === "past_due" || r.subscription_status === "suspended" ? r.subscription_status : "active";
  return {
    id: r.id,
    status,
    subscriptionStatus: sub,
    dunningStage: num(r.dunning_stage),
    onboardingCompleted: r.onboarding_completed === true,
    minutesUsed: num(r.minutes_used),
    minutesIncluded: num(r.minutes_included),
    createdAt: r.created_at,
    lastSignInAt: strOrNull(r.last_sign_in_at),
    lastCallAt: strOrNull(r.last_call_at),
    calls30d: num(r.calls_30d),
    callsPrev30d: num(r.calls_prev_30d),
    bookings30d: num(r.bookings_30d),
    teamCount: num(r.team_count),
    numbersCount: num(r.numbers_count),
  };
}

export interface ChurnRisk {
  band: HealthBand;
  score: number;
}

export function riskFromRow(row: unknown, now: Date = new Date()): ChurnRisk | null {
  const signals = signalsFromRow(row);
  if (!signals) return null;
  const health = computeHealth(signals, now);
  return { band: health.band, score: health.score };
}

// ---------------------------------------------------------------------------
// Live-Stripe feasibility
// ---------------------------------------------------------------------------

export interface LiveSubscription extends SubscriptionState {
  discountCount: number;
  hasSchedule: boolean;
}

export type Infeasible = "not_modifiable" | "already_discounted" | "plan_not_lower" | "plan_not_configured" | "schedule_exists" | "invalid_terms";

export function offerFeasibility(
  terms: SaveOfferTerms | null,
  sub: LiveSubscription,
  ctx: { currentPlan: string | null; targetPriceConfigured: boolean },
): Infeasible | null {
  if (!terms) return "invalid_terms";
  if (!canModifySubscription(sub)) return "not_modifiable";
  if (terms.kind === "discount" && sub.discountCount > 0) return "already_discounted";
  if (terms.kind === "downgrade") {
    if (planRank(terms.plan) >= planRank(ctx.currentPlan) || planRank(ctx.currentPlan) < 0) return "plan_not_lower";
    if (!ctx.targetPriceConfigured) return "plan_not_configured";
    if (sub.hasSchedule) return "schedule_exists";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Customer-facing view + errors
// ---------------------------------------------------------------------------

export interface SaveOfferView {
  id: string;
  kind: SaveOfferKind;
  name: string;
  pause_months?: number;
  discount_percent?: number;
  discount_months?: number;
  downgrade_plan?: string;
  downgrade_price_cents?: number | null;
  downgrade_currency?: string;
  downgrade_minutes?: number | null;
}

export function toOfferView(row: SaveOfferRow, extra: { priceCents?: number | null; currency?: string } = {}): SaveOfferView | null {
  const t = termsOf(row);
  if (!t) return null;
  const base = { id: row.id, kind: t.kind, name: row.name };
  if (t.kind === "pause") return { ...base, pause_months: t.months };
  if (t.kind === "discount") return { ...base, discount_percent: t.percentOff, discount_months: t.months };
  return {
    ...base,
    downgrade_plan: t.plan,
    downgrade_price_cents: extra.priceCents ?? null,
    downgrade_currency: extra.currency,
    downgrade_minutes: minutesForPlan(t.plan),
  };
}

export interface Denial {
  status: number;
  code: string;
  error: string;
}

/** Maps SQL / feasibility denial codes to a safe, non-leaking API error. */
export function denialFor(code: string): Denial {
  switch (code) {
    case "account_cap":
    case "cooldown":
      return { status: 409, code: "offer_used", error: "You've already used a save offer on this account recently." };
    case "not_found":
    case "disabled":
    case "not_started":
    case "ended":
    case "not_targeted":
    case "total_cap":
    case "not_modifiable":
    case "already_discounted":
    case "plan_not_lower":
    case "plan_not_configured":
    case "schedule_exists":
    case "invalid_terms":
    default:
      return { status: 409, code: "offer_unavailable", error: "That offer isn't available right now." };
  }
}

// ---------------------------------------------------------------------------
// Stripe helpers
// ---------------------------------------------------------------------------

/** Deterministic coupon id so identical terms always reuse ONE Stripe coupon. */
export function saveCouponId(percentOff: number, months: number): string {
  return `vireek_save_${String(percentOff).replace(".", "p")}_${months}m`;
}

/** True when an existing Stripe coupon carries exactly the configured terms (and is bounded). */
export function couponMatches(
  coupon: { valid?: boolean; percent_off?: number | null; duration?: string; duration_in_months?: number | null } | null,
  percentOff: number,
  months: number,
): boolean {
  const t = offerTermsFromCoupon(coupon);
  return !!t && coupon?.duration === "repeating" && t.percentOff === percentOff && t.months === months;
}

interface PhaseDiscountLike {
  discount?: string | { id: string } | null;
  coupon?: string | { id: string } | null;
}

const idOf = (ref: string | { id: string } | null | undefined): string | null => (!ref ? null : typeof ref === "string" ? ref : ref.id);

/** Keeps the customer's existing discounts when a downgrade schedule is created. */
export function carryDiscounts(phaseDiscounts: PhaseDiscountLike[] | null | undefined): { discount?: string; coupon?: string }[] {
  const out: { discount?: string; coupon?: string }[] = [];
  for (const d of phaseDiscounts ?? []) {
    const discountId = idOf(d.discount);
    const couponId = idOf(d.coupon);
    if (discountId) out.push({ discount: discountId });
    else if (couponId) out.push({ coupon: couponId });
  }
  return out;
}

/** Ledger action + audit action for an accepted offer kind. */
export function ledgerActionFor(kind: SaveOfferKind): {
  action: "paused" | "offer_accepted" | "downgrade_scheduled";
  audit: string;
} {
  if (kind === "pause") return { action: "paused", audit: "churn_save_pause_accepted" };
  if (kind === "downgrade") return { action: "downgrade_scheduled", audit: "churn_save_downgrade_accepted" };
  return { action: "offer_accepted", audit: "churn_save_discount_accepted" };
}
