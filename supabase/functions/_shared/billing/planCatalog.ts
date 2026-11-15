// supabase/functions/_shared/billing/planCatalog.ts
//
// Server-side source of truth for which plans can be bought through Stripe,
// how they rank (upgrade vs downgrade) and how many minutes each includes.
// Pure functions only (no Deno globals, no I/O) so the same file is unit-tested
// by Vitest and imported by edge functions.
//
// Keep `minutesIncluded` and `overageCentsPerMinute` in sync with src/lib/pricing.ts (PRICING_PLANS)
// and FREE_MINUTES_INCLUDED with FREE_MINUTES in ../fraud/planLimits.ts. A Vitest test
// (src/lib/planConstants.agreement.test.ts) fails if they drift apart.

export type PurchasablePlanId = "starter" | "professional" | "business";
export type KnownPlanId = "free" | PurchasablePlanId | "enterprise";
export type PlanChangeKind = "new" | "same" | "upgrade" | "downgrade";

export interface PlanDef {
  id: PurchasablePlanId;
  rank: number;
  /** Name of the Supabase secret holding this plan's Stripe price id. */
  priceEnv: string;
  minutesIncluded: number;
}

export const FREE_MINUTES_INCLUDED = 60;

export const PURCHASABLE_PLANS: readonly PlanDef[] = [
  { id: "starter", rank: 1, priceEnv: "STRIPE_PRICE_STARTER", minutesIncluded: 200 },
  { id: "professional", rank: 2, priceEnv: "STRIPE_PRICE_PROFESSIONAL", minutesIncluded: 600 },
  { id: "business", rank: 3, priceEnv: "STRIPE_PRICE_BUSINESS", minutesIncluded: 1500 },
];

const RANKS: Record<KnownPlanId, number> = {
  free: 0,
  starter: 1,
  professional: 2,
  business: 3,
  enterprise: 4,
};

export function isPurchasablePlan(value: unknown): value is PurchasablePlanId {
  return typeof value === "string" && PURCHASABLE_PLANS.some((p) => p.id === value);
}

/** Rank of a plan, or -1 when the id is unknown. */
export function planRank(id: string | null | undefined): number {
  if (!id) return -1;
  return id in RANKS ? RANKS[id as KnownPlanId] : -1;
}

export function getPlanDef(id: PurchasablePlanId): PlanDef {
  const def = PURCHASABLE_PLANS.find((p) => p.id === id);
  if (!def) throw new Error(`Unknown plan: ${id}`);
  return def;
}

export function minutesForPlan(id: string | null | undefined): number | null {
  if (id === "free") return FREE_MINUTES_INCLUDED;
  const def = PURCHASABLE_PLANS.find((p) => p.id === id);
  return def ? def.minutesIncluded : null;
}

/**
 * Maps a Stripe price id back to a plan id using the configured secrets.
 * `readEnv` is injected so this stays testable (pass `Deno.env.get` in edge functions).
 */
export function planIdFromPriceId(
  priceId: string | null | undefined,
  readEnv: (key: string) => string | undefined,
): PurchasablePlanId | null {
  if (!priceId) return null;
  for (const plan of PURCHASABLE_PLANS) {
    if (readEnv(plan.priceEnv) === priceId) return plan.id;
  }
  return null;
}

export function classifyPlanChange(
  currentPlanId: string | null | undefined,
  targetPlanId: PurchasablePlanId,
  hasActiveSubscription: boolean,
): PlanChangeKind {
  if (!hasActiveSubscription) return "new";
  if (currentPlanId === targetPlanId) return "same";
  return planRank(targetPlanId) > planRank(currentPlanId) ? "upgrade" : "downgrade";
}
/**
 * Which `profiles.minutes_included` value a Stripe-driven profile sync may write; `undefined` = leave the column alone.
 *
 * Grandfathering: an existing customer keeps the allowance they already have. The catalog allowance is written only when
 *  - the plan actually changes (the customer chose new terms: upgrade, scheduled downgrade, portal change), or
 *  - the column is missing (NULL), to heal a broken row.
 * A routine `customer.subscription.updated` (renewal, payment retry, metadata edit) on an unchanged plan must NOT overwrite
 * it, and neither must a deliberately custom value such as 0 (unlimited) or a Results-Plan fair-use allowance.
 */
export function minutesToSyncOnPlanSync(input: {
  currentPlan: string | null | undefined;
  currentMinutes: number | null | undefined;
  targetPlan: string | null | undefined;
}): number | undefined {
  const catalogMinutes = minutesForPlan(input.targetPlan);
  if (catalogMinutes === null) return undefined; // enterprise / unknown: never overwritten by the sync
  if (input.currentPlan !== input.targetPlan) return catalogMinutes;
  return input.currentMinutes === null || input.currentMinutes === undefined ? catalogMinutes : undefined;
}

export interface PriceDrift {
  planId: PurchasablePlanId;
  expectedMinor: number;
  actualMinor: number;
}

/**
 * Compares a live Stripe price with the catalog list price. Only USD/month prices are comparable (list prices are USD
 * monthly); anything else returns null. A non-null result means the site shows one price and Stripe charges another.
 */
export function detectPriceDrift(
  planId: PurchasablePlanId,
  live: { amountMinor: number; currency: string; interval: string },
): PriceDrift | null {
  if (live.currency.toLowerCase() !== "usd" || live.interval !== "month") return null;
  const expectedMinor = getPlanDef(planId).monthlyPriceCents;
  return live.amountMinor === expectedMinor ? null : { planId, expectedMinor, actualMinor: live.amountMinor };
}
