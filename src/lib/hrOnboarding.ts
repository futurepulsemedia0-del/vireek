/**
 * Employee onboarding & HR basics — pure logic for /dashboard/hr.
 *
 * Framework-free and timezone-safe: calendar days are plain "YYYY-MM-DD" strings manipulated only through UTC
 * arithmetic, so a due date never shifts with the viewer's timezone. "Today" is always passed in, never read
 * implicitly, so every rule is deterministic and testable.
 *
 * The database is the authority (supabase/migrations/20271021000000_hr_onboarding.sql): owner-only RLS, the
 * atomic start-onboarding RPC, the auto-completion triggers and the rating checks. This file mirrors those rules
 * so the UI can validate and explain before a request is sent, and never trusts a row it has not normalized.
 */

// ---------------------------------------------------------------------------
// Types, labels, limits
// ---------------------------------------------------------------------------

export type HrCategory = 'paperwork' | 'tools' | 'uniform' | 'vehicle' | 'training' | 'other';
export const HR_CATEGORIES: readonly HrCategory[] = ['paperwork', 'tools', 'uniform', 'vehicle', 'training', 'other'];
export const CATEGORY_LABELS: Record<HrCategory, string> = {
  paperwork: 'Paperwork',
  tools: 'Tools & accounts',
  uniform: 'Uniform & gear',
  vehicle: 'Vehicle',
  training: 'Training',
  other: 'Other',
};

export type TaskStatus = 'pending' | 'done' | 'skipped';
export type OnboardingStatus = 'active' | 'completed' | 'cancelled';

export type DocType = 'w4' | 'i9' | 'direct_deposit' | 'license' | 'insurance' | 'certification' | 'contract' | 'handbook_ack' | 'other';
export const DOC_TYPES: readonly DocType[] = ['w4', 'i9', 'direct_deposit', 'license', 'insurance', 'certification', 'contract', 'handbook_ack', 'other'];
export const DOC_TYPE_LABELS: Record<DocType, string> = {
  w4: 'W-4 tax form',
  i9: 'I-9 work eligibility',
  direct_deposit: 'Direct deposit form',
  license: 'Driver’s licence',
  insurance: 'Insurance',
  certification: 'Certification / trade licence',
  contract: 'Offer letter / contract',
  handbook_ack: 'Handbook acknowledgement',
  other: 'Other document',
};
export type DocStatus = 'requested' | 'received' | 'verified';

export type ReviewKind = 'day_30' | 'day_60' | 'day_90' | 'annual' | 'ad_hoc';
export const REVIEW_KINDS: readonly ReviewKind[] = ['day_30', 'day_60', 'day_90', 'annual', 'ad_hoc'];
export const SCHEDULABLE_REVIEW_KINDS: readonly ReviewKind[] = ['annual', 'ad_hoc'];
export const REVIEW_KIND_LABELS: Record<ReviewKind, string> = {
  day_30: '30-day review',
  day_60: '60-day review',
  day_90: '90-day review',
  annual: 'Annual review',
  ad_hoc: 'Performance check-in',
};
export const MILESTONE_OFFSETS: Record<'day_30' | 'day_60' | 'day_90', number> = { day_30: 30, day_60: 60, day_90: 90 };
export type ReviewStatus = 'scheduled' | 'completed' | 'skipped';

export type Competency = 'quality' | 'reliability' | 'customer_service' | 'teamwork' | 'safety' | 'initiative';
export const COMPETENCIES: readonly { key: Competency; label: string }[] = [
  { key: 'quality', label: 'Quality of work' },
  { key: 'reliability', label: 'Reliability & punctuality' },
  { key: 'customer_service', label: 'Customer service' },
  { key: 'teamwork', label: 'Teamwork & communication' },
  { key: 'safety', label: 'Safety & compliance' },
  { key: 'initiative', label: 'Initiative & growth' },
];
export const RATING_LABELS: Record<number, string> = { 1: 'Needs improvement', 2: 'Below expectations', 3: 'Meets expectations', 4: 'Exceeds expectations', 5: 'Outstanding' };

export const TITLE_LIMIT = 120;
export const SHORT_TEXT_LIMIT = 500;
export const NOTE_LIMIT = 1000;
export const REVIEW_TEXT_LIMIT = 2000;
export const REVIEW_NOTES_LIMIT = 4000;
export const MAX_OFFSET_DAYS = 365;
export const START_DATE_WINDOW_DAYS = 366;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MIME_TYPES: readonly string[] = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic'];
export const REMINDER_WINDOW_DAYS = 7;
export const DOC_EXPIRY_WARNING_DAYS = 30;
export const DUE_SOON_DAYS = 3;

