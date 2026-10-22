import { supabase } from '@/lib/supabase';
import {
  buildStoragePath,
  normalizeDocument,
  normalizeEmployee,
  normalizeList,
  normalizeOnboarding,
  normalizeReview,
  normalizeTask,
  normalizeTemplate,
  normalizeTemplateItem,
  parseOffset,
  type DocStatus,
  type DocumentDraft,
  type EmployeeLite,
  type HrDocument,
  type Onboarding,
  type OnboardingTask,
  type Review,
  type ReviewDraft,
  type ScheduleReviewDraft,
  type TaskDraft,
  type TaskStatus,
  type Template,
  type TemplateDraft,
  type TemplateItem,
  type TemplateItemDraft,
} from '@/lib/hrOnboarding';

/**
 * Data access for /dashboard/hr. HR data is OWNER ONLY: RLS (user_id = auth.uid() and profiles.role = 'owner')
 * is the real gate; every query here is additionally scoped to the owner id so a mistake can never widen it.
 * Schema + rules: supabase/migrations/20271021000000_hr_onboarding.sql.
 */

const BUCKET = 'hr-documents';
const TEMPLATE_COLUMNS = 'id, name, description, active';
const ITEM_COLUMNS = 'id, template_id, title, description, category, due_offset_days, required, document_type, sort_order';
const ONBOARDING_COLUMNS = 'id, employee_id, template_id, template_name, start_date, status, completed_at, created_at';
const TASK_COLUMNS = 'id, onboarding_id, employee_id, title, description, category, due_date, required, status, completed_at, notes, document_type, sort_order';
const DOCUMENT_COLUMNS =
  'id, employee_id, onboarding_id, task_id, doc_type, title, status, expires_on, storage_path, file_name, mime_type, size_bytes, notes, received_at, verified_at, created_at';
const REVIEW_COLUMNS = 'id, employee_id, onboarding_id, kind, due_date, status, reviewed_on, overall_rating, ratings, strengths, improvements, goals, notes, completed_at';

export interface HrData {
  employees: EmployeeLite[];
  templates: Template[];
  onboardings: Onboarding[];
  tasks: OnboardingTask[];
  documents: HrDocument[];
  reviews: Review[];
}

export const EMPTY_HR_DATA: HrData = { employees: [], templates: [], onboardings: [], tasks: [], documents: [], reviews: [] };

const emptyToNull = (s: string): string | null => (s.trim() === '' ? null : s.trim());

export async function fetchHrData(ownerId: string): Promise<HrData> {
  const [employees, templates, items, onboardings, tasks, documents, reviews] = await Promise.all([
    supabase.from('employees').select('id, full_name, active').eq('user_id', ownerId).order('full_name', { ascending: true }).limit(1000),
    supabase.from('hr_onboarding_templates').select(TEMPLATE_COLUMNS).eq('user_id', ownerId).eq('active', true).order('name', { ascending: true }).limit(200),
    supabase.from('hr_onboarding_template_items').select(ITEM_COLUMNS).eq('user_id', ownerId).order('sort_order', { ascending: true }).limit(5000),
    supabase.from('hr_onboardings').select(ONBOARDING_COLUMNS).eq('user_id', ownerId).order('created_at', { ascending: false }).limit(1000),
    supabase.from('hr_onboarding_tasks').select(TASK_COLUMNS).eq('user_id', ownerId).order('sort_order', { ascending: true }).limit(10000),
    supabase.from('hr_documents').select(DOCUMENT_COLUMNS).eq('user_id', ownerId).order('created_at', { ascending: false }).limit(5000),
    supabase.from('hr_reviews').select(REVIEW_COLUMNS).eq('user_id', ownerId).order('due_date', { ascending: true }).limit(5000),
  ]);
  for (const r of [employees, templates, items, onboardings, tasks, documents, reviews]) if (r.error) throw r.error;
  const itemRows = normalizeList(items.data, normalizeTemplateItem);
  return {
    employees: normalizeList(employees.data, normalizeEmployee),
    templates: normalizeList(templates.data, (row) => normalizeTemplate(row, itemRows)),
    onboardings: normalizeList(onboardings.data, normalizeOnboarding),
    tasks: normalizeList(tasks.data, normalizeTask),
    documents: normalizeList(documents.data, normalizeDocument),
    reviews: normalizeList(reviews.data, normalizeReview),
  };
}

function must<T>(row: T | null, what: string): T {
  if (!row) throw new Error(`hr_not_found: ${what}`);
  return row;
}

// ---------------------------------------------------------------- templates

