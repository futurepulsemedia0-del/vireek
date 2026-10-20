import { supabase } from '@/lib/supabase';

// ============================================================
// Types
// ============================================================

export type SopStatus = 'draft' | 'published' | 'archived';
export type TrainingStatus = 'completed' | 'overdue' | 'needs_reack' | 'in_progress' | 'not_started';
/** 'reference' = linked to a job template the person is looking at, but not assigned to them. */
export type JobSopStatus = TrainingStatus | 'reference';
export type AssignmentTargetType = 'everyone' | 'role' | 'custom_role' | 'member';
export type AssignableRole = 'owner' | 'admin' | 'technician' | 'member';

export interface SopSummary {
  id: string;
  title: string;
  summary: string | null;
  category: string | null;
  status: SopStatus;
  published_version: number;
  pass_score_pct: number;
  file_name: string | null;
  updated_at: string;
  quiz_count: number;
  assignment_count: number;
  template_count: number;
}

export interface QuizQuestionForm {
  key: string;
  prompt: string;
  options: string[];
  correct_index: number;
  explanation: string;
}

export interface AssignmentForm {
  key: string;
  target_type: AssignmentTargetType;
  target_role: AssignableRole | '';
  target_custom_role_id: string;
  target_member_id: string;
  /** yyyy-mm-dd or '' */
  due_date: string;
}

export interface ChecklistLinkForm {
  template_id: string;
  item_label: string;
}

export interface SopFormState {
  title: string;
  summary: string;
  category: string;
  body_md: string;
  file_path: string | null;
  file_name: string | null;
  file_mime: string | null;
  pass_score_pct: number;
  quiz: QuizQuestionForm[];
  assignments: AssignmentForm[];
  template_ids: string[];
  checklist_links: ChecklistLinkForm[];
}

export interface SopFormErrors {
  title?: string;
  content?: string;
  pass_score_pct?: string;
  quiz?: string;
  assignments?: string;
  checklist_links?: string;
}

export interface TrainingRow {
  sop_id: string;
  title: string;
  summary: string | null;
  category: string | null;
  version: number;
  due_at: string | null;
  acknowledged_at: string | null;
  quiz_required: boolean;
  quiz_passed: boolean;
  best_score: number | null;
  attempts: number;
  status: TrainingStatus;
}

export interface CompletionRow {
  sop_id: string;
  title: string;
  version: number;
  user_id: string;
  team_member_id: string | null;
  full_name: string;
  email: string;
  role: string;
  due_at: string | null;
  acknowledged_at: string | null;
  quiz_required: boolean;
  quiz_passed: boolean;
  best_score: number | null;
  attempts: number;
  status: TrainingStatus;
}

export interface SopReader {
  sop_id: string;
  version: number;
  title: string;
  summary: string | null;
  category: string | null;
  body_md: string | null;
  file_path: string | null;
  file_name: string | null;
  file_mime: string | null;
  change_note: string | null;
  published_at: string;
  pass_score_pct: number;
  questions: Array<{ prompt: string; options: string[] }>;
  my: {
    acknowledged_at: string | null;
    quiz_required: boolean;
    quiz_passed: boolean;
    best_score: number | null;
    attempts: number;
  };
}

export interface QuizResult {
  score_pct: number;
  passed: boolean;
  correct: number;
  total: number;
  pass_score_pct: number;
  /** Indices of wrong questions (empty when passed). Correct answers are never sent. */
  wrong: number[];
}

export interface JobSopRow {
  sop_id: string;
  title: string;
  summary: string | null;
  category: string | null;
  version: number;
  linked_items: string[];
  status: JobSopStatus;
  due_at: string | null;
  acknowledged_at: string | null;
}

export interface SopVersionRow {
  version: number;
  change_note: string | null;
  published_at: string;
}

// ============================================================
// Limits (mirrored by CHECK constraints / RPC guards in the migration)
// ============================================================