export interface EmployeeLite {
  id: string;
  full_name: string;
  active: boolean;
}

export interface TemplateItem {
  id: string;
  template_id: string;
  title: string;
  description: string | null;
  category: HrCategory;
  due_offset_days: number;
  required: boolean;
  document_type: DocType | null;
  sort_order: number;
}

export interface Template {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  items: TemplateItem[];
}

export interface Onboarding {
  id: string;
  employee_id: string;
  template_id: string | null;
  template_name: string | null;
  start_date: string;
  status: OnboardingStatus;
  completed_at: string | null;
  created_at: string;
}

export interface OnboardingTask {
  id: string;
  onboarding_id: string;
  employee_id: string;
  title: string;
  description: string | null;
  category: HrCategory;
  due_date: string | null;
  required: boolean;
  status: TaskStatus;
  completed_at: string | null;
  notes: string | null;
  document_type: DocType | null;
  sort_order: number;
}

export interface HrDocument {
  id: string;
  employee_id: string;
  onboarding_id: string | null;
  task_id: string | null;
  doc_type: DocType;
  title: string;
  status: DocStatus;
  expires_on: string | null;
  storage_path: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  notes: string | null;
  received_at: string | null;
  verified_at: string | null;
  created_at: string;
}

export type Ratings = Partial<Record<Competency, number>>;

export interface Review {
  id: string;
  employee_id: string;
  onboarding_id: string | null;
  kind: ReviewKind;
  due_date: string;
  status: ReviewStatus;
  reviewed_on: string | null;
  overall_rating: number | null;
  ratings: Ratings;
  strengths: string | null;
  improvements: string | null;
  goals: string | null;
  notes: string | null;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Dates (UTC arithmetic on YYYY-MM-DD strings)
// ---------------------------------------------------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function diffDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function localIsoDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function formatDay(iso: string | null | undefined, options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }): string {
  if (!iso || !isValidIsoDate(iso)) return '—';
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
}

/** "in 3 days", "today", "2 days overdue". */
export function relativeDays(iso: string, today: string): string {
  const n = diffDays(today, iso);
  if (n === 0) return 'today';
  if (n > 0) return `in ${n} day${n === 1 ? '' : 's'}`;
  return `${-n} day${n === -1 ? '' : 's'} overdue`;
}

// ---------------------------------------------------------------------------
// Normalizers — never trust a row that came over the wire
// ---------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null);
const day = (v: unknown): string | null => (isValidIsoDate(v) ? v : null);

export function normalizeList<T>(rows: unknown, normalize: (row: unknown) => T | null): T[] {
  return (Array.isArray(rows) ? rows : []).flatMap((r) => {
    const n = normalize(r);
    return n ? [n] : [];
  });
}

export function normalizeEmployee(row: unknown): EmployeeLite | null {
  const r = row as Record<string, unknown> | null;
  const id = nonEmpty(r?.id);
  if (!id) return null;
  return { id, full_name: nonEmpty(r?.full_name) ?? 'Unnamed employee', active: r?.active !== false };
}

export function normalizeTemplateItem(row: unknown): TemplateItem | null {
  const r = row as Record<string, unknown> | null;
  const id = nonEmpty(r?.id);
  const template_id = nonEmpty(r?.template_id);
  const title = nonEmpty(r?.title);
  if (!id || !template_id || !title) return null;
  return {
    id,
    template_id,
    title,
    description: str(r?.description),
    category: oneOf(r?.category, HR_CATEGORIES) ?? 'other',
    due_offset_days: Math.min(MAX_OFFSET_DAYS, Math.max(0, Math.trunc(num(r?.due_offset_days) ?? 0))),
    required: r?.required !== false,
    document_type: oneOf(r?.document_type, DOC_TYPES),
    sort_order: Math.trunc(num(r?.sort_order) ?? 0),
  };
}

export function normalizeTemplate(row: unknown, items: TemplateItem[] = []): Template | null {
  const r = row as Record<string, unknown> | null;
  const id = nonEmpty(r?.id);
  const name = nonEmpty(r?.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    description: str(r?.description),
    active: r?.active !== false,
    items: items.filter((i) => i.template_id === id).sort(compareItems),
  };
}

