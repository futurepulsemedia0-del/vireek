export type ClaimStatus = 'eligible' | 'packet_pending' | 'submitted' | 'approved' | 'denied' | 'credit_received' | 'closed';

export type CreditMethod = 'account_credit' | 'check' | 'ach' | 'other';

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  eligible: 'Eligible — not started',
  packet_pending: 'Building packet',
  submitted: 'Submitted to manufacturer',
  approved: 'Approved',
  denied: 'Denied',
  credit_received: 'Credit received',
  closed: 'Closed',
};

export const CLAIM_STATUS_COLORS: Record<ClaimStatus, string> = {
  eligible: 'bg-bg-tertiary text-text-secondary',
  packet_pending: 'bg-accent/10 text-accent',
  submitted: 'bg-warning-500/10 text-warning-500',
  approved: 'bg-success-500/10 text-success-500',
  denied: 'bg-danger/10 text-danger',
  credit_received: 'bg-success-500/10 text-success-500',
  closed: 'bg-bg-tertiary text-text-secondary',
};

// Ordered pipeline — used for the status <select>, in the sequence a
// claim actually moves through; "denied" set apart as the off-ramp.
export const CLAIM_STATUS_OPTIONS: ClaimStatus[] = [
  'eligible',
  'packet_pending',
  'submitted',
  'approved',
  'credit_received',
  'closed',
  'denied',
];

export const CREDIT_METHOD_LABELS: Record<CreditMethod, string> = {
  account_credit: 'Distributor account credit',
  check: 'Check',
  ach: 'ACH / bank transfer',
  other: 'Other',
};

export interface PacketChecklist {
  proof_of_purchase: boolean;
  defect_photo: boolean;
  serial_photo: boolean;
  invoice: boolean;
  diagnosis_report: boolean;
}

export const PACKET_ITEM_LABELS: Record<keyof PacketChecklist, string> = {
  proof_of_purchase: 'Proof of purchase / install date',
  defect_photo: 'Photo of the failed part',
  serial_photo: 'Photo of the serial/data plate',
  invoice: 'Job invoice',
  diagnosis_report: "Technician's diagnosis notes",
};

export const EMPTY_CHECKLIST: PacketChecklist = {
  proof_of_purchase: false,
  defect_photo: false,
  serial_photo: false,
  invoice: false,
  diagnosis_report: false,
};

// A claim still actively moving — drives the "open claims" stat/filter.
export function isOpenClaim(status: ClaimStatus): boolean {
  return status !== 'denied' && status !== 'closed';
}

export function packetProgress(checklist: PacketChecklist | null | undefined): { done: number; total: number } {
  const values = Object.values(checklist ?? EMPTY_CHECKLIST);
  return { done: values.filter(Boolean).length, total: values.length };
}

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return 'Not on file';
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

// True once a claim has a deadline that's already passed and hasn't been
// submitted yet — this is the "we're about to lose this money" flag.
export function isDeadlineAtRisk(status: ClaimStatus, claimDeadline: string | null | undefined): boolean {
  if (!claimDeadline) return false;
  if (status !== 'eligible' && status !== 'packet_pending') return false;
  const d = daysUntil(claimDeadline);
  return d !== null && d <= 7;
}
