// supabase/functions/_shared/economics/tenantMargin.ts
//
// Per-tenant gross margin for a window. Pure. Revenue is the LIST price (catalog, or the grandfathered legacy price when
// the stored allowance proves the account is legacy) prorated to the window, plus overage minutes at that plan's rate.
// It is an ESTIMATE of billed revenue, never an invoice figure. Unknown plan / not billing / trial -> status != "ok", and
// only status "negative" raises an alert. Cost is the cost_ledger sum (micro-USD).

import { CATALOG_PLANS, LEGACY_PLANS, getCatalogPlan } from "../billing/pricingCatalog.ts";

export interface TenantMarginInput {
  accountId: string; plan: string | null; minutesIncluded: number | null; minutesUsed: number;
  costMicro: number; hasSubscription: boolean; subscriptionStatus: string | null; trialState: string | null; windowDays: number;
}
export type MarginStatus = "negative" | "thin" | "ok" | "trial" | "no_revenue_source" | "unknown_plan";
export interface TenantMargin {
  accountId: string; status: MarginStatus; revenueCents: number | null; costCents: number; marginCents: number | null;
  marginPct: number | null; overageMinutes: number; priceBasis: "catalog" | "legacy" | null;
}
export const THIN_MARGIN_PCT = 30;

function priceFor(plan: string | null, minutesIncluded: number | null) {
  if (!plan || minutesIncluded === null) return null;
  const cat = getCatalogPlan(plan);
  const legacy = (LEGACY_PLANS as Record<string, { monthlyCents: number; minutesIncluded: number; overageCentsPerMin: number | null }>)[plan];
  if (cat && !cat.quoted && cat.minutesIncluded === minutesIncluded) return { monthly: cat.monthlyCents, over: cat.overageCentsPerMin, basis: "catalog" as const };
  if (legacy && legacy.monthlyCents > 0 && legacy.minutesIncluded === minutesIncluded) return { monthly: legacy.monthlyCents, over: legacy.overageCentsPerMin ?? 0, basis: "legacy" as const };
  return null; // custom allowance / enterprise / free: we do not guess
}

export function computeTenantMargin(i: TenantMarginInput): TenantMargin {
  const costCents = Math.round(i.costMicro / 10_000); // micro-USD -> cents
  const base = { accountId: i.accountId, costCents, overageMinutes: 0, priceBasis: null as TenantMargin["priceBasis"] };
  if (i.trialState === "trialing") return { ...base, status: "trial", revenueCents: null, marginCents: null, marginPct: null };
  if (!i.hasSubscription) return { ...base, status: "no_revenue_source", revenueCents: null, marginCents: null, marginPct: null };
  const price = priceFor(i.plan, i.minutesIncluded);
  if (!price || !(i.windowDays > 0)) return { ...base, status: "unknown_plan", revenueCents: null, marginCents: null, marginPct: null };
  const months = i.windowDays / 30;
  // The included allowance scales with the window; overage is only what exceeds the prorated allowance.
  const overageMinutes = Math.max(0, i.minutesUsed - Math.round((i.minutesIncluded as number) * months));
  const revenueCents = Math.round(price.monthly * months + overageMinutes * price.over);
  const marginCents = revenueCents - costCents;
  const marginPct = revenueCents > 0 ? Math.round((marginCents / revenueCents) * 1000) / 10 : null;
  const status: MarginStatus = marginCents < 0 ? "negative" : marginPct !== null && marginPct < THIN_MARGIN_PCT ? "thin" : "ok";
  return { ...base, status, revenueCents, marginCents, marginPct, overageMinutes, priceBasis: price.basis };
}

/** Dedupe key: one alert per tenant per calendar month, so a sweep that runs hourly cannot spam. */
export const marginAlertKey = (accountId: string, monthIso: string) => `tenant_negative_margin:${accountId}:${monthIso.slice(0, 7)}`;
export const knownPlanIds = (): string[] => CATALOG_PLANS.map((p) => p.id);
