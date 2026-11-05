// Outcome maturity for dispatch experiments — PURE.
//
// A job's "callback within W days" is only knowable once W days have passed since completion; reading it earlier
// counts every not-yet-reworked job as a success (right-censoring bias). This mirrors the rule in
// src/lib/opsExperiments.ts observe(): completed, not itself a rework, and `now - completed >= window`.
// (A cross-check test in src/lib/causalDispatch.test.ts keeps the two in agreement.)
// Unlike opsExperiments' reworked-set it is WINDOW-AWARE: a rework opened 20 days later is not a 14-day callback.

const DAY_MS = 86_400_000;

export interface OutcomeJob {
  id: string;
  job_status: string;
  completed_at: string | null;
  is_rework: boolean;
}

/** created_at of every rework job, keyed by the job it reworks. */
export type ReworkIndex = Map<string, string[]>;

export function buildReworkIndex(reworks: { rework_of_job_id: string | null; created_at: string }[]): ReworkIndex {
  const idx: ReworkIndex = new Map();
  for (const r of reworks) {
    if (!r.rework_of_job_id) continue;
    const list = idx.get(r.rework_of_job_id) ?? [];
    list.push(r.created_at);
    idx.set(r.rework_of_job_id, list);
  }
  return idx;
}

/**
 * 1 = a rework was opened within `windowDays` of completion, 0 = none and the window has fully elapsed,
 * null = not (yet) a valid observation (not completed, is itself a rework, or the window is still open).
 */
export function callbackWithin(job: OutcomeJob, reworks: ReworkIndex, windowDays: number, now: Date): 0 | 1 | null {
  if (job.is_rework || job.job_status !== 'completed' || !job.completed_at) return null;
  const completed = Date.parse(job.completed_at);
  if (!Number.isFinite(completed) || now.getTime() - completed < windowDays * DAY_MS) return null;
  for (const created of reworks.get(job.id) ?? []) {
    const t = Date.parse(created);
    if (Number.isFinite(t) && t >= completed && t - completed <= windowDays * DAY_MS) return 1;
  }
  return 0;
}

/** First-time fix = no callback inside the window. Same maturity rule. */
export function firstTimeFix(job: OutcomeJob, reworks: ReworkIndex, windowDays: number, now: Date): 0 | 1 | null {
  const cb = callbackWithin(job, reworks, windowDays, now);
  return cb === null ? null : ((1 - cb) as 0 | 1);
}