export const SOP_LIMITS = {
  title: 160,
  summary: 600,
  category: 80,
  body: 60000,
  question: 400,
  option: 200,
  explanation: 600,
  minOptions: 2,
  maxOptions: 6,
  maxQuestions: 50,
  maxAssignments: 100,
  maxChecklistLinks: 300,
  checklistLabel: 200,
  changeNote: 500,
  typedName: 120,
} as const;

export const SOP_BUCKET = 'sop-files';
export const SOP_SIGNED_URL_SECONDS = 60;
export const SOP_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const SOP_ALLOWED_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'video/mp4',
] as const;

export const ASSIGNABLE_ROLES: Array<{ value: AssignableRole; label: string }> = [
  { value: 'technician', label: 'Technicians' },
  { value: 'admin', label: 'Admins' },
  { value: 'member', label: 'Office / other members' },
  { value: 'owner', label: 'Owner' },
];

// ============================================================
// Pure helpers
// ============================================================

let keyCounter = 0;
export const newKey = (): string => `k${Date.now().toString(36)}${(keyCounter++).toString(36)}`;

export function emptyQuestion(): QuizQuestionForm {
  return { key: newKey(), prompt: '', options: ['', ''], correct_index: 0, explanation: '' };
}

export function emptyAssignment(): AssignmentForm {
  return { key: newKey(), target_type: 'role', target_role: 'technician', target_custom_role_id: '', target_member_id: '', due_date: '' };
}

export function emptySopForm(): SopFormState {
  return {
    title: '',
    summary: '',
    category: '',
    body_md: '',
    file_path: null,
    file_name: null,
    file_mime: null,
    pass_score_pct: 80,
    quiz: [],
    assignments: [],
    template_ids: [],
    checklist_links: [],
  };
}

/** Case/whitespace-insensitive key — identical to lower(btrim(label)) in the database. */
export function normalizeItemKey(label: string): string {
  return label.trim().toLowerCase();
}

export function validateSopForm(form: SopFormState): SopFormErrors {
  const errors: SopFormErrors = {};
  const title = form.title.trim();
  if (!title) errors.title = 'Give the SOP a title.';
  else if (title.length > SOP_LIMITS.title) errors.title = `Keep the title under ${SOP_LIMITS.title} characters.`;

  if (form.body_md.length > SOP_LIMITS.body) errors.content = `The written procedure is too long (max ${SOP_LIMITS.body.toLocaleString()} characters).`;

  if (!Number.isInteger(form.pass_score_pct) || form.pass_score_pct < 1 || form.pass_score_pct > 100) {
    errors.pass_score_pct = 'Pass mark must be between 1 and 100.';
  }

  if (form.quiz.length > SOP_LIMITS.maxQuestions) {
    errors.quiz = `A quiz can have at most ${SOP_LIMITS.maxQuestions} questions.`;
  } else {
    for (let i = 0; i < form.quiz.length; i++) {
      const q = form.quiz[i];
      const opts = q.options.map((o) => o.trim());
      if (!q.prompt.trim()) { errors.quiz = `Question ${i + 1} needs text.`; break; }
      if (opts.length < SOP_LIMITS.minOptions || opts.length > SOP_LIMITS.maxOptions) {
        errors.quiz = `Question ${i + 1} needs ${SOP_LIMITS.minOptions}–${SOP_LIMITS.maxOptions} answers.`; break;
      }
      if (opts.some((o) => !o)) { errors.quiz = `Fill in or remove the empty answers in question ${i + 1}.`; break; }
      if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) {
        errors.quiz = `Question ${i + 1} has duplicate answers.`; break;
      }
      if (q.correct_index < 0 || q.correct_index >= opts.length) {
        errors.quiz = `Pick the correct answer for question ${i + 1}.`; break;
      }
    }
  }

  if (form.assignments.length > SOP_LIMITS.maxAssignments) {
    errors.assignments = 'Too many assignments.';
  } else {
    for (const a of form.assignments) {
      if (a.target_type === 'role' && !a.target_role) { errors.assignments = 'Choose a role for every role assignment.'; break; }
      if (a.target_type === 'custom_role' && !a.target_custom_role_id) { errors.assignments = 'Choose a custom role.'; break; }
      if (a.target_type === 'member' && !a.target_member_id) { errors.assignments = 'Choose a person.'; break; }
      if (a.due_date && Number.isNaN(Date.parse(`${a.due_date}T00:00:00Z`))) { errors.assignments = 'One due date is not valid.'; break; }
    }
  }

  if (form.checklist_links.length > SOP_LIMITS.maxChecklistLinks) errors.checklist_links = 'Too many checklist links.';
  return errors;
}

