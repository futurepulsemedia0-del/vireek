/**
 * Margin model — pure (no I/O). Every output is an ESTIMATE built from the inputs given
 * (historical usage + cost per minute + plan terms). Recommendations only; never changes prices.
 */
import { percentile, grossMargin } from './unitEconomics';

export interface PlanTerms { planId: string; priceUsd: number; includedMinutes: number; overageRateUsd: number | null }

export function revenueFor(plan: PlanTerms, minutes: number): number {
  const over = Math.max(0, minutes - plan.includedMinutes);
  return plan.priceUsd + (plan.overageRateUsd ? over * plan.overageRateUsd : 0);
}

export interface MarginPoint { minutes: number; revenueUsd: number; costUsd: number; marginUsd: number; marginPct: number | null }

export function marginAt(plan: PlanTerms, minutes: number, costPerMinuteUsd: number, fixedCostUsd = 0): MarginPoint {
  const revenueUsd = revenueFor(plan, minutes);
  const costUsd = minutes * costPerMinuteUsd + fixedCostUsd;
  const g = grossMargin(revenueUsd, costUsd);
  return { minutes, revenueUsd, costUsd, marginUsd: g.marginUsd, marginPct: g.marginPct };
}

export interface Projection {
  p10: MarginPoint | null; p50: MarginPoint | null; p90: MarginPoint | null;
  negativeShare: number | null; sampleSize: number;
}

/** Projects margin at historical usage percentiles. Empty history -> nulls (never invented usage). */
export function projectPlan(plan: PlanTerms, usageMinutes: number[], costPerMinuteUsd: number, fixedCostUsd = 0): Projection {
  const at = (p: number) => { const m = percentile(usageMinutes, p); return m === null ? null : marginAt(plan, m, costPerMinuteUsd, fixedCostUsd); };
  const n = usageMinutes.filter(Number.isFinite).length;
  const neg = n === 0 ? null : usageMinutes.filter((m) => Number.isFinite(m) && marginAt(plan, m, costPerMinuteUsd, fixedCostUsd).marginUsd < 0).length / n;
  return { p10: at(10), p50: at(50), p90: at(90), negativeShare: neg, sampleSize: n };
}

/** Minutes at which margin first turns negative; null = never negative. */
export function breakEvenMinutes(plan: PlanTerms, costPerMinuteUsd: number, fixedCostUsd = 0): number | null {
  if (!(costPerMinuteUsd > 0)) return null;
  const inc = plan.includedMinutes;
  const ov = plan.overageRateUsd ?? 0;
  const m1 = (plan.priceUsd - fixedCostUsd) / costPerMinuteUsd;
  if (m1 < inc) return Math.max(0, m1);
  if (ov >= costPerMinuteUsd) return null;
  return Math.max(0, (plan.priceUsd - fixedCostUsd - inc * ov) / (costPerMinuteUsd - ov));
}

export interface SensitivityRow { changePct: number; costPerMinuteUsd: number; p50MarginPct: number | null; p90MarginPct: number | null; breakEvenMinutes: number | null }

/** How margin moves if the provider cost per minute changes by each given percent. */
export function rateSensitivity(plan: PlanTerms, usageMinutes: number[], baseCostPerMinuteUsd: number, changesPct: number[], fixedCostUsd = 0): SensitivityRow[] {
  return changesPct.map((c) => {
    const cpm = baseCostPerMinuteUsd * (1 + c / 100);
    const pr = projectPlan(plan, usageMinutes, cpm, fixedCostUsd);
    return { changePct: c, costPerMinuteUsd: cpm, p50MarginPct: pr.p50?.marginPct ?? null, p90MarginPct: pr.p90?.marginPct ?? null, breakEvenMinutes: breakEvenMinutes(plan, cpm, fixedCostUsd) };
  });
}

export interface EnterpriseQuote { costToServeUsd: number; priceFloorUsd: number; floorPerMinuteUsd: number | null }

/** Price floor so that margin >= targetMarginPct. targetMarginPct must be in [0,100). */
export function enterpriseQuote(input: { minutesPerMonth: number; costPerMinuteUsd: number; fixedCostUsd: number; targetMarginPct: number }): EnterpriseQuote {
  const { minutesPerMonth, costPerMinuteUsd, fixedCostUsd, targetMarginPct } = input;
  if (![minutesPerMonth, costPerMinuteUsd, fixedCostUsd, targetMarginPct].every(Number.isFinite) || minutesPerMonth < 0 || costPerMinuteUsd < 0 || fixedCostUsd < 0) throw new RangeError('invalid quote input');
  if (targetMarginPct < 0 || targetMarginPct >= 100) throw new RangeError('targetMarginPct must be in [0,100)');
  const costToServeUsd = minutesPerMonth * costPerMinuteUsd + fixedCostUsd;
  const priceFloorUsd = costToServeUsd / (1 - targetMarginPct / 100);
  return { costToServeUsd, priceFloorUsd, floorPerMinuteUsd: minutesPerMonth > 0 ? priceFloorUsd / minutesPerMonth : null };
}

export interface Reconciliation { driftUsd: number | null; driftPct: number | null; status: 'ok' | 'drift' | 'no_invoice' }

/** Compares our estimate/reported total with the provider invoice. Drift = (estimated - invoiced). */
export function reconcile(estimatedUsd: number, invoicedUsd: number | null, thresholdPct: number): Reconciliation {
  if (invoicedUsd === null) return { driftUsd: null, driftPct: null, status: 'no_invoice' };
  const driftUsd = estimatedUsd - invoicedUsd;
  if (invoicedUsd === 0) return { driftUsd, driftPct: null, status: estimatedUsd === 0 ? 'ok' : 'drift' };
  const driftPct = (driftUsd / invoicedUsd) * 100;
  return { driftUsd, driftPct, status: Math.abs(driftPct) > thresholdPct ? 'drift' : 'ok' };
}

/** Average cost per free signup; null when there are no free orgs. */
export function freeTierCostPerSignup(freeOrgCostsUsd: number[]): number | null {
  const v = freeOrgCostsUsd.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
