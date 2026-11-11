// supabase/functions/_shared/billing/pricingCatalog.ts
//
// SINGLE SOURCE OF TRUTH for plan prices, included minutes, overage rates, seats,
// locations and trial rules. Pure data + pure functions: no imports, no Deno globals,
// no I/O, so edge functions, the React app (src/lib/pricing.ts) and Vitest all share it.
//
// Everything else that mentions a price or an allowance must DERIVE from this file
// (planCatalog.ts, fraud/planLimits.ts, value-scoreboard/engine.ts, src/lib/pricing.ts)
// or be covered by `collectPricingDrift()` in ./pricingInvariants.ts, which CI runs via
// `npm run pricing:check` and the Vitest suite.
//
// Money is integer USD cents. Never store prices as floats.

export type CatalogPlanId = "starter" | "professional" | "business" | "enterprise";
/** `free` is LEGACY-ONLY: it is no longer sold, but existing accounts may still carry it. */
export type LegacyOnlyPlanId = "free";
export type AnyPlanId = CatalogPlanId | LegacyOnlyPlanId;

export interface CatalogPlan {
  id: CatalogPlanId;
  rank: number;
  /** Monthly list price, cents. Enterprise: the "from" price (custom quote). */
  monthlyCents: number;
  /** Annual list price, cents (10 x monthly = two months free). null for enterprise (custom). */
  annualCents: number | null;
  /** True when monthlyCents is only a starting point and the real price is quoted. */
  quoted: boolean;
  /** Minutes included per billing month. Enterprise: committed minutes. */
  minutesIncluded: number;
  /** Per-minute overage once minutesIncluded is exhausted, cents. */
  overageCentsPerMin: number;
  /** null = unlimited. */
  seats: number | null;
  locations: number | null;
}

/** 14-day card-required trial that is capped at TRIAL_MINUTES. */
export const TRIAL = {
  days: 14,
  minutes: 60,
  cardRequired: true,
} as const;

export const CATALOG_PLANS: readonly CatalogPlan[] = [
  { id: "starter", rank: 1, monthlyCents: 9900, annualCents: 99000, quoted: false, minutesIncluded: 200, overageCentsPerMin: 25, seats: 2, locations: 1 },
  { id: "professional", rank: 2, monthlyCents: 24900, annualCents: 249000, quoted: false, minutesIncluded: 600, overageCentsPerMin: 25, seats: 5, locations: 1 },
  { id: "business", rank: 3, monthlyCents: 54900, annualCents: 549000, quoted: false, minutesIncluded: 1500, overageCentsPerMin: 25, seats: 15, locations: 3 },
  { id: "enterprise", rank: 4, monthlyCents: 179900, annualCents: null, quoted: true, minutesIncluded: 6000, overageCentsPerMin: 20, seats: null, locations: null },
];

/**
 * LEGACY (grandfathered) allowances. Accounts created before the pricing overhaul keep the
 * allowance stored in profiles.minutes_included; these figures exist ONLY so code that has to
 * recognise a legacy subscription (old Stripe price ids) never "upgrades" it to the new numbers.
 * Do not use them for anything customer-facing or for new sales.
 */
export const LEGACY_PLANS: Readonly<Record<AnyPlanId, { monthlyCents: number; minutesIncluded: number; overageCentsPerMin: number | null }>> = {
  free: { monthlyCents: 0, minutesIncluded: 50, overageCentsPerMin: null },
  starter: { monthlyCents: 7900, minutesIncluded: 400, overageCentsPerMin: 20 },
  professional: { monthlyCents: 19900, minutesIncluded: 1500, overageCentsPerMin: 15 },
  business: { monthlyCents: 39900, minutesIncluded: 4000, overageCentsPerMin: 12 },
  enterprise: { monthlyCents: 99900, minutesIncluded: 0, overageCentsPerMin: null },
};

export function getCatalogPlan(id: string | null | undefined): CatalogPlan | null {
  return CATALOG_PLANS.find((p) => p.id === id) ?? null;
}

export function formatUsdFromCents(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rem = Math.abs(cents % 100);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return rem === 0 ? `$${grouped}` : `$${grouped}.${String(rem).padStart(2, "0")}`;
}

export function formatMinutes(n: number): string {
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} min`;
}

/** 25 -> "$0.25/min after" */
export function formatOverage(centsPerMin: number): string {
  return `$${(centsPerMin / 100).toFixed(2)}/min after`;
}
