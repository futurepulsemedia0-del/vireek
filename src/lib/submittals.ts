// Submittals — pure types, workflow rules and calculations.
//
// No Supabase import on purpose: everything here is deterministic and unit
// tested (submittals.test.ts). The rules mirror install_submittal_transition()
// and the guard triggers in the database, which stay the source of truth —
// this module only decides which buttons to offer and explains why not.

export type SubmittalStatus = 'draft' | 'submitted' | 'in_review' | 'approved' | 'approved_as_noted' | 'revise_resubmit' | 'rejected' | 'void';
export type SubmittalType = 'product_data' | 'shop_drawing' | 'sample' | 'mock_up' | 'test_report' | 'certificate' | 'warranty' | 'om_manual' | 'other';
export type SubmittalDecision = 'approved' | 'approved_as_noted' | 'revise_resubmit' | 'rejected';
export type SubmittalAction = 'submit' | 'start_review' | 'approve' | 'approve_as_noted' | 'revise_resubmit' | 'reject' | 'new_revision' | 'void';

export interface Submittal {
  id: string;
  user_id: string;
  project_id: string;
  phase_id: string | null;
  seq: number;
  spec_section: string;
  title: string;
  description: string | null;
  submittal_type: SubmittalType;
  status: SubmittalStatus;
  current_revision: number;
  reviewer_name: string | null;
  reviewer_email: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubmittalRevision {
  id: string;
  submittal_id: string;
  revision_number: number;
  submitted_at: string | null;
  decision: SubmittalDecision | null;
  decided_at: string | null;
  decision_note: string | null;
}

export const MAX_REVISION = 25;
export const MIN_NOTE_LENGTH = 3;

export const SUBMITTAL_STATUS_LABEL: Record<SubmittalStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  in_review: 'In review',
  approved: 'Approved',
  approved_as_noted: 'Approved as noted',
  revise_resubmit: 'Revise & resubmit',
  rejected: 'Rejected',
  void: 'Void',
};

export const SUBMITTAL_TYPE_LABEL: Record<SubmittalType, string> = {
  product_data: 'Product data',
  shop_drawing: 'Shop drawing',
  sample: 'Sample',
  mock_up: 'Mock-up',
  test_report: 'Test report',
  certificate: 'Certificate',
  warranty: 'Warranty',
  om_manual: 'O&M manual',
  other: 'Other',
};

export const SUBMITTAL_ACTION_LABEL: Record<SubmittalAction, string> = {
  submit: 'Submit for review',
  start_review: 'Mark in review',
  approve: 'Approve',
  approve_as_noted: 'Approve as noted',
  revise_resubmit: 'Revise & resubmit',
  reject: 'Reject',
  new_revision: 'Start new revision',
  void: 'Void',
};

/** Which actions need a written note (mirrors the RPC). */
export const NOTE_REQUIRED_ACTIONS: readonly SubmittalAction[] = ['approve_as_noted', 'revise_resubmit', 'reject', 'void'];

const TRANSITIONS: Record<SubmittalStatus, Partial<Record<SubmittalAction, SubmittalStatus>>> = {
  draft: { submit: 'submitted', void: 'void' },
  submitted: { start_review: 'in_review', approve: 'approved', approve_as_noted: 'approved_as_noted', revise_resubmit: 'revise_resubmit', reject: 'rejected', void: 'void' },
  in_review: { approve: 'approved', approve_as_noted: 'approved_as_noted', revise_resubmit: 'revise_resubmit', reject: 'rejected', void: 'void' },
  approved: { void: 'void' },
  approved_as_noted: { void: 'void' },
  revise_resubmit: { new_revision: 'draft', void: 'void' },
  rejected: { new_revision: 'draft', void: 'void' },
  void: {},
};

export function availableActions(status: SubmittalStatus): SubmittalAction[] {
  return Object.keys(TRANSITIONS[status]) as SubmittalAction[];
}

export interface ActionContext {
  action: SubmittalAction;
  status: SubmittalStatus;
  currentRevision: number;
  reviewerName: string | null;
  /** Files with purpose "package" on the current revision. */
  packageCount: number;
  note: string;
}

export type ActionCheck = { ok: true; to: SubmittalStatus } | { ok: false; code: string; message: string };

export function checkAction(ctx: ActionContext): ActionCheck {
  const to = TRANSITIONS[ctx.status][ctx.action];
  if (!to) return { ok: false, code: 'invalid_transition', message: 'That step is not allowed from the current status.' };
  if (ctx.action === 'submit') {
    if (!ctx.reviewerName || !ctx.reviewerName.trim()) return { ok: false, code: 'reviewer_required', message: 'Add a reviewer before submitting.' };
    if (ctx.packageCount < 1) return { ok: false, code: 'attachment_required', message: 'Attach at least one file to this revision before submitting.' };
  }
  if (ctx.action === 'new_revision' && ctx.currentRevision >= MAX_REVISION) {
    return { ok: false, code: 'revision_limit', message: 'This submittal reached the maximum number of revisions.' };
  }
  if (NOTE_REQUIRED_ACTIONS.includes(ctx.action) && ctx.note.trim().length < MIN_NOTE_LENGTH) {
    return { ok: false, code: 'note_required', message: 'Add a short note (at least 3 characters) for this action.' };
  }
  return { ok: true, to };
}