export function normalizeOnboarding(row: unknown): Onboarding | null {
  const r = row as Record<string, unknown> | null;
  const id = nonEmpty(r?.id);
  const employee_id = nonEmpty(r?.employee_id);
  const start_date = day(r?.start_date);
  if (!id || !employee_id || !start_date) return null;
  return {
    id,
    employee_id,
    template_id: nonEmpty(r?.template_id),
    template_name: str(r?.template_name),
    start_date,
    status: oneOf(r?.status, ['active', 'completed', 'cancelled'] as const) ?? 'active',
    completed_at: str(r?.completed_at),
    created_at: str(r?.created_at) ?? '',
  };
}

export function normalizeTask(row: unknown): OnboardingTask | null {
  const r = row as Record<string, unknown> | null;
  const id = nonEmpty(r?.id);
  const onboarding_id = nonEmpty(r?.onboarding_id);
  const employee_id = nonEmpty(r?.employee_id);
  const title = nonEmpty(r?.title);
  if (!id || !onboarding_id || !employee_id || !title) return null;
  return {
    id,
    onboarding_id,
    employee_id,
    title,
    description: str(r?.description),
    category: oneOf(r?.category, HR_CATEGORIES) ?? 'other',
    due_date: day(r?.due_date),
    required: r?.required !== false,
    status: oneOf(r?.status, ['pending', 'done', 'skipped'] as const) ?? 'pending',
    completed_at: str(r?.completed_at),
    notes: str(r?.notes),
    document_type: oneOf(r?.document_type, DOC_TYPES),
    sort_order: Math.trunc(num(r?.sort_order) ?? 0),
  };
}

export function normalizeDocument(row: unknown): HrDocument | null {
  const r = row as Record<string, unknown> | null;
  const id = nonEmpty(r?.id);
  const employee_id = nonEmpty(r?.employee_id);
  const title = nonEmpty(r?.title);
  if (!id || !employee_id || !title) return null;
  return {
    id,
    employee_id,
    onboarding_id: nonEmpty(r?.onboarding_id),
    task_id: nonEmpty(r?.task_id),
    doc_type: oneOf(r?.doc_type, DOC_TYPES) ?? 'other',
    title,
    status: oneOf(r?.status, ['requested', 'received', 'verified'] as const) ?? 'requested',
    expires_on: day(r?.expires_on),
    storage_path: nonEmpty(r?.storage_path),
    file_name: str(r?.file_name),
    mime_type: str(r?.mime_type),
    size_bytes: num(r?.size_bytes),
    notes: str(r?.notes),
    received_at: str(r?.received_at),
    verified_at: str(r?.verified_at),
    created_at: str(r?.created_at) ?? '',
  };
}

export function normalizeRatings(value: unknown): Ratings {
  const out: Ratings = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const { key } of COMPETENCIES) {
    const n = (value as Record<string, unknown>)[key];
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5) out[key] = n;
  }
  return out;
}

export function normalizeReview(row: unknown): Review | null {
  const r = row as Record<string, unknown> | null;
  const id = nonEmpty(r?.id);
  const employee_id = nonEmpty(r?.employee_id);
  const kind = oneOf(r?.kind, REVIEW_KINDS);
  const due_date = day(r?.due_date);
  if (!id || !employee_id || !kind || !due_date) return null;
  const rating = num(r?.overall_rating);
  return {
    id,
    employee_id,
    onboarding_id: nonEmpty(r?.onboarding_id),
    kind,
    due_date,
    status: oneOf(r?.status, ['scheduled', 'completed', 'skipped'] as const) ?? 'scheduled',
    reviewed_on: day(r?.reviewed_on),
    overall_rating: rating !== null && Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
    ratings: normalizeRatings(r?.ratings),
    strengths: str(r?.strengths),
    improvements: str(r?.improvements),
    goals: str(r?.goals),
    notes: str(r?.notes),
    completed_at: str(r?.completed_at),
  };
}

// ---------------------------------------------------------------------------
// Tasks & onboarding progress
// ---------------------------------------------------------------------------

export function compareItems(a: { sort_order: number; title: string }, b: { sort_order: number; title: string }): number {
  return a.sort_order - b.sort_order || a.title.localeCompare(b.title);
}

export type TaskDueState = 'done' | 'skipped' | 'no_date' | 'overdue' | 'due_today' | 'due_soon' | 'upcoming';

