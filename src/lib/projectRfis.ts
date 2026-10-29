// Project RFIs + change orders — pure types, lifecycle rules and calculations.
//
// No Supabase import on purpose: everything here is deterministic and unit
// tested (projectRfis.test.ts). Database access lives in projectRfisApi.ts.
// The lifecycle below mirrors the database triggers in
// supabase/migrations/20280105000000_project_rfis.sql — keep them in sync.

import { addDaysIso, daysBetween, dollarsToCents, formatMoney, friendlyError } from '@/lib/installProjects';

export type RfiStatus = 'draft' | 'open' | 'answered' | 'closed' | 'void';
export type RfiDirection = 'outgoing' | 'incoming';
export type RfiPriority = 'low' | 'normal' | 'high' | 'urgent';
export type RfiPartyRole = 'customer' | 'general_contractor' | 'architect' | 'engineer' | 'inspector' | 'supplier' | 'subcontractor' | 'other';
export type RfiAttachmentKind = 'question' | 'answer';
export type ChangeOrderStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'void';

export interface ProjectRfi {
  id: string;
  project_id: string;
  phase_id: string | null;
  change_order_id: string | null;
  rfi_number: string;
  subject: string;
  question: string;
  direction: RfiDirection;
  party_name: string;
  party_role: RfiPartyRole;
  priority: RfiPriority;
  status: RfiStatus;
  due_date: string | null;
  impacts_cost: boolean;
  impacts_schedule: boolean;
  answer: string | null;
  answered_at: string | null;
  sent_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RfiAttachment {
  id: string;
  project_id: string;
  rfi_id: string;
  kind: RfiAttachmentKind;
  file_name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number;
  created_at: string;
}

export interface ChangeOrder {
  id: string;
  project_id: string;
  co_number: string;
  title: string;
  description: string | null;
  amount_cents: number;
  schedule_days: number;
  status: ChangeOrderStatus;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

// ------------------------------------------------------------------
// Labels
// ------------------------------------------------------------------

export const RFI_STATUS_LABEL: Record<RfiStatus, string> = { draft: 'Draft', open: 'Open', answered: 'Answered', closed: 'Closed', void: 'Void' };

/** Status wording that reads naturally for who owes the next move. */
export function rfiStatusLabel(status: RfiStatus, direction: RfiDirection): string {
  if (status === 'open') return direction === 'incoming' ? 'Needs our response' : 'Awaiting response';
  return RFI_STATUS_LABEL[status];
}

export const RFI_DIRECTION_LABEL: Record<RfiDirection, string> = { outgoing: 'Sent to', incoming: 'Received from' };
export const RFI_PRIORITY_LABEL: Record<RfiPriority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export const RFI_PARTY_ROLE_LABEL: Record<RfiPartyRole, string> = {
  customer: 'Customer',
  general_contractor: 'General contractor',
  architect: 'Architect',
  engineer: 'Engineer',
  inspector: 'Inspector',
  supplier: 'Supplier',
  subcontractor: 'Subcontractor',
  other: 'Other',
};
export const CHANGE_ORDER_STATUS_LABEL: Record<ChangeOrderStatus, string> = { draft: 'Draft', pending: 'Pending approval', approved: 'Approved', rejected: 'Rejected', void: 'Void' };

export const RFI_PRIORITIES: RfiPriority[] = ['low', 'normal', 'high', 'urgent'];
export const RFI_PARTY_ROLES = Object.keys(RFI_PARTY_ROLE_LABEL) as RfiPartyRole[];

export type RfiTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export const RFI_STATUS_TONE: Record<RfiStatus, RfiTone> = { draft: 'neutral', open: 'info', answered: 'success', closed: 'neutral', void: 'neutral' };
export const RFI_PRIORITY_TONE: Record<RfiPriority, RfiTone> = { low: 'neutral', normal: 'neutral', high: 'warning', urgent: 'danger' };
export const CHANGE_ORDER_TONE: Record<ChangeOrderStatus, RfiTone> = { draft: 'neutral', pending: 'warning', approved: 'success', rejected: 'danger', void: 'neutral' };

// ------------------------------------------------------------------
// Lifecycle (mirrors rfi_status_transition_ok / change_order_status_transition_ok)
// ------------------------------------------------------------------

export const RFI_TRANSITIONS: Record<RfiStatus, RfiStatus[]> = {
  draft: ['open', 'void'],
  open: ['answered', 'void'],
  answered: ['closed', 'open', 'void'],
  closed: ['open'],
  void: [],
};

export const CHANGE_ORDER_TRANSITIONS: Record<ChangeOrderStatus, ChangeOrderStatus[]> = {
  draft: ['pending', 'void'],
  pending: ['approved', 'rejected', 'draft', 'void'],
  approved: ['void'],
  rejected: ['draft', 'void'],
  void: [],
};

export const canTransitionRfi = (from: RfiStatus, to: RfiStatus): boolean => from === to || RFI_TRANSITIONS[from].includes(to);
export const canTransitionChangeOrder = (from: ChangeOrderStatus, to: ChangeOrderStatus): boolean => from === to || CHANGE_ORDER_TRANSITIONS[from].includes(to);

/** Question text, parties and dates can only be edited before an answer exists. */
export const isRfiContentEditable = (status: RfiStatus): boolean => status === 'draft' || status === 'open';
/** Closed and void RFIs are read-only records (answer and links frozen too). */
export const isRfiLocked = (status: RfiStatus): boolean => status === 'closed' || status === 'void';
/** Only unused records can be deleted; everything else is voided and kept. */
export const canDeleteRfi = (status: RfiStatus): boolean => status === 'draft' || status === 'void';
export const canDeleteChangeOrder = (status: ChangeOrderStatus): boolean => status === 'draft' || status === 'rejected' || status === 'void';
/** Linking is only offered to change orders that can still carry work. */
export const isChangeOrderLinkable = (status: ChangeOrderStatus): boolean => status !== 'void';

// ------------------------------------------------------------------
// Overdue / due state — derived from today's date, never stored
// ------------------------------------------------------------------

export type RfiDueState = 'none' | 'on_track' | 'due_soon' | 'overdue' | 'resolved';

type DueFields = Pick<ProjectRfi, 'status' | 'due_date'>;

/** Whole days past due. Only an OPEN RFI with a due date before today is overdue. */
export function rfiDaysOverdue(rfi: DueFields, today: string): number {
  if (rfi.status !== 'open' || !rfi.due_date) return 0;
  return Math.max(0, daysBetween(rfi.due_date, today));
}

export const isRfiOverdue = (rfi: DueFields, today: string): boolean => rfiDaysOverdue(rfi, today) > 0;

export function rfiDueState(rfi: DueFields, today: string, soonDays = 2): RfiDueState {
  if (rfi.status === 'answered' || rfi.status === 'closed' || rfi.status === 'void') return 'resolved';
  if (rfi.status === 'draft' || !rfi.due_date) return 'none';
  const left = daysBetween(today, rfi.due_date);
  if (left < 0) return 'overdue';
  return left <= soonDays ? 'due_soon' : 'on_track';
}

/** "3 days overdue", "due today", "due in 2 days", "no due date". */
export function rfiDueText(rfi: DueFields, today: string): string {
  const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  if (rfi.status !== 'open') return rfi.due_date ? '' : 'No due date';
  if (!rfi.due_date) return 'No due date';
  const left = daysBetween(today, rfi.due_date);
  if (left < 0) return `${plural(-left)} overdue`;
  return left === 0 ? 'Due today' : `Due in ${plural(left)}`;
}

// ------------------------------------------------------------------
// Summary, filtering and ordering
// ------------------------------------------------------------------

export interface RfiSummary {
  total: number;
  draft: number;
  open: number;
  answered: number;
  closed: number;
  voided: number;
  overdue: number;
  dueSoon: number;
  oldestOverdueDays: number;
  awaitingUs: number;
  awaitingThem: number;
  costImpacting: number;
  avgResponseDays: number | null;
}

const DAY_MS = 86_400_000;

export function rfiSummary(rfis: ProjectRfi[], today: string): RfiSummary {
  const s: RfiSummary = { total: rfis.length, draft: 0, open: 0, answered: 0, closed: 0, voided: 0, overdue: 0, dueSoon: 0, oldestOverdueDays: 0, awaitingUs: 0, awaitingThem: 0, costImpacting: 0, avgResponseDays: null };
  let responseSum = 0;
  let responseN = 0;
  for (const r of rfis) {
    if (r.status === 'void') { s.voided++; continue; }
    s[r.status]++;
    if (r.status === 'open') {
      if (r.direction === 'incoming') s.awaitingUs++; else s.awaitingThem++;
      const late = rfiDaysOverdue(r, today);
      if (late > 0) { s.overdue++; s.oldestOverdueDays = Math.max(s.oldestOverdueDays, late); }
      else if (rfiDueState(r, today) === 'due_soon') s.dueSoon++;
    }
    if ((r.status === 'open' || r.status === 'answered') && r.impacts_cost) s.costImpacting++;
    if (r.answered_at) {
      const from = Date.parse(r.sent_at ?? r.created_at);
      const to = Date.parse(r.answered_at);
      if (Number.isFinite(from) && Number.isFinite(to) && to >= from) { responseSum += (to - from) / DAY_MS; responseN++; }
    }
  }
  if (responseN > 0) s.avgResponseDays = Math.round((responseSum / responseN) * 10) / 10;
  return s;
}

/** What the project Overview surfaces: overdue first (worst first), then due soon. */
export function rfiAttention(rfis: ProjectRfi[], today: string): { overdue: ProjectRfi[]; dueSoon: ProjectRfi[]; awaitingUs: number } {
  const open = rfis.filter((r) => r.status === 'open');
  return {
    overdue: open.filter((r) => isRfiOverdue(r, today)).sort((a, b) => rfiDaysOverdue(b, today) - rfiDaysOverdue(a, today) || a.rfi_number.localeCompare(b.rfi_number)),
    dueSoon: open.filter((r) => rfiDueState(r, today) === 'due_soon').sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '')),
    awaitingUs: open.filter((r) => r.direction === 'incoming').length,
  };
}