// ------------------------------------------------------------------
// Numbering & spec sections
// ------------------------------------------------------------------

export const formatSubmittalNumber = (seq: number): string => `SUB-${String(seq).padStart(3, '0')}`;
export const formatRevision = (n: number): string => `Rev ${n}`;

const SPEC_RE = /^\d{2}( \d{2}){0,2}(\.\d{1,2})?$/;

export function isValidSpecSection(value: string): boolean {
  return SPEC_RE.test(value);
}

/**
 * "230500" → "23 05 00", "23 05" → "23 05", "23-05-00.13" → "23 05 00.13".
 * Returns null when it cannot be a CSI MasterFormat section (2–6 digits, optional .NN).
 */
export function normalizeSpecSection(input: string): string | null {
  const [main, dec, ...rest] = input.trim().split('.');
  if (rest.length > 0) return null;
  const digits = main.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits) || digits.length % 2 !== 0 || digits.length < 2 || digits.length > 6) return null;
  const groups = digits.match(/\d{2}/g) as string[];
  let out = groups.join(' ');
  if (dec !== undefined) {
    if (!/^\d{1,2}$/.test(dec)) return null;
    out += `.${dec}`;
  }
  return isValidSpecSection(out) ? out : null;
}

/** Natural order: spec section (numeric groups), then sequence. */
export function compareSubmittals(a: Pick<Submittal, 'spec_section' | 'seq'>, b: Pick<Submittal, 'spec_section' | 'seq'>): number {
  const pa = a.spec_section.replace('.', ' ').split(' ').map(Number);
  const pb = b.spec_section.replace('.', ' ').split(' ').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d !== 0) return d;
  }
  return a.seq - b.seq;
}

// ------------------------------------------------------------------
// Ball in court, overdue, summary
// ------------------------------------------------------------------

export type BallInCourt = 'us' | 'reviewer' | 'none';

export function ballInCourt(status: SubmittalStatus): BallInCourt {
  if (status === 'draft' || status === 'revise_resubmit' || status === 'rejected') return 'us';
  if (status === 'submitted' || status === 'in_review') return 'reviewer';
  return 'none';
}

export function isClosedOut(status: SubmittalStatus): boolean {
  return status === 'approved' || status === 'approved_as_noted' || status === 'void';
}

export function isOverdue(s: Pick<Submittal, 'status' | 'due_date'>, today: string): boolean {
  return !isClosedOut(s.status) && s.due_date !== null && s.due_date < today;
}

export interface SubmittalSummary {
  total: number;
  /** Everything except void. */
  active: number;
  awaitingReview: number;
  needsAction: number;
  approved: number;
  overdue: number;
  /** Approved (incl. as noted) ÷ active, 0–100. */
  approvedPercent: number;
}

export function summarizeSubmittals(list: Pick<Submittal, 'status' | 'due_date'>[], today: string): SubmittalSummary {
  const live = list.filter((s) => s.status !== 'void');
  const approved = live.filter((s) => s.status === 'approved' || s.status === 'approved_as_noted').length;
  return {
    total: list.length,
    active: live.length,
    awaitingReview: live.filter((s) => ballInCourt(s.status) === 'reviewer').length,
    needsAction: live.filter((s) => ballInCourt(s.status) === 'us').length,
    approved,
    overdue: live.filter((s) => isOverdue(s, today)).length,
    approvedPercent: live.length ? Math.round((approved / live.length) * 100) : 0,
  };
}

// ------------------------------------------------------------------
// Form
// ------------------------------------------------------------------

export interface SubmittalFormValues {
  specSection: string;
  title: string;
  submittalType: SubmittalType;
  reviewerName: string;
  reviewerEmail: string;
  dueDate: string;
  phaseId: string;
  description: string;
}

export const EMPTY_SUBMITTAL_FORM: SubmittalFormValues = {
  specSection: '',
  title: '',
  submittalType: 'product_data',
  reviewerName: '',
  reviewerEmail: '',
  dueDate: '',
  phaseId: '',
  description: '',
};

export type SubmittalFormErrors = Partial<Record<keyof SubmittalFormValues, string>>;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateSubmittalForm(v: SubmittalFormValues): SubmittalFormErrors {
  const e: SubmittalFormErrors = {};
  if (normalizeSpecSection(v.specSection) === null) e.specSection = 'Use a spec section like 23 05 00 (2–6 digits).';
  if (!v.title.trim()) e.title = 'Give the submittal a title.';
  else if (v.title.trim().length > 160) e.title = 'Keep the title under 160 characters.';
  if (v.reviewerName.trim().length > 120) e.reviewerName = 'Keep the name under 120 characters.';
  if (v.reviewerEmail.trim() && !EMAIL_RE.test(v.reviewerEmail.trim())) e.reviewerEmail = 'Enter a valid email address.';
  if (v.description.length > 4000) e.description = 'Keep the description under 4,000 characters.';
  return e;
}
