// Punch lists — pure types, workflow rules and calculations.
//
// No Supabase import on purpose (see punchList.test.ts). Rules mirror
// install_punch_transition() and the guard triggers in the database, which
// stay the source of truth; this module decides which buttons to offer.

export type PunchStatus = 'open' | 'in_progress' | 'ready_for_review' | 'verified' | 'closed';
export type PunchPriority = 'low' | 'normal' | 'high' | 'critical';
export type PunchAction = 'start' | 'mark_fixed' | 'verify' | 'verify_close' | 'reject' | 'close' | 'reopen';

export interface PunchItem {
  id: string;
  user_id: string;
  project_id: string;
  phase_id: string | null;
  seq: number;
  title: string;
  description: string | null;
  location: string;
  priority: PunchPriority;
  status: PunchStatus;
  assignee_id: string | null;
  due_date: string | null;
  fix_note: string | null;
  fixed_at: string | null;
  fixed_by: string | null;
  verified_at: string | null;
  verified_by: string | null;
  closed_at: string | null;
  closed_by: string | null;
  reopen_count: number;
  created_at: string;
  updated_at: string;
}

export const MIN_NOTE_LENGTH = 3;

export const PUNCH_STATUS_LABEL: Record<PunchStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  ready_for_review: 'Ready for review',
  verified: 'Verified',
  closed: 'Closed',
};

export const PUNCH_PRIORITY_LABEL: Record<PunchPriority, string> = { low: 'Low', normal: 'Normal', high: 'High', critical: 'Critical' };
const PRIORITY_RANK: Record<PunchPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };

export const PUNCH_ACTION_LABEL: Record<PunchAction, string> = {
  start: 'Start work',
  mark_fixed: 'Mark fixed',
  verify: 'Verify',
  verify_close: 'Verify & close',
  reject: 'Send back',
  close: 'Close',
  reopen: 'Reopen',
};

export const PUNCH_NOTE_REQUIRED: readonly PunchAction[] = ['reject', 'reopen'];

export interface PunchActor {
  /** Owner, admin/manager or a role with manage-team / billing permission. */
  isReviewer: boolean;
  isAssignee: boolean;
  isAccountOwner: boolean;
  userId: string | null;
}

export interface PunchActionContext {
  action: PunchAction;
  item: Pick<PunchItem, 'status' | 'fixed_by'>;
  actor: PunchActor;
  /** Files with purpose "after" on the item. */
  afterPhotoCount: number;
  note: string;
}

export type PunchCheck = { ok: true; to: PunchStatus } | { ok: false; code: string; message: string };

const TO: Record<PunchAction, PunchStatus> = {
  start: 'in_progress',
  mark_fixed: 'ready_for_review',
  verify: 'verified',
  verify_close: 'closed',
  reject: 'open',
  close: 'closed',
  reopen: 'open',
};

const FROM: Record<PunchAction, PunchStatus[]> = {
  start: ['open'],
  mark_fixed: ['open', 'in_progress'],
  verify: ['ready_for_review'],
  verify_close: ['ready_for_review'],
  reject: ['ready_for_review'],
  close: ['verified'],
  reopen: ['verified', 'closed'],
};

const REVIEWER_ONLY: readonly PunchAction[] = ['verify', 'verify_close', 'reject', 'close', 'reopen'];

export function checkPunchAction(ctx: PunchActionContext): PunchCheck {
  const { action, item, actor } = ctx;
  const denied: PunchCheck = { ok: false, code: 'not_authorized', message: 'You do not have permission to do that.' };
  if (!actor.isReviewer && !actor.isAssignee) return denied;
  if (REVIEWER_ONLY.includes(action) && !actor.isReviewer) return denied;
  if (!FROM[action].includes(item.status)) return { ok: false, code: 'invalid_transition', message: 'That step is not allowed from the current status.' };
  if (action === 'mark_fixed' && ctx.afterPhotoCount < 1) return { ok: false, code: 'after_photo_required', message: 'Add an “After” photo before marking this item fixed.' };
  if ((action === 'verify' || action === 'verify_close') && item.fixed_by !== null && item.fixed_by === actor.userId && !actor.isAccountOwner) {
    return { ok: false, code: 'verifier_must_differ', message: 'Someone other than the person who marked it fixed must verify it.' };
  }
  if (PUNCH_NOTE_REQUIRED.includes(action) && ctx.note.trim().length < MIN_NOTE_LENGTH) {
    return { ok: false, code: 'note_required', message: 'Add a short note (at least 3 characters) for this action.' };
  }
  return { ok: true, to: TO[action] };
}

