// Results Plan — dispute evaluation (pure). The ledger evidence either supports the charge or it does not.

export const DISPUTE_WINDOW_DAYS = 14; // from the spec; confirm in terms

export interface ChargeEvidence {
  ruleVersion: string;
  hasCall: boolean;
  callAt: string | null;
  hasBookingRecord: boolean;
  crmJobId: string | null;
  hasCompletionEvent: boolean;
  hasConfirmationEvent: boolean;
  qualifiedReasons: string[];
  billingLevel: 'booked' | 'confirmed' | 'completed' | 'paid';
}

export type DisputeOutcome = { decision: 'auto_credit'; reason: string } | { decision: 'needs_review'; reason: string };

export function disputeWindowOpen(chargeCreatedAt: string, now: string): boolean {
  const c = Date.parse(chargeCreatedAt);
  const n = Date.parse(now);
  if (Number.isNaN(c) || Number.isNaN(n)) return false;
  return n >= c && n - c <= DISPUTE_WINDOW_DAYS * 86_400_000;
}

/** Credit automatically only when the evidence chain cannot support the charge; otherwise a human reviews. */
export function evaluateDispute(e: ChargeEvidence): DisputeOutcome {
  if (!e.hasCall) return { decision: 'auto_credit', reason: 'No call/text/chat record supports first contact by Sarah.' };
  if (!e.hasBookingRecord) return { decision: 'auto_credit', reason: 'No booking record exists for this job.' };
  if (e.qualifiedReasons.length > 0) return { decision: 'auto_credit', reason: `Rule check failed: ${e.qualifiedReasons.join(', ')}.` };
  const needsCompletion = e.billingLevel === 'completed' || e.billingLevel === 'paid';
  if (needsCompletion && !e.hasCompletionEvent) return { decision: 'auto_credit', reason: 'Billing level requires completion and no completion event exists.' };
  if (e.billingLevel === 'confirmed' && !e.hasConfirmationEvent) return { decision: 'auto_credit', reason: 'Billing level requires confirmation and none exists.' };
  return { decision: 'needs_review', reason: 'Evidence supports the charge; a reviewer will check the owner’s claim.' };
}