/** Publishing needs more than saving a draft: real content and at least one assignment. */
export function validateForPublish(form: SopFormState): string | null {
  if (!form.body_md.trim() && !form.file_path) return 'Write the procedure or attach a file before publishing.';
  if (form.assignments.length === 0) return 'Assign the SOP to at least one role or person before publishing.';
  return null;
}

export const hasErrors = (e: SopFormErrors): boolean => Object.keys(e).length > 0;

/** End of the chosen day in UTC, so "due Friday" is not overdue on Friday morning in any timezone. */
export function dueDateToIso(date: string): string | null {
  if (!date) return null;
  const ms = Date.parse(`${date}T23:59:59Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function isoToDueDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

export function formToPayload(form: SopFormState): Record<string, unknown> {
  return {
    title: form.title.trim(),
    summary: form.summary.trim(),
    category: form.category.trim(),
    body_md: form.body_md.trim(),
    file_path: form.file_path,
    file_name: form.file_name,
    file_mime: form.file_mime,
    pass_score_pct: form.pass_score_pct,
    quiz: form.quiz.map((q) => ({
      prompt: q.prompt.trim(),
      options: q.options.map((o) => o.trim()),
      correct_index: q.correct_index,
      explanation: q.explanation.trim(),
    })),
    template_ids: [...new Set(form.template_ids)],
    checklist_links: form.checklist_links
      .filter((l) => l.template_id && l.item_label.trim())
      .map((l) => ({ template_id: l.template_id, item_label: l.item_label.trim() })),
    assignments: form.assignments.map((a) => ({
      target_type: a.target_type,
      target_role: a.target_type === 'role' ? a.target_role : null,
      target_custom_role_id: a.target_type === 'custom_role' ? a.target_custom_role_id : null,
      target_member_id: a.target_type === 'member' ? a.target_member_id : null,
      due_at: dueDateToIso(a.due_date),
    })),
  };
}

export const TRAINING_STATUS_META: Record<TrainingStatus, { label: string; tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral'; rank: number }> = {
  overdue: { label: 'Overdue', tone: 'danger', rank: 0 },
  needs_reack: { label: 'Re-acknowledge', tone: 'warning', rank: 1 },
  in_progress: { label: 'In progress', tone: 'info', rank: 2 },
  not_started: { label: 'Not started', tone: 'neutral', rank: 3 },
  completed: { label: 'Completed', tone: 'success', rank: 4 },
};

export function jobSopStatusLabel(status: JobSopStatus): string {
  return status === 'reference' ? 'Reference' : TRAINING_STATUS_META[status].label;
}

export interface CompletionSummary {
  total: number;
  completed: number;
  overdue: number;
  needsReack: number;
  pending: number;
  /** Whole percent, 0 when nobody is assigned. */
  pct: number;
}

export function summarizeCompletion(rows: Array<{ status: TrainingStatus }>): CompletionSummary {
  const total = rows.length;
  const completed = rows.filter((r) => r.status === 'completed').length;
  const overdue = rows.filter((r) => r.status === 'overdue').length;
  const needsReack = rows.filter((r) => r.status === 'needs_reack').length;
  return {
    total,
    completed,
    overdue,
    needsReack,
    pending: total - completed,
    pct: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}

export function summarizeBySop<T extends { sop_id: string; status: TrainingStatus }>(rows: T[]): Map<string, CompletionSummary> {
  const grouped = new Map<string, T[]>();
  for (const r of rows) grouped.set(r.sop_id, [...(grouped.get(r.sop_id) ?? []), r]);
  const out = new Map<string, CompletionSummary>();
  for (const [id, list] of grouped) out.set(id, summarizeCompletion(list));
  return out;
}

export type DueState = 'none' | 'overdue' | 'soon' | 'ok';

export function dueState(dueAt: string | null, now: Date = new Date(), soonDays = 3): DueState {
  if (!dueAt) return 'none';
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return 'none';
  const diff = due - now.getTime();
  if (diff < 0) return 'overdue';
  return diff <= soonDays * 86_400_000 ? 'soon' : 'ok';
}

export function formatDue(dueAt: string | null): string {
  if (!dueAt) return 'No due date';
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return 'No due date';
  return `Due ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
}

export function sortTraining<T extends { status: TrainingStatus; due_at: string | null; title: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const r = TRAINING_STATUS_META[a.status].rank - TRAINING_STATUS_META[b.status].rank;
    if (r !== 0) return r;
    const ad = a.due_at ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY;
    const bd = b.due_at ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return a.title.localeCompare(b.title);
  });
}

