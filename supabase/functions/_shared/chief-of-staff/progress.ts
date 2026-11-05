// supabase/functions/_shared/chief-of-staff/progress.ts
//
// Pure goal-pace maths. The edge function supplies REAL actuals read from the database (or "unavailable"
// with a reason); this file only compares them with the target. It never estimates an actual.

import { LIMITS, type GoalMetric } from "./types.ts";

export type ProgressStatus = "ahead" | "on_track" | "behind" | "unavailable";

export type UnavailableReason = "not_enough_data" | "query_failed" | "too_large" | "no_permission";

export interface Actual {
  value: number | null;
  /** Human-checkable description of what was measured, e.g. "12 of 15 completed jobs with cost entries". */
  basis: string;
  unavailable?: UnavailableReason;
}

export interface GoalProgress {
  metric: GoalMetric;
  target: number;
  actual: number | null;
  /** counters only: target × fraction of the period elapsed. */
  expectedToDate: number | null;
  /** counters only: actual ÷ elapsed fraction, a straight-line projection (not a forecast model). */
  projected: number | null;
  /** 0-100 for display; capped. */
  pct: number | null;
  status: ProgressStatus;
  basis: string;
  unavailable?: UnavailableReason;
}

const DAY = 86_400_000;
const isCounter = (m: GoalMetric) => m === "revenue" || m === "booked_jobs";

export function elapsedFraction(periodStart: string, periodEnd: string, today: string): number {
  const s = Date.parse(`${periodStart}T00:00:00Z`);
  const e = Date.parse(`${periodEnd}T00:00:00Z`) + DAY; // end date is inclusive
  const t = Date.parse(`${today}T00:00:00Z`) + DAY; // today counts as elapsed
  const f = (t - s) / (e - s);
  return Math.min(1, Math.max(0, f));
}

export function computeProgress(
  metric: GoalMetric, target: number, periodStart: string, periodEnd: string, today: string, actual: Actual,
): GoalProgress {
  if (actual.value === null || !Number.isFinite(actual.value)) {
    return { metric, target, actual: null, expectedToDate: null, projected: null, pct: null, status: "unavailable",
      basis: actual.basis, unavailable: actual.unavailable ?? "not_enough_data" };
  }
  const a = actual.value;
  const pct = target > 0 ? Math.min(100, Math.round((a / target) * 1000) / 10) : null;

  if (!isCounter(metric)) {
    // Rates (answer rate, margin) are compared directly with the target; no pacing.
    const status: ProgressStatus = a >= target ? (a >= target + 2 ? "ahead" : "on_track") : "behind";
    return { metric, target, actual: a, expectedToDate: null, projected: null, pct, status, basis: actual.basis };
  }

  const f = elapsedFraction(periodStart, periodEnd, today);
  const expected = target * f;
  const projected = f > 0 ? a / f : null;
  let status: ProgressStatus;
  if (a >= target) status = "ahead";
  else if (f === 0) status = "on_track";
  else if (a >= expected * 1.1) status = "ahead";
  else if (a >= expected * LIMITS.behindPaceFactor) status = "on_track";
  else status = "behind";
  return { metric, target, actual: a, expectedToDate: Math.round(expected * 100) / 100,
    projected: projected === null ? null : Math.round(projected * 100) / 100, pct, status, basis: actual.basis };
}

/** Gross margin (completed, costed jobs) from raw sums. Returns unavailable when the sample is too small. */
export function marginActual(revenueDollars: number, costCents: number, costedJobs: number, completedJobs: number): Actual {
  const basis = `${costedJobs} of ${completedJobs} completed jobs have cost entries`;
  if (costedJobs < LIMITS.minJobsForMargin || revenueDollars <= 0) return { value: null, basis, unavailable: "not_enough_data" };
  const margin = ((revenueDollars - costCents / 100) / revenueDollars) * 100;
  return { value: Math.round(margin * 10) / 10, basis };
}

export function answerRateActual(total: number, missed: number): Actual {
  const basis = `${total - missed} of ${total} calls answered`;
  if (total < LIMITS.minCallsForAnswerRate) return { value: null, basis, unavailable: "not_enough_data" };
  return { value: Math.round(((total - missed) / total) * 1000) / 10, basis };
}