export type RfiFilter = 'all' | 'open' | 'overdue' | 'answered' | 'closed' | 'draft';
export const RFI_FILTERS: { key: RfiFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'answered', label: 'Answered' },
  { key: 'closed', label: 'Closed' },
  { key: 'draft', label: 'Drafts' },
];

export function filterRfis(rfis: ProjectRfi[], filter: RfiFilter, query: string, today: string): ProjectRfi[] {
  const q = query.trim().toLowerCase();
  return rfis.filter((r) => {
    if (filter === 'overdue' ? !isRfiOverdue(r, today) : filter !== 'all' && r.status !== filter) return false;
    return !q || `${r.rfi_number} ${r.subject} ${r.party_name} ${r.question}`.toLowerCase().includes(q);
  });
}

function rank(r: ProjectRfi, today: string): number {
  if (isRfiOverdue(r, today)) return 0;
  return { open: 1, draft: 2, answered: 3, closed: 4, void: 5 }[r.status];
}

/** Overdue → open (soonest due first) → draft → answered → closed → void. */
export function sortRfis(rfis: ProjectRfi[], today: string): ProjectRfi[] {
  return [...rfis].sort((a, b) => {
    const ra = rank(a, today);
    const rb = rank(b, today);
    if (ra !== rb) return ra - rb;
    if (ra <= 1) {
      const d = (a.due_date ?? '9999-12-31').localeCompare(b.due_date ?? '9999-12-31');
      if (d !== 0) return d;
    }
    return b.created_at.localeCompare(a.created_at) || b.rfi_number.localeCompare(a.rfi_number);
  });
}