/** Client-side gate for the quiz form: every question answered before we send it. */
export function isQuizComplete(answers: Array<number | null>, questionCount: number): boolean {
  return answers.length === questionCount && answers.every((a) => a !== null && a >= 0);
}

export function describeAssignment(
  a: Pick<AssignmentForm, 'target_type' | 'target_role' | 'target_custom_role_id' | 'target_member_id'>,
  lookups: { customRoles?: Array<{ id: string; name: string }>; members?: Array<{ id: string; name: string }> } = {},
): string {
  switch (a.target_type) {
    case 'everyone':
      return 'Everyone on the team';
    case 'role':
      return ASSIGNABLE_ROLES.find((r) => r.value === a.target_role)?.label ?? 'A role';
    case 'custom_role':
      return lookups.customRoles?.find((r) => r.id === a.target_custom_role_id)?.name ?? 'Custom role';
    case 'member':
      return lookups.members?.find((m) => m.id === a.target_member_id)?.name ?? 'A team member';
  }
}

// ---------- audit export ----------

/** Cells starting with = + - @ (or tab/CR) are prefixed so spreadsheets never run them as formulas. */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function completionToCsv(rows: CompletionRow[]): string {
  const header = ['SOP', 'Version', 'Person', 'Email', 'Role', 'Status', 'Due', 'Acknowledged at (UTC)', 'Quiz best score %', 'Quiz attempts'];
  const lines = rows.map((r) =>
    [
      r.title, r.version, r.full_name, r.email, r.role,
      TRAINING_STATUS_META[r.status].label,
      r.due_at ? r.due_at.slice(0, 10) : '',
      r.acknowledged_at ?? '',
      r.best_score ?? '',
      r.attempts,
    ].map(csvCell).join(','),
  );
  return [header.map(csvCell).join(','), ...lines].join('\r\n');
}

// ---------- files ----------

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '');
  return (cleaned || 'file').slice(-120);
}

export function buildStoragePath(ownerId: string, sopId: string | null, fileName: string, uniqueId: string): string {
  return `${ownerId}/${sopId ?? 'new'}/${uniqueId}-${sanitizeFileName(fileName)}`;
}

export function validateSopFile(file: { size: number; type: string }): string | null {
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > SOP_MAX_FILE_BYTES) return 'Files can be up to 50 MB.';
  if (!(SOP_ALLOWED_MIME as readonly string[]).includes(file.type)) {
    return 'Upload a PDF, Word document, image, text file or MP4 video.';
  }
  return null;
}

// ---------- safe markdown (no HTML injection, no external dependency) ----------

export type MdInline = { type: 'text'; text: string } | { type: 'bold'; text: string } | { type: 'code'; text: string } | { type: 'link'; text: string; href: string };
export type MdBlock =
  | { type: 'heading'; level: 1 | 2 | 3; inline: MdInline[] }
  | { type: 'paragraph'; inline: MdInline[] }
  | { type: 'ul'; items: MdInline[][] }
  | { type: 'ol'; items: MdInline[][] }
  | { type: 'check'; items: Array<{ checked: boolean; inline: MdInline[] }> };

