// supabase/functions/_shared/warranty/claimDeadlines.ts
// Stage logic of check-warranty-claim-deadlines, extracted verbatim (no behaviour change).
// A claim gets "due_soon" WARNING_WINDOW_DAYS before claim_deadline and a separate one-time
// "overdue" once the deadline has passed. Each stage fires at most once per claim.

export const WARNING_WINDOW_DAYS = 7;

export type DeadlineStage = 'due_soon' | 'overdue';

export function daysUntil(dateIso: string, nowMs: number = Date.now()): number {
  const ms = new Date(dateIso).getTime() - nowMs;
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

export function deadlineStage(days: number): DeadlineStage | null {
  return days < 0 ? 'overdue' : days <= WARNING_WINDOW_DAYS ? 'due_soon' : null;
}

/** Claims whose computed stage is set AND differs from the stage already alerted. */
export function pickAlertCandidates<T extends { claim_deadline: unknown; deadline_alert_stage: unknown }>(
  claims: T[],
  nowMs: number = Date.now(),
): Array<{ c: T; stage: DeadlineStage; days: number }> {
  return claims
    .map((c) => {
      const days = daysUntil(c.claim_deadline as string, nowMs);
      return { c, stage: deadlineStage(days), days };
    })
    .filter((x): x is { c: T; stage: DeadlineStage; days: number } => x.stage !== null && x.stage !== x.c.deadline_alert_stage);
}