// ------------------------------------------------------------------
// Forms
// ------------------------------------------------------------------

export const RFI_SUBJECT_MAX = 160;
export const RFI_TEXT_MAX = 5000;
export const RFI_PARTY_MAX = 120;
export const DEFAULT_RFI_TURNAROUND_DAYS = 7;

export interface RfiFormValues {
  subject: string;
  question: string;
  direction: RfiDirection;
  partyName: string;
  partyRole: RfiPartyRole;
  priority: RfiPriority;
  dueDate: string;
  phaseId: string;
  impactsCost: boolean;
  impactsSchedule: boolean;
}

export const emptyRfiForm = (today: string): RfiFormValues => ({
  subject: '',
  question: '',
  direction: 'outgoing',
  partyName: '',
  partyRole: 'other',
  priority: 'normal',
  dueDate: addDaysIso(today, DEFAULT_RFI_TURNAROUND_DAYS),
  phaseId: '',
  impactsCost: false,
  impactsSchedule: false,
});

export type RfiFormErrors = Partial<Record<keyof RfiFormValues, string>>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateRfiForm(v: RfiFormValues): RfiFormErrors {
  const e: RfiFormErrors = {};
  const subject = v.subject.trim();
  const question = v.question.trim();
  const party = v.partyName.trim();
  if (!subject) e.subject = 'Add a short subject.';
  else if (subject.length > RFI_SUBJECT_MAX) e.subject = `Keep the subject under ${RFI_SUBJECT_MAX} characters.`;
  if (!question) e.question = 'Write the question.';
  else if (question.length > RFI_TEXT_MAX) e.question = `Keep the question under ${RFI_TEXT_MAX} characters.`;
  if (!party) e.partyName = v.direction === 'incoming' ? 'Who sent this RFI?' : 'Who is this RFI for?';
  else if (party.length > RFI_PARTY_MAX) e.partyName = `Keep the name under ${RFI_PARTY_MAX} characters.`;
  if (v.dueDate && (!ISO_DATE.test(v.dueDate) || Number.isNaN(Date.parse(v.dueDate)))) e.dueDate = 'Enter a valid date.';
  return e;
}