export function isSafeHref(href: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(href) || /^mailto:[^\s]+$/i.test(href);
}

export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: src.slice(last, m.index) });
    if (m[2] !== undefined) out.push({ type: 'bold', text: m[2] });
    else if (m[4] !== undefined) out.push({ type: 'code', text: m[4] });
    else if (isSafeHref(m[7])) out.push({ type: 'link', text: m[6], href: m[7] });
    else out.push({ type: 'text', text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ type: 'text', text: src.slice(last) });
  return out;
}

export function parseMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'paragraph', inline: parseInline(para.join(' ')) });
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flush(); blocks.push({ type: 'heading', level: h[1].length as 1 | 2 | 3, inline: parseInline(h[2]) }); continue; }

    const check = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (check) {
      flush();
      const item = { checked: check[1] !== ' ', inline: parseInline(check[2]) };
      const prev = blocks[blocks.length - 1];
      if (prev?.type === 'check') prev.items.push(item); else blocks.push({ type: 'check', items: [item] });
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul) {
      flush();
      const prev = blocks[blocks.length - 1];
      if (prev?.type === 'ul') prev.items.push(parseInline(ul[1])); else blocks.push({ type: 'ul', items: [parseInline(ul[1])] });
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flush();
      const prev = blocks[blocks.length - 1];
      if (prev?.type === 'ol') prev.items.push(parseInline(ol[1])); else blocks.push({ type: 'ol', items: [parseInline(ol[1])] });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

// ============================================================
// Errors
// ============================================================

interface PgLikeError {
  code?: string;
  message?: string;
}

export function describeSopError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof Error && !('code' in err)) return err.message || fallback;
  const e = (err ?? {}) as PgLikeError;
  const msg = e.message ?? '';
  if (e.code === '42501' || msg.includes('not_permitted') || msg.includes('row-level security')) {
    return 'You do not have permission to manage SOPs. Ask your account owner for the "Manage Team" permission.';
  }
  if (msg.includes('title_required')) return 'Give the SOP a title.';
  if (msg.includes('content_required')) return 'Write the procedure or attach a file before publishing.';
  if (msg.includes('assignment_required')) return 'Assign the SOP to at least one role or person before publishing.';
  if (msg.includes('invalid_quiz')) return 'One of the quiz questions is incomplete. Check the answers and the correct-answer choice.';
  if (msg.includes('invalid_pass_score')) return 'Pass mark must be between 1 and 100.';
  if (msg.includes('invalid_template')) return 'A linked job template no longer exists. Remove it and try again.';
  if (msg.includes('invalid_assignment')) return 'An assigned role or person no longer exists. Remove it and try again.';
  if (msg.includes('too_many_lines')) return 'This SOP has too many quiz questions, links or assignments.';
  if (msg.includes('file_outside_account')) return 'That file could not be attached. Upload it again.';
  if (msg.includes('sop_not_found')) return 'That SOP no longer exists or is not published.';
  if (msg.includes('quiz_not_passed')) return 'Pass the quiz before acknowledging.';
  if (msg.includes('name_required')) return 'Type your full name to acknowledge.';
  if (msg.includes('no_quiz')) return 'This SOP has no quiz.';
  if (msg.includes('not_authenticated')) return 'Your session expired. Sign in again to continue.';
  return msg || fallback;
}

// ============================================================
// Supabase API
// ============================================================