export function taskDueState(task: Pick<OnboardingTask, 'status' | 'due_date'>, today: string): TaskDueState {
  if (task.status === 'done') return 'done';
  if (task.status === 'skipped') return 'skipped';
  if (!task.due_date) return 'no_date';
  const n = diffDays(today, task.due_date);
  if (n < 0) return 'overdue';
  if (n === 0) return 'due_today';
  return n <= DUE_SOON_DAYS ? 'due_soon' : 'upcoming';
}

export interface OnboardingProgress {
  total: number;
  done: number;
  skipped: number;
  pending: number;
  requiredPending: number;
  overdue: number;
  percent: number;
  complete: boolean;
}

/** Done + skipped both count as "handled"; the onboarding is complete when no REQUIRED task is pending (same rule as the DB trigger). */
export function onboardingProgress(tasks: readonly OnboardingTask[], today: string): OnboardingProgress {
  let done = 0;
  let skipped = 0;
  let requiredPending = 0;
  let overdue = 0;
  for (const t of tasks) {
    if (t.status === 'done') done++;
    else if (t.status === 'skipped') skipped++;
    else {
      if (t.required) requiredPending++;
      if (taskDueState(t, today) === 'overdue') overdue++;
    }
  }
  const total = tasks.length;
  const pending = total - done - skipped;
  return {
    total,
    done,
    skipped,
    pending,
    requiredPending,
    overdue,
    percent: total === 0 ? 0 : Math.round(((done + skipped) / total) * 100),
    complete: total > 0 && requiredPending === 0,
  };
}