/** Actions worth showing for a status (permission, photo and four-eyes are then checked with checkPunchAction). */
export function offeredPunchActions(status: PunchStatus): PunchAction[] {
  return (Object.keys(FROM) as PunchAction[]).filter((a) => FROM[a].includes(status));
}

export function isLocked(status: PunchStatus): boolean {
  return status === 'ready_for_review' || status === 'verified' || status === 'closed';
}

// ------------------------------------------------------------------
// Summary, sorting
// ------------------------------------------------------------------

export function isPunchOverdue(i: Pick<PunchItem, 'status' | 'due_date'>, today: string): boolean {
  return i.status !== 'closed' && i.due_date !== null && i.due_date < today;
}

export interface PunchSummary {
  total: number;
  open: number;
  inProgress: number;
  awaitingVerification: number;
  verified: number;
  closed: number;
  overdue: number;
  critical: number;
  /** Items not yet closed. */
  remaining: number;
  /** Closed ÷ total, 0–100 (0 when empty). */
  closedPercent: number;
}

export function summarizePunch(items: Pick<PunchItem, 'status' | 'due_date' | 'priority'>[], today: string): PunchSummary {
  const count = (s: PunchStatus) => items.filter((i) => i.status === s).length;
  const closed = count('closed');
  return {
    total: items.length,
    open: count('open'),
    inProgress: count('in_progress'),
    awaitingVerification: count('ready_for_review'),
    verified: count('verified'),
    closed,
    overdue: items.filter((i) => isPunchOverdue(i, today)).length,
    critical: items.filter((i) => i.status !== 'closed' && i.priority === 'critical').length,
    remaining: items.length - closed,
    closedPercent: items.length ? Math.round((closed / items.length) * 100) : 0,
  };
}

/** Open work first, then priority, due date, sequence. */
export function comparePunch(a: Pick<PunchItem, 'status' | 'priority' | 'due_date' | 'seq'>, b: Pick<PunchItem, 'status' | 'priority' | 'due_date' | 'seq'>): number {
  const closedA = a.status === 'closed' ? 1 : 0;
  const closedB = b.status === 'closed' ? 1 : 0;
  if (closedA !== closedB) return closedA - closedB;
  if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (a.due_date !== b.due_date) {
    if (a.due_date === null) return 1;
    if (b.due_date === null) return -1;
    return a.due_date < b.due_date ? -1 : 1;
  }
  return a.seq - b.seq;
}

export const formatPunchNumber = (seq: number): string => `PL-${String(seq).padStart(3, '0')}`;

// ------------------------------------------------------------------
// Form
// ------------------------------------------------------------------

export interface PunchFormValues {
  title: string;
  location: string;
  priority: PunchPriority;
  assigneeId: string;
  dueDate: string;
  phaseId: string;
  description: string;
}

export const EMPTY_PUNCH_FORM: PunchFormValues = { title: '', location: '', priority: 'normal', assigneeId: '', dueDate: '', phaseId: '', description: '' };

export type PunchFormErrors = Partial<Record<keyof PunchFormValues, string>>;

export function validatePunchForm(v: PunchFormValues): PunchFormErrors {
  const e: PunchFormErrors = {};
  if (!v.title.trim()) e.title = 'Describe the issue in a few words.';
  else if (v.title.trim().length > 160) e.title = 'Keep the title under 160 characters.';
  if (!v.location.trim()) e.location = 'Say where it is (room, area or equipment).';
  else if (v.location.trim().length > 160) e.location = 'Keep the location under 160 characters.';
  if (v.description.length > 4000) e.description = 'Keep the description under 4,000 characters.';
  return e;
}
