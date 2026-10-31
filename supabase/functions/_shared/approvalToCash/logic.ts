/**
 * Approval-to-Cash — PURE business rules (no I/O, no imports).
 *
 * Mirrored 1:1 in SQL (supabase/migrations/20280101000000_approval_to_cash.sql):
 *   evaluateInvoiceGate   <->  public._a2c_gate()
 *   AP_TRANSITIONS        <->  public.set_invoice_ap_state()
 *   ladder helpers        <->  public.a2c_claim_followup_step() / edge function invoice-followup-ladder
 * Change one, change the other. All money is integer cents. No LLM-generated numbers.
 */

// ------------------------------------------------------------
// Gate (pre-invoice block / warn)
// ------------------------------------------------------------

export type GateCode =
  | 'WO_NOT_APPROVED'
  | 'OVER_APPROVED_AMOUNT'
  | 'MISSING_PO'
  | 'MISSING_COMPLETION_PROOF';

export interface GateFinding {
  code: GateCode;
  severity: 'block' | 'warn';
  message: string;
}

export interface GatePolicy {
  requirePo: boolean;
  requireCompletionProof: boolean;
}

export interface GateWorkOrder {
  approvalStatus: 'not_required' | 'pending' | 'approved' | 'rejected';
  poNumber: string | null;
  notToExceedCents: number | null;
  /** Totals of OTHER live invoices (sent/viewed/paid, not void/draft) already billed to this work order. */
  otherInvoicedCents: number;
}

export interface GateInput {
  invoiceTotalCents: number;
  policy: GatePolicy;
  /** null = the invoice is not linked to a work order. */
  workOrder: GateWorkOrder | null;
  /** true when the work order has a completed visit, or the linked job is completed with work/test/result evidence. */
  hasCompletionProof: boolean;
}

export interface GateResult {
  ok: boolean; // no unresolved blocks
  findings: GateFinding[];
  blocks: GateFinding[];
  warnings: GateFinding[];
  approvedCents: number | null;
  committedCents: number | null; // other invoices + this one
}

