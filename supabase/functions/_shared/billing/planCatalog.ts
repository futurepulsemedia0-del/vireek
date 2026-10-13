// supabase/functions/_shared/billing/planCatalog.ts
//
// Server-side source of truth for which plans can be bought through Stripe,
// how they rank (upgrade vs downgrade) and how many minutes each includes.
// Pure functions only (no Deno globals, no I/O) so the same file is unit-tested
// by Vitest and imported by edge functions.
//
// Keep `minutesIncluded` in sync with src/lib/pricing.ts (PRICING_PLANS).

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

export const FREE_MINUTES_INCLUDED = 50;

export const PURCHASABLE_PLANS: readonly PlanDef[] = [
  { id: "starter", rank: 1, priceEnv: "STRIPE_PRICE_STARTER", minutesIncluded: 400 },
  { id: "professional", rank: 2, priceEnv: "STRIPE_PRICE_PROFESSIONAL", minutesIncluded: 1500 },
  { id: "business", rank: 3, priceEnv: "STRIPE_PRICE_BUSINESS", minutesIncluded: 4000 },
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