export async function seedStarterTemplates(): Promise<number> {
  const { data, error } = await supabase.rpc('hr_seed_starter_templates');
  if (error) throw error;
  return typeof data === 'number' ? data : 0;
}

export async function createTemplate(ownerId: string, draft: TemplateDraft): Promise<Template> {
  const { data, error } = await supabase
    .from('hr_onboarding_templates')
    .insert({ user_id: ownerId, name: draft.name.trim(), description: emptyToNull(draft.description) })
    .select(TEMPLATE_COLUMNS)
    .single();
  if (error) throw error;
  return must(normalizeTemplate(data), 'template');
}

export async function updateTemplate(id: string, ownerId: string, draft: TemplateDraft): Promise<void> {
  const { data, error } = await supabase
    .from('hr_onboarding_templates')
    .update({ name: draft.name.trim(), description: emptyToNull(draft.description) })
    .eq('id', id)
    .eq('user_id', ownerId)
    .select('id');
  if (error) throw error;
  must(data?.[0] ?? null, 'template');
}

/** Templates are archived, not deleted, so past onboardings keep their template name. */
export async function archiveTemplate(id: string, ownerId: string): Promise<void> {
  const { data, error } = await supabase.from('hr_onboarding_templates').update({ active: false }).eq('id', id).eq('user_id', ownerId).select('id');
  if (error) throw error;
  must(data?.[0] ?? null, 'template');
}

function itemPayload(draft: TemplateItemDraft) {
  return {
    title: draft.title.trim(),
    description: emptyToNull(draft.description),
    category: draft.category,
    due_offset_days: parseOffset(draft.due_offset_days) ?? 0,
    required: draft.required,
    document_type: draft.document_type === '' ? null : draft.document_type,
  };
}

export async function createTemplateItem(ownerId: string, templateId: string, draft: TemplateItemDraft, sortOrder: number): Promise<TemplateItem> {
  const { data, error } = await supabase
    .from('hr_onboarding_template_items')
    .insert({ user_id: ownerId, template_id: templateId, sort_order: sortOrder, ...itemPayload(draft) })
    .select(ITEM_COLUMNS)
    .single();
  if (error) throw error;
  return must(normalizeTemplateItem(data), 'template item');
}

export async function updateTemplateItem(id: string, ownerId: string, draft: TemplateItemDraft): Promise<TemplateItem> {
  const { data, error } = await supabase.from('hr_onboarding_template_items').update(itemPayload(draft)).eq('id', id).eq('user_id', ownerId).select(ITEM_COLUMNS);
  if (error) throw error;
  return must(normalizeTemplateItem(data?.[0]), 'template item');
}

export async function deleteTemplateItem(id: string, ownerId: string): Promise<void> {
  const { error } = await supabase.from('hr_onboarding_template_items').delete().eq('id', id).eq('user_id', ownerId);
  if (error) throw error;
}

// -------------------------------------------------------------- onboardings

export async function startOnboarding(employeeId: string, templateId: string, startDate: string): Promise<string> {
  const { data, error } = await supabase.rpc('hr_start_onboarding', { p_employee_id: employeeId, p_template_id: templateId, p_start_date: startDate });
  if (error) throw error;
  if (typeof data !== 'string') throw new Error('hr_not_found: onboarding');
  return data;
}

export async function cancelOnboarding(id: string, ownerId: string): Promise<void> {
  const { data, error } = await supabase.from('hr_onboardings').update({ status: 'cancelled' }).eq('id', id).eq('user_id', ownerId).eq('status', 'active').select('id');
  if (error) throw error;
  must(data?.[0] ?? null, 'onboarding');
}

export async function setTaskStatus(id: string, ownerId: string, status: TaskStatus): Promise<OnboardingTask> {
  const { data, error } = await supabase.from('hr_onboarding_tasks').update({ status }).eq('id', id).eq('user_id', ownerId).select(TASK_COLUMNS);
  if (error) throw error;
  return must(normalizeTask(data?.[0]), 'task');
}

export async function updateTaskDetails(id: string, ownerId: string, patch: { due_date: string | null; notes: string }): Promise<OnboardingTask> {
  const { data, error } = await supabase
    .from('hr_onboarding_tasks')
    .update({ due_date: patch.due_date, notes: emptyToNull(patch.notes) })
    .eq('id', id)
    .eq('user_id', ownerId)
    .select(TASK_COLUMNS);
  if (error) throw error;
  return must(normalizeTask(data?.[0]), 'task');
}