export const fmtCents = (c: number): string =>
  `$${(Math.round(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const blank = (s: string | null | undefined): boolean => s == null || s.trim() === '';

export function evaluateInvoiceGate(input: GateInput): GateResult {
  const findings: GateFinding[] = [];
  const { policy, workOrder } = input;
  const total = Math.max(0, Math.trunc(input.invoiceTotalCents));

  if (!workOrder) {
    // Not a commercial/PO job. Only the account policy can make that a problem.
    if (policy.requirePo) {
      findings.push({ code: 'MISSING_PO', severity: 'block', message: 'No customer PO / work order is linked to this invoice.' });
    }
    if (policy.requireCompletionProof && !input.hasCompletionProof) {
      findings.push({ code: 'MISSING_COMPLETION_PROOF', severity: 'block', message: 'No completion proof is on file for this invoice.' });
    }
    return finish(findings, null, null);
  }

  if (workOrder.approvalStatus === 'pending' || workOrder.approvalStatus === 'rejected') {
    findings.push({
      code: 'WO_NOT_APPROVED',
      severity: 'block',
      message: workOrder.approvalStatus === 'rejected'
        ? 'The linked work order was rejected by the customer.'
        : 'The linked work order has not been approved yet.',
    });
  }

  if (blank(workOrder.poNumber)) {
    findings.push({
      code: 'MISSING_PO',
      severity: policy.requirePo ? 'block' : 'warn',
      message: 'The linked work order has no customer PO number.',
    });
  }

  let committed: number | null = null;
  if (workOrder.notToExceedCents != null) {
    committed = Math.max(0, Math.trunc(workOrder.otherInvoicedCents)) + total;
    if (committed > workOrder.notToExceedCents) {
      findings.push({
        code: 'OVER_APPROVED_AMOUNT',
        severity: 'block',
        message: `Billed total ${fmtCents(committed)} would exceed the approved not-to-exceed ${fmtCents(workOrder.notToExceedCents)}.`,
      });
    }
  }

  if (!input.hasCompletionProof) {
    findings.push({
      code: 'MISSING_COMPLETION_PROOF',
      severity: policy.requireCompletionProof ? 'block' : 'warn',
      message: 'No completion proof (completed visit or job evidence) is on file.',
    });
  }

  return finish(findings, workOrder.notToExceedCents, committed);
}

function finish(findings: GateFinding[], approved: number | null, committed: number | null): GateResult {
  const blocks = findings.filter((f) => f.severity === 'block');
  return {
    ok: blocks.length === 0,
    findings,
    blocks,
    warnings: findings.filter((f) => f.severity === 'warn'),
    approvedCents: approved,
    committedCents: committed,
  };
}

/**
 * A recorded owner override only counts while the invoice total is unchanged,
 * so editing amounts after an override re-arms the block.
 */
export function overrideStillValid(override: { totalCents: number | null; reason: string | null } | null, currentTotalCents: number): boolean {
  return !!override && !blank(override.reason) && override.totalCents === currentTotalCents;
}

// ------------------------------------------------------------
// Customer-side invoice state machine
// ------------------------------------------------------------

export type ApState = 'sent' | 'received' | 'approved' | 'rejected' | 'paid';

/** 'paid' is NOT manually reachable: it is set only by the payment trigger. */
export const AP_TRANSITIONS: Record<ApState, readonly ApState[]> = {
  sent: ['received', 'approved', 'rejected'],
  received: ['approved', 'rejected'],
  approved: ['rejected'],
  rejected: ['received', 'approved'],
  paid: [],
};

export function canTransitionAp(from: ApState, to: ApState): boolean {
  return AP_TRANSITIONS[from].includes(to);
}

export function validateApTransition(
  from: ApState,
  to: ApState,
  reason: string | null | undefined,
): { ok: true } | { ok: false; error: string } {
  if (from === to) return { ok: false, error: 'The invoice is already in that state.' };
  if (to === 'paid') return { ok: false, error: 'Paid is set automatically when payments cover the balance.' };
  if (!canTransitionAp(from, to)) return { ok: false, error: `Cannot move from ${from} to ${to}.` };
  if (to === 'rejected' && blank(reason)) return { ok: false, error: 'A rejection reason is required.' };
  return { ok: true };
}

// ------------------------------------------------------------
// Follow-up ladder
// ------------------------------------------------------------

export const DEFAULT_LADDER_DAYS: readonly number[] = [3, 7, 14, 30];
export const MAX_LADDER_STEPS = 8;
export const MAX_LADDER_DAY = 365;

/** Days AFTER the due date at which each step fires. Strictly ascending, positive integers, 1..8 steps. */
export function validateLadder(days: readonly number[] | null | undefined): { ok: true } | { ok: false; error: string } {
  if (!days || days.length === 0) return { ok: false, error: 'Add at least one follow-up step.' };
  if (days.length > MAX_LADDER_STEPS) return { ok: false, error: `At most ${MAX_LADDER_STEPS} steps.` };
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (!Number.isInteger(d) || d < 1 || d > MAX_LADDER_DAY) return { ok: false, error: `Each step must be a whole number of days from 1 to ${MAX_LADDER_DAY}.` };
    if (i > 0 && d <= days[i - 1]) return { ok: false, error: 'Steps must be strictly increasing.' };
  }
  return { ok: true };
}

/** Whole calendar days between two YYYY-MM-DD dates (UTC-safe). Negative = not yet due. */
export function daysOverdue(dueDate: string, today: string): number | null {
  const d = /^\d{4}-\d{2}-\d{2}$/;
  if (!d.test(dueDate) || !d.test(today)) return null;
  const a = Date.UTC(+dueDate.slice(0, 4), +dueDate.slice(5, 7) - 1, +dueDate.slice(8, 10));
  const b = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

export interface LadderInvoice {
  dueDate: string | null; // YYYY-MM-DD
  balanceCents: number;
  invoiceStatus: 'draft' | 'sent' | 'viewed' | 'paid' | 'void';
  apState: ApState;
  followupsApproved: boolean;
  followupsPaused: boolean;
  lastLadderStep: number; // number of steps already claimed (0 = none)
}

export type LadderDecision =
  | { send: false; reason: string }
  | { send: true; stepIndex: number; /** 1-based step number to store as last_ladder_step */ stepNumber: number; daysOverdue: number };

/**
 * Decide whether ONE follow-up should go out now. At most one send per invoice per run:
 * if cron was down and several steps are past due, send once and jump to the highest due step
 * (never a burst of emails).
 */
export function decideLadderStep(inv: LadderInvoice, ladder: readonly number[], today: string): LadderDecision {
  if (!inv.followupsApproved) return { send: false, reason: 'followups_not_approved' };
  if (inv.followupsPaused) return { send: false, reason: 'paused' };
  if (inv.invoiceStatus !== 'sent' && inv.invoiceStatus !== 'viewed') return { send: false, reason: 'invoice_not_open' };
  if (inv.apState === 'rejected') return { send: false, reason: 'rejected_needs_human' };
  if (inv.apState === 'paid') return { send: false, reason: 'paid' };
  if (inv.balanceCents <= 0) return { send: false, reason: 'no_balance' };
  if (!inv.dueDate) return { send: false, reason: 'missing_due_date' };
  if (!validateLadder(ladder).ok) return { send: false, reason: 'invalid_ladder' };
  const overdue = daysOverdue(inv.dueDate, today);
  if (overdue === null) return { send: false, reason: 'malformed_date' };

  let highestDue = -1;
  for (let i = 0; i < ladder.length; i++) if (overdue >= ladder[i]) highestDue = i;
  if (highestDue < 0) return { send: false, reason: 'not_due_yet' };
  if (inv.lastLadderStep > highestDue) return { send: false, reason: 'already_sent' };
  return { send: true, stepIndex: highestDue, stepNumber: highestDue + 1, daysOverdue: overdue };
}

// ------------------------------------------------------------
// Demand-letter DRAFT (deterministic, factual; never sent by the system)
// ------------------------------------------------------------

export interface DemandLetterFacts {
  businessName: string;
  customerName: string;
  invoiceNumber: string;
  invoiceDate: string | null; // display string
  dueDate: string; // display string
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  daysOverdue: number;
  poNumber: string | null;
  workOrderNumber: string | null;
  /** Display string for the date the sender wants payment by (chosen by a human). */
  payByDate: string | null;
}

/**
 * Plain payment-request wording. Deliberately contains NO legal claims, statutes, threats,
 * interest/fee assertions or collections language. A human edits and sends it outside Vireek.
 */
export function buildDemandLetterDraft(f: DemandLetterFacts): string {
  const refs: string[] = [`Invoice ${f.invoiceNumber}`];
  if (f.poNumber) refs.push(`PO ${f.poNumber}`);
  if (f.workOrderNumber) refs.push(`Work order ${f.workOrderNumber}`);
  const lines = [
    `Re: ${refs.join(' · ')}`,
    '',
    `Dear ${f.customerName},`,
    '',
    `Our records show that ${f.invoiceNumber}${f.invoiceDate ? `, issued ${f.invoiceDate},` : ''} was due on ${f.dueDate} and is now ${f.daysOverdue} day${f.daysOverdue === 1 ? '' : 's'} past due.`,
    '',
    `Invoice total: ${fmtCents(f.totalCents)}`,
    `Payments received: ${fmtCents(f.paidCents)}`,
    `Balance outstanding: ${fmtCents(f.balanceCents)}`,
    '',
    f.payByDate
      ? `Please arrange payment of the outstanding balance by ${f.payByDate}.`
      : 'Please arrange payment of the outstanding balance at your earliest convenience.',
    'If you believe this is in error, or if payment has already been sent, please reply with the details so we can reconcile our records.',
    '',
    'Thank you,',
    f.businessName,
  ];
  return lines.join('\n');
}

/** Words that must never appear in a generated draft (legal advice / threats / collections). */
export const DEMAND_LETTER_FORBIDDEN = [
  'lawsuit', 'sue', 'attorney', 'lawyer', 'legal action', 'court', 'lien', 'collections',
  'collection agency', 'statute', 'interest', 'late fee', 'penalt', 'garnish', 'credit bureau', 'credit report',
] as const;

export function demandLetterIsClean(text: string): boolean {
  const t = text.toLowerCase();
  return !DEMAND_LETTER_FORBIDDEN.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t));
}

// ------------------------------------------------------------
// Recovery-ledger mapping (what goes into revenue_recovery_events)
// ------------------------------------------------------------

export type RecoveryKind = 'invoice_overdue' | 'invoice_rejected';

export function recoveryKindFor(apState: ApState, overdueDays: number | null, balanceCents: number): RecoveryKind | null {
  if (balanceCents <= 0 || apState === 'paid') return null;
  if (apState === 'rejected') return 'invoice_rejected';
  if (overdueDays !== null && overdueDays >= 1) return 'invoice_overdue';
  return null;
}
