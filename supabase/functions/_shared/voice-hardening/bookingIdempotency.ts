// Duplicate-delivery guard for the book_appointment voice tool: a retried tool call must not create a second job.

export interface ExistingJobLite { id: string; customer_name: string | null; scheduled_datetime: string | null }

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Same call + same customer + same instant (compared as instants, not strings) = the same booking. */
export function findDuplicateBooking(
  existing: ExistingJobLite[],
  candidate: { customerName: string; scheduledDatetime: string | null },
): ExistingJobLite | null {
  const candMs = candidate.scheduledDatetime ? Date.parse(candidate.scheduledDatetime) : null;
  for (const job of existing) {
    if (norm(job.customer_name) !== norm(candidate.customerName)) continue;
    const jobMs = job.scheduled_datetime ? Date.parse(job.scheduled_datetime) : null;
    if (candMs === null && jobMs === null) return job;
    if (candMs !== null && jobMs !== null && Number.isFinite(candMs) && candMs === jobMs) return job;
  }
  return null;
}