export async function createTask(ownerId: string, onboarding: Pick<Onboarding, 'id' | 'employee_id'>, draft: TaskDraft, sortOrder: number): Promise<OnboardingTask> {
  const { data, error } = await supabase
    .from('hr_onboarding_tasks')
    .insert({
      user_id: ownerId,
      onboarding_id: onboarding.id,
      employee_id: onboarding.employee_id,
      title: draft.title.trim(),
      description: emptyToNull(draft.description),
      category: draft.category,
      due_date: draft.due_date === '' ? null : draft.due_date,
      required: draft.required,
      document_type: draft.document_type === '' ? null : draft.document_type,
      sort_order: sortOrder,
    })
    .select(TASK_COLUMNS)
    .single();
  if (error) throw error;
  return must(normalizeTask(data), 'task');
}

export async function deleteTask(id: string, ownerId: string): Promise<void> {
  const { error } = await supabase.from('hr_onboarding_tasks').delete().eq('id', id).eq('user_id', ownerId);
  if (error) throw error;
}

/** Re-read one onboarding (the DB may have completed / re-opened it after a task or document change). */
export async function fetchOnboarding(id: string, ownerId: string): Promise<Onboarding | null> {
  const { data, error } = await supabase.from('hr_onboardings').select(ONBOARDING_COLUMNS).eq('id', id).eq('user_id', ownerId).maybeSingle();
  if (error) throw error;
  return normalizeOnboarding(data);
}

// ---------------------------------------------------------------- documents

export async function createDocumentRequest(ownerId: string, draft: DocumentDraft, link?: { onboarding_id: string; task_id: string }): Promise<HrDocument> {
  const { data, error } = await supabase
    .from('hr_documents')
    .insert({
      user_id: ownerId,
      employee_id: draft.employee_id,
      doc_type: draft.doc_type,
      title: draft.title.trim(),
      expires_on: draft.expires_on === '' ? null : draft.expires_on,
      notes: emptyToNull(draft.notes),
      onboarding_id: link?.onboarding_id ?? null,
      task_id: link?.task_id ?? null,
    })
    .select(DOCUMENT_COLUMNS)
    .single();
  if (error) throw error;
  return must(normalizeDocument(data), 'document');
}

/** Uploads the file to the private bucket, then marks the document received. The previous file (if any) is removed afterwards. */
export async function uploadDocumentFile(ownerId: string, doc: HrDocument, file: File, expiresOn: string): Promise<HrDocument> {
  const path = buildStoragePath(ownerId, doc.employee_id, crypto.randomUUID(), file.name);
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) throw uploadError;
  const { data, error } = await supabase
    .from('hr_documents')
    .update({
      status: 'received',
      storage_path: path,
      file_name: file.name.slice(0, 200),
      mime_type: file.type,
      size_bytes: file.size,
      expires_on: expiresOn === '' ? doc.expires_on : expiresOn,
    })
    .eq('id', doc.id)
    .eq('user_id', ownerId)
    .select(DOCUMENT_COLUMNS);
  if (error || !data?.[0]) {
    await supabase.storage.from(BUCKET).remove([path]); // do not leave an orphan file behind
    if (error) throw error;
    throw new Error('hr_not_found: document');
  }
  if (doc.storage_path) await supabase.storage.from(BUCKET).remove([doc.storage_path]);
  return must(normalizeDocument(data[0]), 'document');
}

export async function setDocumentStatus(id: string, ownerId: string, status: DocStatus): Promise<HrDocument> {
  const { data, error } = await supabase.from('hr_documents').update({ status }).eq('id', id).eq('user_id', ownerId).select(DOCUMENT_COLUMNS);
  if (error) throw error;
  return must(normalizeDocument(data?.[0]), 'document');
}

export async function updateDocumentDetails(id: string, ownerId: string, patch: { expires_on: string; notes: string }): Promise<HrDocument> {
  const { data, error } = await supabase
    .from('hr_documents')
    .update({ expires_on: patch.expires_on === '' ? null : patch.expires_on, notes: emptyToNull(patch.notes) })
    .eq('id', id)
    .eq('user_id', ownerId)
    .select(DOCUMENT_COLUMNS);
  if (error) throw error;
  return must(normalizeDocument(data?.[0]), 'document');
}

/** Removes the stored file and puts the document back to "requested". */
export async function removeDocumentFile(ownerId: string, doc: HrDocument): Promise<HrDocument> {
  const { data, error } = await supabase
    .from('hr_documents')
    .update({ status: 'requested', storage_path: null, file_name: null, mime_type: null, size_bytes: null })
    .eq('id', doc.id)
    .eq('user_id', ownerId)
    .select(DOCUMENT_COLUMNS);
  if (error) throw error;
  const row = must(normalizeDocument(data?.[0]), 'document');
  if (doc.storage_path) await supabase.storage.from(BUCKET).remove([doc.storage_path]);
  return row;
}

