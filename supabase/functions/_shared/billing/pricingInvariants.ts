// supabase/functions/_shared/billing/pricingInvariants.ts
//
// DRIFT DETECTOR. Pure (no I/O): takes the values every module exposes and returns a list of
// human-readable problems. An empty array means every copy of a price / allowance agrees with
// ./pricingCatalog.ts. Used by:
//   - src/lib/pricingDrift.test.ts   (Vitest: fails if any copy drifts)
//   - scripts/check-pricing-drift.mjs (CI / local: also greps for stale customer-facing strings)

import { CATALOG_PLANS, LEGACY_PLANS, TRIAL, formatMinutes, formatOverage } from "./pricingCatalog.ts";

export interface DriftInputs {
  /** planCatalog.ts PURCHASABLE_PLANS */
  purchasable: ReadonlyArray<{ id: string; minutesIncluded: number }>;
  /** planCatalog.ts FREE_MINUTES_INCLUDED, TRIAL_MINUTES */
  freeMinutes: number;
  trialMinutes: number;
  /** fraud/planLimits.ts */
  fraudFreeMinutes: number;
  planPriceCents: Readonly<Record<string, number>>;
  /** value-scoreboard/engine.ts */
  scoreboardMonthlyCents: Readonly<Record<string, number>>;
  /** src/lib/pricing.ts PRICING_PLANS (display strings) */
  displayPlans: ReadonlyArray<{
    id: string;
    monthly: number | null;
    annual: number | null;
    startingAt?: number;
    minutes: string;
    overage: string | null;
  }>;
}

export function collectPricingDrift(i: DriftInputs): string[] {
  const out: string[] = [];
  const eq = (label: string, got: unknown, want: unknown) => {
    if (got !== want) out.push(`${label}: got ${String(got)}, catalog says ${String(want)}`);
  };

  // catalog self-consistency
  const ids = new Set<string>();
  for (const p of CATALOG_PLANS) {
    if (ids.has(p.id)) out.push(`catalog: duplicate plan ${p.id}`);
    ids.add(p.id);
    if (!Number.isInteger(p.monthlyCents) || p.monthlyCents <= 0) out.push(`catalog: ${p.id} monthlyCents must be a positive integer`);
    if (!Number.isInteger(p.minutesIncluded) || p.minutesIncluded <= 0) out.push(`catalog: ${p.id} minutesIncluded must be a positive integer`);
    if (!Number.isInteger(p.overageCentsPerMin) || p.overageCentsPerMin <= 0) out.push(`catalog: ${p.id} overageCentsPerMin must be a positive integer`);
    if (p.annualCents !== null && p.annualCents !== p.monthlyCents * 10) out.push(`catalog: ${p.id} annual must be 10 x monthly`);
  }
  const ranks = CATALOG_PLANS.map((p) => p.rank);
  if (ranks.some((r, idx) => idx > 0 && r <= ranks[idx - 1]!)) out.push("catalog: ranks must be strictly ascending");
  const mins = CATALOG_PLANS.map((p) => p.minutesIncluded);
  if (mins.some((m, idx) => idx > 0 && m <= mins[idx - 1]!)) out.push("catalog: minutes must increase with plan rank");
  if (TRIAL.minutes >= (CATALOG_PLANS[0]?.minutesIncluded ?? 0) * 1) {
    // Trial (60) must be below the cheapest plan's allowance so a trial can never out-give a paid plan.
    out.push("catalog: trial minutes must be below the smallest plan allowance");
  }

  // planCatalog.ts
  for (const p of CATALOG_PLANS.filter((c) => c.id !== "enterprise")) {
    const found = i.purchasable.find((x) => x.id === p.id);
    if (!found) out.push(`planCatalog: missing purchasable plan ${p.id}`);
    else eq(`planCatalog ${p.id} minutesIncluded`, found.minutesIncluded, p.minutesIncluded);
  }
  if (i.purchasable.some((x) => x.id === "enterprise")) out.push("planCatalog: enterprise must not be self-serve purchasable");
  eq("planCatalog FREE_MINUTES_INCLUDED (legacy)", i.freeMinutes, LEGACY_PLANS.free.minutesIncluded);
  eq("planCatalog TRIAL_MINUTES", i.trialMinutes, TRIAL.minutes);

  // fraud/planLimits.ts
  eq("planLimits FREE_MINUTES (legacy)", i.fraudFreeMinutes, LEGACY_PLANS.free.minutesIncluded);
  for (const p of CATALOG_PLANS.filter((c) => c.id !== "enterprise")) {
    eq(`planLimits PLAN_PRICE_CENTS.${p.id}`, i.planPriceCents[p.id], p.monthlyCents);
    eq(`scoreboard PLAN_MONTHLY_CENTS.${p.id}`, i.scoreboardMonthlyCents[p.id], p.monthlyCents);
  }

  // src/lib/pricing.ts display layer
  for (const p of CATALOG_PLANS) {
    const d = i.displayPlans.find((x) => x.id === p.id);
    if (!d) {
      out.push(`pricing.ts: missing display plan ${p.id}`);
      continue;
    }
    if (p.quoted) {
      eq(`pricing.ts ${p.id} startingAt`, d.startingAt, p.monthlyCents / 100);
      // Quoted plans are DIGIT-FREE on purpose: parsePlanMinutes()/parseOverageRate() must return null for them,
      // otherwise usage banners and plan-change maths would read a display string as a numeric allowance.
      if (/\d/.test(d.minutes)) out.push(`pricing.ts ${p.id} minutes must be digit-free (quoted plan), got "${d.minutes}"`);
      if (d.overage !== null && /\d/.test(d.overage)) out.push(`pricing.ts ${p.id} overage must be digit-free (quoted plan), got "${d.overage}"`);
      continue;
    }
    eq(`pricing.ts ${p.id} monthly`, d.monthly, p.monthlyCents / 100);
    eq(`pricing.ts ${p.id} annual`, d.annual, p.annualCents! / 100);
    eq(`pricing.ts ${p.id} minutes`, d.minutes, formatMinutes(p.minutesIncluded));
    eq(`pricing.ts ${p.id} overage`, d.overage, formatOverage(p.overageCentsPerMin));
  }
  if (i.displayPlans.some((x) => x.id === "free")) out.push("pricing.ts: the Free plan must not be a sold plan any more");
  return out;
}

/** Customer-facing strings that must never reappear (stale pre-overhaul claims). Used by the CI script. */
export const STALE_CLAIM_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\$79\b(?!\.\d)/, why: "old Starter price" },
  { re: /\$199\b(?!\.\d)/, why: "old Professional price" },
  { re: /\$399\b(?!\.\d)/, why: "old Business price" },
  { re: /\$999\b/, why: "old Enterprise starting price" },
  { re: /\b400 min(ute)?s?\b/i, why: "old Starter allowance" },
  { re: /\b4,000 min(ute)?s?\b/i, why: "old Business allowance" },
  { re: /no metering/i, why: "enterprise is now metered (committed minutes + overage)" },
  { re: /no credit card (required|needed)|no card required/i, why: "trial now requires a card" },
];