/** null when the answer is acceptable, otherwise the message to show. */
export function validateAnswer(answer: string): string | null {
  const text = answer.trim();
  if (!text) return 'Write the answer before recording it.';
  if (text.length > RFI_TEXT_MAX) return `Keep the answer under ${RFI_TEXT_MAX} characters.`;
  return null;
}

export interface ChangeOrderFormValues {
  title: string;
  description: string;
  amount: string;
  scheduleDays: string;
}

export const emptyChangeOrderForm = (title = ''): ChangeOrderFormValues => ({ title, description: '', amount: '', scheduleDays: '0' });

/** "1,200.50", "-$300", "(300)" → cents. Credits are negative. '' → 0. Invalid → null. */
export function parseSignedDollars(input: string): number | null {
  const raw = input.trim();
  const negative = raw.startsWith('-') || (raw.startsWith('(') && raw.endsWith(')'));
  const cents = dollarsToCents(raw.replace(/^[-(]+/, '').replace(/\)$/, ''));
  if (cents === null) return null;
  return negative && cents > 0 ? -cents : cents;
}

export const formatSignedMoney = (cents: number): string => `${cents > 0 ? '+' : ''}${formatMoney(cents)}`;

export function parseScheduleDays(input: string): number | null {
  const raw = input.trim();
  if (raw === '') return 0;
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= -365 && n <= 3650 ? n : null;
}

export type ChangeOrderFormErrors = Partial<Record<keyof ChangeOrderFormValues, string>>;

export function validateChangeOrderForm(v: ChangeOrderFormValues): ChangeOrderFormErrors {
  const e: ChangeOrderFormErrors = {};
  const title = v.title.trim();
  if (!title) e.title = 'Add a title.';
  else if (title.length > RFI_SUBJECT_MAX) e.title = `Keep the title under ${RFI_SUBJECT_MAX} characters.`;
  if (v.description.length > RFI_TEXT_MAX) e.description = `Keep the description under ${RFI_TEXT_MAX} characters.`;
  if (parseSignedDollars(v.amount) === null) e.amount = 'Enter an amount like 1,250.00 (use - for a credit).';
  if (parseScheduleDays(v.scheduleDays) === null) e.scheduleDays = 'Enter whole days between -365 and 3650.';
  return e;
}

export interface ChangeOrderSummary {
  approvedCents: number;
  approvedDays: number;
  approvedCount: number;
  pendingCents: number;
  pendingCount: number;
}