export async function deleteDocument(ownerId: string, doc: HrDocument): Promise<void> {
  const { error } = await supabase.from('hr_documents').delete().eq('id', doc.id).eq('user_id', ownerId);
  if (error) throw error;
  if (doc.storage_path) await supabase.storage.from(BUCKET).remove([doc.storage_path]);
}

/** Short-lived (60 s) signed link; the bucket is private. */
export async function getDocumentUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60);
  if (error || !data?.signedUrl) throw error ?? new Error('hr_not_found: file');
  return data.signedUrl;
}

// ------------------------------------------------------------------ reviews

export async function completeReview(id: string, ownerId: string, draft: ReviewDraft): Promise<Review> {
  const { data, error } = await supabase
    .from('hr_reviews')
    .update({
      status: 'completed',
      overall_rating: draft.overall_rating,
      reviewed_on: draft.reviewed_on,
      ratings: draft.ratings,
      strengths: emptyToNull(draft.strengths),
      improvements: emptyToNull(draft.improvements),
      goals: emptyToNull(draft.goals),
      notes: emptyToNull(draft.notes),
    })
    .eq('id', id)
    .eq('user_id', ownerId)
    .select(REVIEW_COLUMNS);
  if (error) throw error;
  return must(normalizeReview(data?.[0]), 'review');
}

export async function skipReview(id: string, ownerId: string): Promise<Review> {
  const { data, error } = await supabase.from('hr_reviews').update({ status: 'skipped' }).eq('id', id).eq('user_id', ownerId).eq('status', 'scheduled').select(REVIEW_COLUMNS);
  if (error) throw error;
  return must(normalizeReview(data?.[0]), 'review');
}

export async function scheduleReview(ownerId: string, draft: ScheduleReviewDraft): Promise<Review> {
  const { data, error } = await supabase
    .from('hr_reviews')
    .insert({ user_id: ownerId, employee_id: draft.employee_id, kind: draft.kind, due_date: draft.due_date })
    .select(REVIEW_COLUMNS)
    .single();
  if (error) throw error;
  return must(normalizeReview(data), 'review');
}

/** Idempotent in-app reminders for reviews due within 7 days. Best effort: never blocks the page. */
export async function notifyDueReviews(): Promise<void> {
  try {
    await supabase.rpc('hr_notify_due_reviews');
  } catch {
    /* reminders are a convenience; the page itself always shows what is due */
  }
}

// ------------------------------------------------------------------- errors

interface ErrorLike {
  message?: unknown;
  code?: unknown;
  details?: unknown;
}

/** Turns a Supabase / Postgres / storage error into a sentence a manager can act on. */
export function describeHrError(error: unknown): string {
  const e = (error && typeof error === 'object' ? error : {}) as ErrorLike;
  const text = `${typeof e.message === 'string' ? e.message : ''} ${typeof e.details === 'string' ? e.details : ''}`.toLowerCase();
  const code = typeof e.code === 'string' ? e.code : '';
  if (text.includes('failed to fetch') || text.includes('networkerror') || text.includes('network request failed')) return 'Network problem. Check your connection and try again.';
  if (text.includes('hr_forbidden') || code === '42501' || text.includes('row-level security') || text.includes('not authorized') || text.includes('unauthorized'))
    return 'Only the account owner can use HR. If you are the owner, sign in again and retry.';
  if (text.includes('hr_onboarding_exists') || text.includes('uq_hr_onboardings_one_active')) return 'This employee already has an active onboarding.';
  if (text.includes('uq_hr_templates_name')) return 'A template with this name already exists.';
  if (text.includes('uq_hr_reviews_milestone')) return 'This employee already has that 30/60/90-day review.';
  if (text.includes('hr_employee_not_found')) return 'That employee was not found or is no longer active.';
  if (text.includes('hr_template_not_found')) return 'That template was not found or has been archived.';
  if (text.includes('hr_invalid_start_date')) return 'The start date must be within a year of today.';
  if (text.includes('hr_invalid_rating')) return 'Ratings must be whole numbers from 1 to 5.';
  if (text.includes('hr_not_found')) return 'This record no longer exists. Refresh the page and try again.';
  if (text.includes('maximum allowed size') || text.includes('exceeded the maximum') || text.includes('payload too large')) return 'That file is too large (10 MB maximum).';
  if (text.includes('mime type') || text.includes('not supported')) return 'That file type is not allowed. Use PDF, PNG, JPEG, WebP or HEIC.';
  if (code === '23514') return 'Some values are not allowed. Check the form and try again.';
  if (code === '23505') return 'That record already exists.';
  return 'Something went wrong. Please try again.';
}
