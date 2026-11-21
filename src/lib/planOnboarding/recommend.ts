// src/lib/planOnboarding/recommend.ts
//
// Right-size helper: 3 optional answers -> a suggested plan, computed from PRICING_PLANS (no duplicated plan data).
// PRICING_PLANS stores limits as display strings ("1,500 min", "Up to 3 locations"); they are parsed here and a unit
// test fails if a plan's strings ever stop parsing, so the helper can never silently drift from the pricing table.
//
// Assumptions (shown to the user, never hidden):
//   - minutes per call: ASSUMED_MINUTES_PER_CALL (same default as the value scoreboard, src/lib/valueScoreboard.ts) [VERIFY]
//   - seats needed = technicians + 1 (the owner). Office staff are not asked about, so this is a floor.
// The suggestion only badges a card. It never hides, disables or re-orders other plans.

import { PRICING_PLANS, parseOverageRate, type PricingPlan } from '@/lib/pricing';
import type { SelectablePlanId } from './intent';

export const ASSUMED_MINUTES_PER_CALL = 3;
const MAX_INPUT = 10_000_000;

/** First whole number in a display string: "1,500 min" -> 1500, "Up to 3 locations" -> 3, "Custom seats" -> null. */
export function parseCount(text: string | null | undefined): number | null {
  const m = (text ?? '').match(/\d[\d,]*/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export interface PlanLimits {
  id: SelectablePlanId;
  minutes: number | null;
  seats: number | null;
  locations: number | null;
  /** $/min after the included minutes; null = none. */
  overageRate: number | null;
  monthly: number | null;
  /** Enterprise: custom price / limits, handled by sales. */
  custom: boolean;
  startingAt: number | null;
}

export function planLimits(plan: PricingPlan): PlanLimits {
  return {
    id: plan.id as SelectablePlanId,
    minutes: parseCount(plan.minutes),
    seats: parseCount(plan.seats),
    locations: parseCount(plan.locations),
    overageRate: parseOverageRate(plan.overage),
    monthly: plan.monthly,
    custom: plan.monthly === null,
    startingAt: plan.startingAt ?? null,
  };
}

export const SELF_SERVE_LIMITS: readonly PlanLimits[] = PRICING_PLANS.filter((p) => p.id !== 'free')
  .map(planLimits)
  .filter((l) => !l.custom);

export interface SizeAnswers {
  monthlyCalls?: number | null;
  technicians?: number | null;
  locations?: number | null;
}

export type ReasonCode = 'fits_all' | 'seats' | 'locations' | 'minutes_overage' | 'beyond_self_serve' | 'cheaper_as_enterprise';

export interface Recommendation {
  planId: SelectablePlanId;
  needs: { minutes: number | null; seats: number | null; locations: number | null };
  /** Estimated monthly cost on the suggested plan (price + overage); null for Enterprise. */
  estimatedMonthly: number | null;
  overageMinutes: number;
  reasons: ReasonCode[];
}

function clean(n: number | null | undefined): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.floor(n), MAX_INPUT);
}

export function hasAnyAnswer(a: SizeAnswers): boolean {
  return clean(a.monthlyCalls) !== null || clean(a.technicians) !== null || clean(a.locations) !== null;
}

export function recommendPlan(
  answers: SizeAnswers,
  limits: readonly PlanLimits[] = SELF_SERVE_LIMITS,
  enterprise: SelectablePlanId | null = (PRICING_PLANS.find((p) => p.monthly === null)?.id as SelectablePlanId | undefined) ?? null,
  enterpriseFrom: number | null = PRICING_PLANS.find((p) => p.monthly === null)?.startingAt ?? null,
): Recommendation | null {
  if (!hasAnyAnswer(answers)) return null;

  const calls = clean(answers.monthlyCalls);
  const techs = clean(answers.technicians);
  const locs = clean(answers.locations);
  const needs = {
    minutes: calls === null ? null : calls * ASSUMED_MINUTES_PER_CALL,
    seats: techs === null ? null : techs + 1,
    locations: locs === null ? null : Math.max(1, locs),
  };

  const feasible = limits.filter(
    (l) => (needs.seats === null || (l.seats !== null && l.seats >= needs.seats)) &&
      (needs.locations === null || (l.locations !== null && l.locations >= needs.locations)),
  );

  const toEnterprise = (reason: ReasonCode): Recommendation | null =>
    enterprise ? { planId: enterprise, needs, estimatedMonthly: null, overageMinutes: 0, reasons: [reason] } : null;

  if (feasible.length === 0) return toEnterprise('beyond_self_serve');

  type Scored = { l: PlanLimits; cost: number; over: number };
  const scored: Scored[] = [];
  for (const l of feasible) {
    if (l.monthly === null) continue;
    const over = needs.minutes !== null && l.minutes !== null ? Math.max(0, needs.minutes - l.minutes) : 0;
    if (over > 0 && l.overageRate === null) continue; // cannot absorb the minutes at all
    scored.push({ l, cost: l.monthly + over * (l.overageRate ?? 0), over });
  }
  if (scored.length === 0) return toEnterprise('beyond_self_serve');

  scored.sort((a, b) => a.cost - b.cost || (a.l.monthly ?? 0) - (b.l.monthly ?? 0));
  const best = scored[0];

  if (enterprise && enterpriseFrom !== null && best.cost >= enterpriseFrom) return toEnterprise('cheaper_as_enterprise');

  const reasons: ReasonCode[] = [];
  const smallest = limits.reduce((m, l) => (l.monthly !== null && (m === null || l.monthly < (m.monthly ?? Infinity)) ? l : m), null as PlanLimits | null);
  if (needs.seats !== null && smallest && best.l.seats !== null && smallest.seats !== null && needs.seats > smallest.seats) reasons.push('seats');
  if (needs.locations !== null && smallest && best.l.locations !== null && smallest.locations !== null && needs.locations > smallest.locations) reasons.push('locations');
  if (best.over > 0) reasons.push('minutes_overage');
  if (reasons.length === 0) reasons.push('fits_all');

  return { planId: best.l.id, needs, estimatedMonthly: best.cost, overageMinutes: best.over, reasons };
}