/** Money and days approved vs. still waiting on a decision (draft, rejected and void never count). */
export function changeOrderSummary(cos: ChangeOrder[]): ChangeOrderSummary {
  const s: ChangeOrderSummary = { approvedCents: 0, approvedDays: 0, approvedCount: 0, pendingCents: 0, pendingCount: 0 };
  for (const c of cos) {
    if (c.status === 'approved') { s.approvedCents += c.amount_cents; s.approvedDays += c.schedule_days; s.approvedCount++; }
    else if (c.status === 'pending') { s.pendingCents += c.amount_cents; s.pendingCount++; }
  }
  return s;
}

// ------------------------------------------------------------------
// Attachments (mirror the project-rfi-files bucket limits)
// ------------------------------------------------------------------

export const RFI_ATTACHMENT_BUCKET = 'project-rfi-files';
export const RFI_ATTACHMENT_MAX_BYTES = 26_214_400;
export const RFI_ATTACHMENT_MAX_COUNT = 20;
export const RFI_ATTACHMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.txt,.docx,.xlsx';

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const ALLOWED_MIME = new Set(Object.values(MIME_BY_EXT));

/** Browsers often send '' for .heic/.docx — fall back to the extension. null = not allowed. */
export function inferAttachmentMime(name: string, type: string): string | null {
  const base = type.split(';')[0].trim().toLowerCase();
  if (ALLOWED_MIME.has(base)) return base;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? null;
}

export function validateAttachmentFile(file: { name: string; size: number; type: string }, existingCount: number): string | null {
  if (existingCount >= RFI_ATTACHMENT_MAX_COUNT) return `An RFI can hold up to ${RFI_ATTACHMENT_MAX_COUNT} files.`;
  if (file.size <= 0) return `${file.name} is empty.`;
  if (file.size > RFI_ATTACHMENT_MAX_BYTES) return `${file.name} is larger than ${formatFileSize(RFI_ATTACHMENT_MAX_BYTES)}.`;
  if (!inferAttachmentMime(file.name, file.type)) return `${file.name}: use PDF, image, Word, Excel or text files.`;
  return null;
}

export function safeFileName(fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() : '';
  const stem = (dot > 0 ? name.slice(0, dot) : name).normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return `${stem || 'file'}${ext ? `.${ext}` : ''}`;
}

/** <owner>/<project>/<rfi>/<uuid>-<safe name> — the database rejects any other shape. */
export const buildAttachmentPath = (ownerId: string, projectId: string, rfiId: string, fileName: string, uuid: string): string =>
  `${ownerId}/${projectId}/${rfiId}/${uuid}-${safeFileName(fileName)}`;

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

// ------------------------------------------------------------------
// Links and errors
// ------------------------------------------------------------------

/** Same shape the database writes into notifications.action_url. */
export const rfiDeepLink = (projectId: string, rfiId: string): string => `/dashboard/projects/${projectId}?tab=rfis&rfi=${rfiId}`;

const RFI_ERROR_COPY: Record<string, string> = {
  rfi_locked: 'This RFI is closed or void, so it can no longer be edited.',
  invalid_rfi_transition: 'That status change is not allowed from the current status.',
  invalid_rfi_status: 'A new RFI can only start as a draft or open.',
  answer_required: 'Write the answer before recording it.',
  invalid_rfi: 'That RFI could not be found.',
  invalid_change_order: 'That change order is not on this project or has been voided.',
  invalid_change_order_status: 'A new change order can only start as a draft or pending.',
  invalid_change_order_transition: 'That change order status change is not allowed.',
  change_order_locked: 'This change order is decided, so its details can no longer be edited.',
  too_many_attachments: `An RFI can hold up to ${RFI_ATTACHMENT_MAX_COUNT} files.`,
  invalid_attachment_path: 'That file could not be attached to this RFI.',
  project_cancelled: 'This project is cancelled.',
};

export function rfiError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : '';
  for (const key of Object.keys(RFI_ERROR_COPY)) if (message.includes(key)) return RFI_ERROR_COPY[key];
  if (/mime type/i.test(message)) return 'That file type is not allowed. Use PDF, image, Word, Excel or text files.';
  if (/maximum allowed size|payload too large|too large/i.test(message)) return `That file is larger than ${formatFileSize(RFI_ATTACHMENT_MAX_BYTES)}.`;
  return friendlyError(error, fallback);
}
