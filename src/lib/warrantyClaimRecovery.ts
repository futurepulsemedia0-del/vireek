// Legacy values (eligible, packet_pending, credit_received) stay in the type because protection-plan
// claims still use them; manufacturer claims are normalised by the database to the new names.
export type ClaimStatus =
  | 'eligible'
  | 'packet_pending'
  | 'submitted'
  | 'approved'
  | 'denied'
  | 'credit_received'
  | 'closed'
  | 'needs_review'
  | 'ready'
  | 'expired'
  | 'paid';

export type CreditMethod = 'account_credit' | 'check' | 'ach' | 'other';

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  eligible: 'Eligible — not started',
  packet_pending: 'Building packet',
  submitted: 'Submitted to manufacturer',
  approved: 'Approved',
  denied: 'Denied',
  credit_received: 'Credit received',
  closed: 'Closed',
  needs_review: 'Needs review',
  ready: 'Ready to submit',
  expired: 'Expired',
  paid: 'Paid',
};

export const CLAIM_STATUS_COLORS: Record<ClaimStatus, string> = {
  eligible: 'bg-bg-tertiary text-text-secondary',
  packet_pending: 'bg-accent/10 text-accent',
  submitted: 'bg-warning-500/10 text-warning-500',
  approved: 'bg-success-500/10 text-success-500',
  denied: 'bg-danger/10 text-danger',
  credit_received: 'bg-success-500/10 text-success-500',
  closed: 'bg-bg-tertiary text-text-secondary',
  needs_review: 'bg-bg-tertiary text-text-secondary',
  ready: 'bg-accent/10 text-accent',
  expired: 'bg-danger/10 text-danger',
  paid: 'bg-success-500/10 text-success-500',
};

// Ordered pipeline — used for the status <select>, in the sequence a
// claim actually moves through; "denied" and "expired" set apart as the off-ramps.
export const CLAIM_STATUS_OPTIONS: ClaimStatus[] = [
  'needs_review',
  'ready',
  'submitted',
  'approved',
  'paid',
  'closed',
  'denied',
  'expired',
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
  return status !== 'denied' && status !== 'closed' && status !== 'expired';
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
  if (status !== 'eligible' && status !== 'packet_pending' && status !== 'needs_review' && status !== 'ready') return false;
  const d = daysUntil(claimDeadline);
  return d !== null && d <= 7;
}
// ---------------------------------------------------------------------------
// Workflow actions (mirror of warranty_claim_transition_allowed() in the database,
// which is the real gate — this only decides which buttons to show).
// ---------------------------------------------------------------------------

export type ClaimAction = 'approve' | 'submit' | 'record_payment' | 'deny' | 'back_to_review' | 'expire' | 'close';

export const CLAIM_ACTION_LABELS: Record<ClaimAction, string> = {
  approve: 'Approve for submission',
  submit: 'Mark as submitted',
  record_payment: 'Record payment',
  deny: 'Mark denied',
  back_to_review: 'Back to review',
  expire: 'Mark expired',
  close: 'Close claim',
};

export function availableActions(status: ClaimStatus): ClaimAction[] {
  switch (status) {
    case 'needs_review':
      return ['approve', 'expire', 'close'];
    case 'eligible': // legacy
    case 'packet_pending': // legacy
      return ['approve', 'back_to_review', 'expire', 'close'];
    case 'ready':
      return ['submit', 'back_to_review', 'expire', 'close'];
    case 'submitted':
      return ['record_payment', 'deny', 'expire'];
    case 'approved': // legacy
      return ['record_payment', 'deny', 'expire', 'close'];
    case 'credit_received': // record_payment here corrects the amount
      return ['record_payment', 'close'];
    case 'denied':
    case 'expired':
      return ['close'];
    default:
      return [];
  }
}

/** "1,250.50" or "$1250" -> cents. Returns null for empty, invalid or zero/negative amounts. */
export function dollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(parseFloat(cleaned) * 100);
  return cents > 0 ? cents : null;
}

// ---------------------------------------------------------------------------
// Packet returned by the warranty_claim_packet RPC
// ---------------------------------------------------------------------------

export interface WarrantyClaimPacket {
  claim_id: string;
  status: ClaimStatus;
  customer_name: string | null;
  property_address: string | null;
  unit: {
    manufacturer: string | null;
    model_number: string | null;
    serial_number: string | null;
    install_date: string | null;
    warranty_expires_at: string | null;
    registration: Record<string, unknown>;
  };
  job: { id: string | null; completed_at: string | null; service_type: string | null };
  failure_notes: { text: string | null; source: 'claim' | 'job_outcome' | 'job_notes' | null };
  parts: { name: string; part_number: string | null; quantity: number; unit_cost_cents: number | null }[];
  labor: { hours: number | null; entries: number; source: string };
  photos: { id: string; kind: string | null; caption: string | null; file_name: string | null; taken_at: string | null }[];
  claim_deadline: string | null;
  detection_basis: unknown;
  checklist: PacketChecklist | null;
  items: { key: string; label: string; present: boolean; blocking: boolean }[];
  missing: string[];
  blocking_missing: string[];
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Database error codes -> friendly messages
// ---------------------------------------------------------------------------

const PACKET_KEY_LABELS: Record<string, string> = {
  manufacturer: 'Manufacturer',
  model_number: 'Model number',
  serial_number: 'Serial number',
  install_date: 'Install date',
  failure_notes: 'Failure / diagnosis notes',
  claim_deadline: 'Filing deadline',
};

export function warrantyErrorMessage(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  const m = /WARRANTY_([A-Z_]+)(?::\s*([\s\S]*))?/.exec(text);
  if (!m) return text || 'Something went wrong. Please try again.';
  const detail = (m[2] ?? '').trim();
  switch (m[1]) {
    case 'FORBIDDEN':
      return 'Only the owner or office can action warranty claims.';
    case 'CLAIM_NOT_FOUND':
      return 'This claim could not be found.';
    case 'USE_RECORD_PAYMENT':
      return 'Use "Record payment" to mark a claim as paid.';
    case 'INVALID_TRANSITION':
      return 'That status change is not allowed from the claim’s current status.';
    case 'REF_TOO_LONG':
      return 'The reference number is too long (120 characters max).';
    case 'NOTE_TOO_LONG':
      return 'The note is too long.';
    case 'HUMAN_APPROVAL_REQUIRED':
      return 'A person must confirm this step. Tick the confirmation box.';
    case 'PACKET_INCOMPLETE': {
      const missing = detail
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
        .map((k) => PACKET_KEY_LABELS[k] ?? k.replace(/_/g, ' '));
      return missing.length
        ? `The packet is missing required items: ${missing.join(', ')}.`
        : 'The packet is missing required items.';
    }
    case 'REF_REQUIRED':
      return 'Enter the manufacturer’s reference number.';
    case 'AMOUNT_INVALID':
      return 'Enter an amount greater than $0.';
    case 'DATE_IN_FUTURE':
      return 'The received date cannot be in the future.';
    case 'METHOD_INVALID':
      return 'Choose a valid payment method.';
    case 'INITIAL_STATUS_INVALID':
    case 'PROTECTED_FIELDS':
    case 'STATUS_VIA_RPC_ONLY':
      return 'This change is not allowed. Status and payment can only change through the claim workflow.';
    default:
      return detail || 'Something went wrong. Please try again.';
  }
}
