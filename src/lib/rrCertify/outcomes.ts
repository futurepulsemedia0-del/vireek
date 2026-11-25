/**
 * Loss definition and right-censoring. Mirrors the SQL in rr_certify_case_outcomes; keep both in sync.
 *
 * FALSE RESOLUTION (loss = 1): the customer confirmed the fix (resolved_at), and then, within W days of
 * that moment, EITHER the case was reopened (customer or staff) OR a later job was created that the
 * database links to the same job through rework_of_job_id.
 *
 * What this does NOT see (so the guarantee cannot cover it):
 *   - a customer who has the problem again and calls a different company, or says nothing;
 *   - failures after day W;
 *   - a repeat visit that the rework trigger did not link (it matches customer + service type within
 *     45 days, not equipment).
 * Under-detection makes measured risk LOWER than true risk. The UI must say so.
 *
 * RIGHT-CENSORING: a case whose window has not finished (resolved_at + W > now) has an unknown loss.
 * It is EXCLUDED from calibration. It is never counted as a success. Selection depends only on the
 * calendar, never on the outcome, so excluding it does not bias the retained cases. (A failure already
 * seen inside an unfinished window is NOT used for calibration for the same reason; the drift monitor
 * may use it as a valid early warning, see drift.ts.)
 */
import type { CaseOutcomeRow, LabeledCase, LabelState } from './types.ts';

const DAY_MS = 86_400_000;
/** Attempted cases that ended without ever being closed as resolved: loss is final and 0. */
const NEVER_RESOLVED = new Set(['dispatch_required', 'expired', 'withdrawn']);
const CLOSED_AS_RESOLVED = new Set(['resolved_pending', 'resolved_remotely', 'reopened']);

const ts = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export interface LabelResult {
  state: LabelState;
  /** Present only when state === 'mature'. */
  labeled?: LabeledCase;
  /** A failure is already visible although the window is still open (state === 'censored'). */
  earlyFailure?: boolean;
}

export function labelCase(row: CaseOutcomeRow, windowDays: number, now: Date, fallbackThreshold: number): LabelResult {
  const score = Number(row.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) return { state: 'censored' };

  if (row.status === 'intake' || row.status === 'troubleshooting') return { state: 'active' };

  const threshold = row.threshold ?? fallbackThreshold;
  const base = {
    caseId: row.case_id,
    segment: row.segment,
    score: Math.round(score),
    threshold,
    thresholdSource: row.threshold === null ? ('assumed_current' as const) : row.thresholdSource,
  };

  if (NEVER_RESOLVED.has(row.status) && !row.resolvedAt) {
    return { state: 'mature', labeled: { ...base, loss: 0, observedUntil: null } };
  }

  const resolvedAt = ts(row.resolvedAt);
  // Closed-as-resolved without a timestamp: we cannot place the window. Unknown, so excluded.
  if (!CLOSED_AS_RESOLVED.has(row.status) || resolvedAt === null) return { state: 'censored' };

  const windowEnd = resolvedAt + windowDays * DAY_MS;
  const failures = [ts(row.reopenedAt), ts(row.repeatJobAt)].filter((t): t is number => t !== null && t >= resolvedAt);
  const firstFailure = failures.length ? Math.min(...failures) : null;
  const failedInside = firstFailure !== null && firstFailure <= windowEnd;

  if (now.getTime() < windowEnd) return { state: 'censored', earlyFailure: failedInside };
  return {
    state: 'mature',
    labeled: { ...base, loss: failedInside ? 1 : 0, observedUntil: new Date(windowEnd).toISOString() },
  };
}

export interface LabelSummary {
  mature: LabeledCase[];
  nCensored: number;
  nActive: number;
  earlyFailures: number;
}

export function labelAll(rows: CaseOutcomeRow[], windowDays: number, now: Date, fallbackThreshold: number): LabelSummary {
  const mature: LabeledCase[] = [];
  let nCensored = 0;
  let nActive = 0;
  let earlyFailures = 0;
  for (const r of rows) {
    const res = labelCase(r, windowDays, now, fallbackThreshold);
    if (res.state === 'mature' && res.labeled) mature.push(res.labeled);
    else if (res.state === 'active') nActive += 1;
    else {
      nCensored += 1;
      if (res.earlyFailure) earlyFailures += 1;
    }
  }
  return { mature, nCensored, nActive, earlyFailures };
}