export function groupTasksByCategory(tasks: readonly OnboardingTask[]): { category: HrCategory; tasks: OnboardingTask[] }[] {
  return HR_CATEGORIES.map((category) => ({
    category,
    tasks: tasks
      .filter((t) => t.category === category)
      .sort((a, b) => compareItems(a, b) || (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999')),
  })).filter((g) => g.tasks.length > 0);
}

// ---------------------------------------------------------------------------
// Reviews & reminders
// ---------------------------------------------------------------------------

export function reviewDueDate(startDate: string, kind: 'day_30' | 'day_60' | 'day_90'): string {
  return addDays(startDate, MILESTONE_OFFSETS[kind]);
}

export type ReviewDueState = 'completed' | 'skipped' | 'overdue' | 'due_soon' | 'upcoming';

export function reviewDueState(review: Pick<Review, 'status' | 'due_date'>, today: string): { state: ReviewDueState; days: number } {
  const days = diffDays(today, review.due_date);
  if (review.status === 'completed') return { state: 'completed', days };
  if (review.status === 'skipped') return { state: 'skipped', days };
  if (days < 0) return { state: 'overdue', days };
  return { state: days <= REMINDER_WINDOW_DAYS ? 'due_soon' : 'upcoming', days };
}

/** Scheduled reviews that are overdue or due within the reminder window, most urgent first. */
export function buildReviewReminders(reviews: readonly Review[], today: string, windowDays: number = REMINDER_WINDOW_DAYS): Review[] {
  return reviews
    .filter((r) => r.status === 'scheduled' && diffDays(today, r.due_date) <= windowDays)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
}

export function averageRating(ratings: Ratings): number | null {
  const values = Object.values(ratings).filter((n): n is number => typeof n === 'number');
  if (values.length === 0) return null;
  return Math.round((values.reduce((s, n) => s + n, 0) / values.length) * 10) / 10;
}

/** Suggested overall rating (rounded mean of the competency ratings), 1-5 or null. */
export function suggestOverall(ratings: Ratings): number | null {
  const avg = averageRating(ratings);
  return avg === null ? null : Math.min(5, Math.max(1, Math.round(avg)));
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type DocumentState = 'requested' | 'received' | 'verified' | 'expired' | 'expiring';

export function documentState(doc: Pick<HrDocument, 'status' | 'expires_on'>, today: string): DocumentState {
  if (doc.status === 'requested') return 'requested';
  if (doc.expires_on) {
    const n = diffDays(today, doc.expires_on);
    if (n < 0) return 'expired';
    if (n <= DOC_EXPIRY_WARNING_DAYS) return 'expiring';
  }
  return doc.status;
}

export interface DocumentFileLike {
  name: string;
  size: number;
  type: string;
}

export function validateDocumentFile(file: DocumentFileLike): string | null {
  if (!file.size) return 'This file is empty.';
  if (file.size > MAX_FILE_BYTES) return 'Files can be at most 10 MB.';
  if (!ALLOWED_MIME_TYPES.includes(file.type)) return 'Use a PDF, PNG, JPEG, WebP or HEIC file.';
  return null;
}

/** Storage-safe file name: ASCII letters, digits, dot, dash, underscore; never empty; keeps the extension. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+|_+$/g, '')
    .slice(-80);
  return cleaned || 'document';
}

/** `<owner>/<employee>/<docId>-<name>` — the first folder MUST be the owner id (storage policy). */
export function buildStoragePath(ownerId: string, employeeId: string, docId: string, fileName: string): string {
  return `${ownerId}/${employeeId}/${docId}-${safeFileName(fileName)}`;
}

// ---------------------------------------------------------------------------
// Validation (mirrors the DB checks)
// ---------------------------------------------------------------------------

export type Errors<T> = Partial<Record<keyof T, string>>;

const trimmed = (s: string | null | undefined) => (s ?? '').trim();

function checkText(value: string | null | undefined, label: string, max: number, required = false): string | undefined {
  const v = trimmed(value);
  if (required && v === '') return `${label} is required.`;
  if (v.length > max) return `${label} must be ${max} characters or fewer.`;
  return undefined;
}

function compact<T>(errors: Errors<T>): Errors<T> {
  return Object.fromEntries(Object.entries(errors).filter(([, v]) => v)) as Errors<T>;
}

export interface StartOnboardingDraft {
  employee_id: string;
  template_id: string;
  start_date: string;
}

export function validateStartOnboarding(draft: StartOnboardingDraft, today: string, busyEmployeeIds: ReadonlySet<string> = new Set()): Errors<StartOnboardingDraft> {
  const errors: Errors<StartOnboardingDraft> = {};
  if (!draft.employee_id) errors.employee_id = 'Choose an employee.';
  else if (busyEmployeeIds.has(draft.employee_id)) errors.employee_id = 'This employee already has an active onboarding.';
  if (!draft.template_id) errors.template_id = 'Choose a template.';
  if (!isValidIsoDate(draft.start_date)) errors.start_date = 'Enter a valid start date.';
  else if (Math.abs(diffDays(today, draft.start_date)) > START_DATE_WINDOW_DAYS) errors.start_date = 'The start date must be within a year of today.';
  return compact(errors);
}

export interface TemplateDraft {
  name: string;
  description: string;
}

export function validateTemplate(draft: TemplateDraft, existingNames: readonly string[] = []): Errors<TemplateDraft> {
  const errors: Errors<TemplateDraft> = {
    name: checkText(draft.name, 'Name', 80, true),
    description: checkText(draft.description, 'Description', SHORT_TEXT_LIMIT),
  };
  if (!errors.name && existingNames.some((n) => n.trim().toLowerCase() === trimmed(draft.name).toLowerCase())) errors.name = 'A template with this name already exists.';
  return compact(errors);
}

export interface ChecklistDraft {
  title: string;
  description: string;
  category: HrCategory;
  required: boolean;
  document_type: DocType | '';
}

export interface TemplateItemDraft extends ChecklistDraft {
  due_offset_days: string;
}

export function parseOffset(value: string): number | null {
  const v = value.trim();
  if (!/^\d{1,3}$/.test(v)) return null;
  const n = Number(v);
  return n <= MAX_OFFSET_DAYS ? n : null;
}

export function validateTemplateItem(draft: TemplateItemDraft): Errors<TemplateItemDraft> {
  const errors: Errors<TemplateItemDraft> = {
    title: checkText(draft.title, 'Title', TITLE_LIMIT, true),
    description: checkText(draft.description, 'Description', SHORT_TEXT_LIMIT),
  };
  if (parseOffset(draft.due_offset_days) === null) errors.due_offset_days = `Enter whole days from 0 to ${MAX_OFFSET_DAYS}.`;
  if (!(HR_CATEGORIES as readonly string[]).includes(draft.category)) errors.category = 'Choose a category.';
  return compact(errors);
}

export interface TaskDraft extends ChecklistDraft {
  due_date: string;
}

export function validateTask(draft: TaskDraft): Errors<TaskDraft> {
  const errors: Errors<TaskDraft> = {
    title: checkText(draft.title, 'Title', TITLE_LIMIT, true),
    description: checkText(draft.description, 'Description', SHORT_TEXT_LIMIT),
  };
  if (draft.due_date !== '' && !isValidIsoDate(draft.due_date)) errors.due_date = 'Enter a valid due date.';
  if (!(HR_CATEGORIES as readonly string[]).includes(draft.category)) errors.category = 'Choose a category.';
  return compact(errors);
}

export interface DocumentDraft {
  employee_id: string;
  doc_type: DocType;
  title: string;
  expires_on: string;
  notes: string;
}

export function validateDocument(draft: DocumentDraft): Errors<DocumentDraft> {
  const errors: Errors<DocumentDraft> = {
    title: checkText(draft.title, 'Title', TITLE_LIMIT, true),
    notes: checkText(draft.notes, 'Notes', NOTE_LIMIT),
  };
  if (!draft.employee_id) errors.employee_id = 'Choose an employee.';
  if (!(DOC_TYPES as readonly string[]).includes(draft.doc_type)) errors.doc_type = 'Choose a document type.';
  if (draft.expires_on !== '' && !isValidIsoDate(draft.expires_on)) errors.expires_on = 'Enter a valid expiry date.';
  return compact(errors);
}

export interface ReviewDraft {
  overall_rating: number | null;
  reviewed_on: string;
  ratings: Ratings;
  strengths: string;
  improvements: string;
  goals: string;
  notes: string;
}

export function validateReview(draft: ReviewDraft, today: string): Errors<ReviewDraft> {
  const errors: Errors<ReviewDraft> = {
    strengths: checkText(draft.strengths, 'Strengths', REVIEW_TEXT_LIMIT),
    improvements: checkText(draft.improvements, 'Areas to improve', REVIEW_TEXT_LIMIT),
    goals: checkText(draft.goals, 'Goals', REVIEW_TEXT_LIMIT),
    notes: checkText(draft.notes, 'Private notes', REVIEW_NOTES_LIMIT),
  };
  if (draft.overall_rating === null || !Number.isInteger(draft.overall_rating) || draft.overall_rating < 1 || draft.overall_rating > 5) {
    errors.overall_rating = 'Give an overall rating from 1 to 5.';
  }
  if (!isValidIsoDate(draft.reviewed_on)) errors.reviewed_on = 'Enter the review date.';
  else if (diffDays(today, draft.reviewed_on) > 0) errors.reviewed_on = 'The review date cannot be in the future.';
  if (Object.entries(draft.ratings).some(([, v]) => v !== undefined && (!Number.isInteger(v) || v < 1 || v > 5))) errors.ratings = 'Ratings must be 1 to 5.';
  return compact(errors);
}

export interface ScheduleReviewDraft {
  employee_id: string;
  kind: ReviewKind;
  due_date: string;
}

export function validateScheduleReview(draft: ScheduleReviewDraft): Errors<ScheduleReviewDraft> {
  const errors: Errors<ScheduleReviewDraft> = {};
  if (!draft.employee_id) errors.employee_id = 'Choose an employee.';
  if (!(SCHEDULABLE_REVIEW_KINDS as readonly string[]).includes(draft.kind)) errors.kind = 'Choose annual or check-in.';
  if (!isValidIsoDate(draft.due_date)) errors.due_date = 'Enter a valid due date.';
  return compact(errors);
}

// ---------------------------------------------------------------------------
// Dashboard summary
// ---------------------------------------------------------------------------

export interface HrSummary {
  activeOnboardings: number;
  overdueTasks: number;
  openDocuments: number;
  expiringDocuments: number;
  reviewsDue: number;
}

export function summarizeHr(
  input: { onboardings: readonly Onboarding[]; tasks: readonly OnboardingTask[]; documents: readonly HrDocument[]; reviews: readonly Review[] },
  today: string,
): HrSummary {
  const activeIds = new Set(input.onboardings.filter((o) => o.status === 'active').map((o) => o.id));
  let expiringDocuments = 0;
  let openDocuments = 0;
  for (const d of input.documents) {
    const s = documentState(d, today);
    if (s === 'requested') openDocuments++;
    else if (s === 'expired' || s === 'expiring') expiringDocuments++;
  }
  return {
    activeOnboardings: activeIds.size,
    overdueTasks: input.tasks.filter((t) => activeIds.has(t.onboarding_id) && taskDueState(t, today) === 'overdue').length,
    openDocuments,
    expiringDocuments,
    reviewsDue: buildReviewReminders(input.reviews, today).length,
  };
}

export function employeeLabel(employee: EmployeeLite | undefined): string {
  return employee?.full_name ?? 'Former employee';
}