export async function fetchSops(accountOwnerId: string): Promise<SopSummary[]> {
  const { data, error } = await supabase
    .from('sop_documents')
    .select(
      'id, title, summary, category, status, published_version, pass_score_pct, file_name, updated_at, sop_quiz_questions(count), sop_assignments(count), sop_template_links(count)'
    )
    .eq('user_id', accountOwnerId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  type Row = Omit<SopSummary, 'quiz_count' | 'assignment_count' | 'template_count'> & {
    sop_quiz_questions: Array<{ count: number }> | null;
    sop_assignments: Array<{ count: number }> | null;
    sop_template_links: Array<{ count: number }> | null;
  };
  return ((data ?? []) as unknown as Row[]).map(({ sop_quiz_questions, sop_assignments, sop_template_links, ...rest }) => ({
    ...rest,
    quiz_count: sop_quiz_questions?.[0]?.count ?? 0,
    assignment_count: sop_assignments?.[0]?.count ?? 0,
    template_count: sop_template_links?.[0]?.count ?? 0,
  }));
}

export async function fetchSopForm(accountOwnerId: string, sopId: string): Promise<SopFormState> {
  const [doc, quiz, assignments, templates, items] = await Promise.all([
    supabase.from('sop_documents').select('*').eq('id', sopId).eq('user_id', accountOwnerId).maybeSingle(),
    supabase.from('sop_quiz_questions').select('prompt, options, correct_index, explanation, sort_order').eq('sop_id', sopId).order('sort_order'),
    supabase.from('sop_assignments').select('target_type, target_role, target_custom_role_id, target_member_id, due_at').eq('sop_id', sopId),
    supabase.from('sop_template_links').select('template_id').eq('sop_id', sopId),
    supabase.from('sop_checklist_links').select('template_id, item_label').eq('sop_id', sopId).order('item_label'),
  ]);
  for (const r of [doc, quiz, assignments, templates, items]) if (r.error) throw r.error;
  if (!doc.data) throw new Error('That SOP no longer exists.');
  const d = doc.data as Record<string, unknown>;
  return {
    title: String(d.title ?? ''),
    summary: String(d.summary ?? ''),
    category: String(d.category ?? ''),
    body_md: String(d.body_md ?? ''),
    file_path: (d.file_path as string | null) ?? null,
    file_name: (d.file_name as string | null) ?? null,
    file_mime: (d.file_mime as string | null) ?? null,
    pass_score_pct: Number(d.pass_score_pct ?? 80),
    quiz: (quiz.data ?? []).map((q) => ({
      key: newKey(),
      prompt: q.prompt as string,
      options: q.options as string[],
      correct_index: q.correct_index as number,
      explanation: (q.explanation as string | null) ?? '',
    })),
    assignments: (assignments.data ?? []).map((a) => ({
      key: newKey(),
      target_type: a.target_type as AssignmentTargetType,
      target_role: ((a.target_role as AssignableRole | null) ?? '') as AssignableRole | '',
      target_custom_role_id: (a.target_custom_role_id as string | null) ?? '',
      target_member_id: (a.target_member_id as string | null) ?? '',
      due_date: isoToDueDate(a.due_at as string | null),
    })),
    template_ids: (templates.data ?? []).map((t) => t.template_id as string),
    checklist_links: (items.data ?? []).map((i) => ({ template_id: i.template_id as string, item_label: i.item_label as string })),
  };
}

export async function saveSop(sopId: string | null, form: SopFormState): Promise<string> {
  const { data, error } = await supabase.rpc('save_sop', { p_sop_id: sopId, p_payload: formToPayload(form) });
  if (error) throw error;
  return data as string;
}

export async function publishSop(sopId: string, changeNote: string): Promise<number> {
  const { data, error } = await supabase.rpc('publish_sop', { p_sop_id: sopId, p_change_note: changeNote.trim().slice(0, SOP_LIMITS.changeNote) || null });
  if (error) throw error;
  return data as number;
}

export async function setSopArchived(sopId: string, archived: boolean): Promise<void> {
  const { error } = await supabase.rpc('archive_sop', { p_sop_id: sopId, p_archived: archived });
  if (error) throw error;
}

/** Only never-published drafts can be deleted (enforced by RLS); everything else is archived. */
export async function deleteDraftSop(sopId: string): Promise<void> {
  const { error } = await supabase.from('sop_documents').delete().eq('id', sopId);
  if (error) throw error;
}

export async function fetchSopVersions(sopId: string): Promise<SopVersionRow[]> {
  const { data, error } = await supabase
    .from('sop_versions')
    .select('version, change_note, published_at')
    .eq('sop_id', sopId)
    .order('version', { ascending: false });
  if (error) throw error;
  return (data ?? []) as SopVersionRow[];
}

export async function fetchCompletionReport(sopId: string | null = null): Promise<CompletionRow[]> {
  const { data, error } = await supabase.rpc('sop_completion_report', { p_sop_id: sopId });
  if (error) throw error;
  return (data ?? []) as CompletionRow[];
}

export async function fetchMyTraining(): Promise<TrainingRow[]> {
  const { data, error } = await supabase.rpc('my_sop_training');
  if (error) throw error;
  return (data ?? []) as TrainingRow[];
}

export async function fetchSopReader(sopId: string): Promise<SopReader> {
  const { data, error } = await supabase.rpc('get_sop_reader', { p_sop_id: sopId });
  if (error) throw error;
  return data as SopReader;
}

export async function submitSopQuiz(sopId: string, answers: number[]): Promise<QuizResult> {
  const { data, error } = await supabase.rpc('submit_sop_quiz', { p_sop_id: sopId, p_answers: answers });
  if (error) throw error;
  return data as QuizResult;
}

export async function acknowledgeSop(sopId: string, typedName: string): Promise<string> {
  const { data, error } = await supabase.rpc('acknowledge_sop', {
    p_sop_id: sopId,
    p_typed_name: typedName.trim().slice(0, SOP_LIMITS.typedName),
  });
  if (error) throw error;
  return data as string;
}

export async function fetchSopsForTemplate(templateId: string): Promise<JobSopRow[]> {
  const { data, error } = await supabase.rpc('sops_for_job_template', { p_template_id: templateId });
  if (error) throw error;
  return (data ?? []) as JobSopRow[];
}

export async function uploadSopFile(ownerId: string, sopId: string | null, file: File): Promise<{ path: string; name: string; mime: string }> {
  const problem = validateSopFile(file);
  if (problem) throw new Error(problem);
  const path = buildStoragePath(ownerId, sopId, file.name, crypto.randomUUID());
  const { error } = await supabase.storage.from(SOP_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return { path, name: file.name.slice(0, 255), mime: file.type };
}

/** Short-lived link minted on demand (never stored). Tab is opened synchronously so popup blockers stay quiet. */
export async function openSopFile(path: string): Promise<void> {
  const tab = window.open('', '_blank');
  try {
    const { data, error } = await supabase.storage.from(SOP_BUCKET).createSignedUrl(path, SOP_SIGNED_URL_SECONDS);
    if (error || !data?.signedUrl) throw error ?? new Error('Could not create a secure link.');
    if (tab) {
      tab.opener = null;
      tab.location.href = data.signedUrl;
    } else {
      window.location.assign(data.signedUrl);
    }
  } catch (err) {
    tab?.close();
    throw err;
  }
}

export async function fetchTeamLookups(accountOwnerId: string): Promise<{
  members: Array<{ id: string; name: string; role: string }>;
  customRoles: Array<{ id: string; name: string }>;
  templates: Array<{ id: string; name: string }>;
}> {
  const [members, roles, templates] = await Promise.all([
    supabase.from('team_members').select('id, member_name, member_email, role').eq('account_owner_id', accountOwnerId).order('member_name'),
    supabase.from('custom_roles').select('id, name').eq('user_id', accountOwnerId).order('name'),
    supabase.from('job_templates').select('id, name').eq('user_id', accountOwnerId).order('name'),
  ]);
  for (const r of [members, roles, templates]) if (r.error) throw r.error;
  return {
    members: (members.data ?? []).map((m) => ({ id: m.id as string, name: (m.member_name as string | null) || (m.member_email as string), role: m.role as string })),
    customRoles: (roles.data ?? []) as Array<{ id: string; name: string }>,
    templates: (templates.data ?? []) as Array<{ id: string; name: string }>,
  };
}

/** Checklist labels of one job template — used to link an SOP to a specific checklist item. */
export async function fetchTemplateChecklistLabels(templateId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('job_template_checklist_items')
    .select('label, sort_order')
    .eq('template_id', templateId)
    .order('sort_order');
  if (error) throw error;
  return (data ?? []).map((r) => r.label as string);
}
