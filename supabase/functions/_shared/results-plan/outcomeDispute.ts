// Invoice-outcome disputes (Task E): states, SLA timers, billing effect. PURE.
// All durations are PLACEHOLDERS pending [COUNSEL] review of the customer contract.

export type DisputeState = 'open' | 'under_review' | 'upheld' | 'rejected' | 'withdrawn';

export const DISPUTE_TRANSITIONS: Readonly<Record<DisputeState, readonly DisputeState[]>> = {
  open: ['under_review', 'withdrawn', 'upheld', 'rejected'],
  under_review: ['upheld', 'rejected', 'withdrawn'],
  upheld: [],
  rejected: [],
  withdrawn: [],
};

export interface DisputeSla {
  ackHours: number;
  resolveDays: number;
  windowDays: number;
}
export const DISPUTE_SLA_DEFAULTS: DisputeSla = { ackHours: 48, resolveDays: 10, windowDays: 14 };

export const REASON_MIN = 10;
export const REASON_MAX = 2000;

export type ReasonError = 'too_short' | 'too_long';
export function validateReason(raw: string): ReasonError | null {
  const n = raw.trim().length;
  if (n < REASON_MIN) return 'too_short';
  if (n > REASON_MAX) return 'too_long';
  return null;
}

export const canDisputeTransition = (from: DisputeState, to: DisputeState): boolean => DISPUTE_TRANSITIONS[from].includes(to);

const H = 3_600_000;
const D = 86_400_000;

export function slaDeadlines(openedAt: string, sla: DisputeSla = DISPUTE_SLA_DEFAULTS): { ackDueAt: string; resolveDueAt: string } {
  const t = Date.parse(openedAt);
  if (!Number.isFinite(t)) throw new Error('invalid_timestamp');
  return { ackDueAt: new Date(t + sla.ackHours * H).toISOString(), resolveDueAt: new Date(t + sla.resolveDays * D).toISOString() };
}

export type SlaStatus = 'resolved' | 'ok' | 'ack_due_soon' | 'ack_overdue' | 'resolve_due_soon' | 'resolve_overdue';

export function slaStatus(d: { state: DisputeState; ackDueAt: string; resolveDueAt: string; acknowledgedAt: string | null }, now: string): SlaStatus {
  if (d.state === 'upheld' || d.state === 'rejected' || d.state === 'withdrawn') return 'resolved';
  const n = Date.parse(now);
  const ack = Date.parse(d.ackDueAt);
  const res = Date.parse(d.resolveDueAt);
  if (![n, ack, res].every(Number.isFinite)) return 'ok';
  if (n > res) return 'resolve_overdue';
  if (d.acknowledgedAt === null && n > ack) return 'ack_overdue';
  if (res - n <= 24 * H) return 'resolve_due_soon';
  if (d.acknowledgedAt === null && ack - n <= 12 * H) return 'ack_due_soon';
  return 'ok';
}

/** Window in which a customer may contest a line, counted from statement approval. */
export function disputeWindowOpen(approvedAt: string | null, now: string, windowDays = DISPUTE_SLA_DEFAULTS.windowDays): boolean {
  if (!approvedAt) return false;
  const a = Date.parse(approvedAt);
  const n = Date.parse(now);
  return Number.isFinite(a) && Number.isFinite(n) && n >= a && n < a + windowDays * D;
}

/** Contested lines stay out of billing until resolved. Upheld = permanently out. Rejected/withdrawn = back in. */
export function lineExcludedFromBilling(state: DisputeState): boolean {
  return state === 'open' || state === 'under_review' || state === 'upheld';
}

export function contestedInvoiceIds(ds: ReadonlyArray<{ invoiceId: string; state: DisputeState }>): Set<string> {
  return new Set(ds.filter((d) => lineExcludedFromBilling(d.state)).map((d) => d.invoiceId));
}
