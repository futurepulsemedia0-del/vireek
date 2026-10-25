import { supabase } from '@/lib/supabase';

// ============================================================
// Types
// ============================================================

export type SdsSignal = 'danger' | 'warning' | 'none';
export type SdsStatus = 'active' | 'archived';
export type SdsHazardClass =
  | 'explosive'
  | 'flammable'
  | 'oxidizer'
  | 'compressed_gas'
  | 'corrosive'
  | 'toxic'
  | 'health_hazard'
  | 'irritant'
  | 'environmental';
export type SdsReviewState = 'overdue' | 'due_soon' | 'current' | 'unknown';

export interface SdsDocument {
  id: string;
  product_name: string;
  manufacturer: string | null;
  product_code: string | null;
  cas_numbers: string[];
  signal_word: SdsSignal;
  hazard_classes: SdsHazardClass[];
  hazard_statements: string | null;
  first_aid: string | null;
  ppe: string | null;
  storage_notes: string | null;
  location: string | null;
  revision_date: string | null;
  review_due_date: string | null;
  status: SdsStatus;
  file_path: string | null;
  file_name: string | null;
  file_mime: string | null;
  created_at: string;
  updated_at: string;
}

/** Lightweight shape embedded in job links. */
export type SdsSummary = Pick<
  SdsDocument,
  | 'id'
  | 'product_name'
  | 'manufacturer'
  | 'signal_word'
  | 'hazard_classes'
  | 'first_aid'
  | 'ppe'
  | 'revision_date'
  | 'review_due_date'
  | 'status'
  | 'file_path'
  | 'file_name'
>;

export interface SdsJobLink {
  id: string;
  sds_id: string;
  job_id: string;
  checklist_item_id: string | null;
  note: string | null;
  created_at: string;
  sds: SdsSummary | null;
}

export interface SdsAck {
  sds_id: string;
  ack_user_id: string;
  ack_name: string;
  acknowledged_at: string;
}

export interface SdsForm {
  product_name: string;
  manufacturer: string;
  product_code: string;
  /** Free text: CAS numbers separated by commas, spaces or new lines. */
  cas_text: string;
  signal_word: SdsSignal;
  hazard_classes: SdsHazardClass[];
  hazard_statements: string;
  first_aid: string;
  ppe: string;
  storage_notes: string;
  location: string;
  /** yyyy-mm-dd or '' */
  revision_date: string;
  /** yyyy-mm-dd or '' */
  review_due_date: string;
  file_path: string | null;
  file_name: string | null;
  file_mime: string | null;
}

export type SdsFormErrors = Partial<Record<keyof SdsForm, string>>;

export interface SdsFilters {
  query: string;
  status: SdsStatus | 'all';
  hazard: SdsHazardClass | 'all';
  /** Only sheets whose review is overdue or coming due. */
  attentionOnly: boolean;
}

export const SDS_BUCKET = 'sds-files';
export const SDS_SIGNED_URL_SECONDS = 300;
export const SDS_DUE_SOON_DAYS = 30;
export const SDS_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const SDS_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;

export const SDS_LIMITS = {
  productName: 160,
  manufacturer: 160,
  productCode: 80,
  casCount: 30,
  hazardStatements: 4000,
  firstAid: 4000,
  ppe: 2000,
  storageNotes: 2000,
  location: 200,
  note: 300,
} as const;

export const HAZARD_CLASSES: ReadonlyArray<{ key: SdsHazardClass; label: string }> = [
  { key: 'flammable', label: 'Flammable' },
  { key: 'explosive', label: 'Explosive' },
  { key: 'oxidizer', label: 'Oxidizer' },
  { key: 'compressed_gas', label: 'Compressed gas' },
  { key: 'corrosive', label: 'Corrosive' },
  { key: 'toxic', label: 'Acute toxicity' },
  { key: 'health_hazard', label: 'Health hazard' },
  { key: 'irritant', label: 'Irritant' },
  { key: 'environmental', label: 'Environmental' },
];

const HAZARD_KEYS = new Set<string>(HAZARD_CLASSES.map((h) => h.key));

export function hazardLabel(key: string): string {
  return HAZARD_CLASSES.find((h) => h.key === key)?.label ?? key;
}

export const SIGNAL_LABEL: Record<SdsSignal, string> = {
  danger: 'Danger',
  warning: 'Warning',
  none: 'No signal word',
};

// ============================================================
// CAS numbers
// ============================================================

const CAS_SHAPE = /^\d{2,7}-\d{2}-\d$/;

/** Validates the CAS Registry Number format AND its check digit. */
export function isValidCas(value: string): boolean {
  const v = value.trim();
  if (!CAS_SHAPE.test(v)) return false;
  const digits = v.replace(/-/g, '');
  const check = Number(digits[digits.length - 1]);
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    sum += Number(body[body.length - 1 - i]) * (i + 1);
  }
  return sum % 10 === check;
}

/** Splits free text into unique, trimmed CAS tokens (validity is checked separately). */
export function splitCasText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// ============================================================
// Review state
// ============================================================

const DAY_MS = 86_400_000;

function utcDay(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

/** Days from `now` (UTC day) until the review date; negative = overdue; null = no date. */
export function daysUntilReview(doc: Pick<SdsDocument, 'review_due_date'>, now: Date = new Date()): number | null {
  if (!doc.review_due_date) return null;
  const due = utcDay(doc.review_due_date);
  if (due === null) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((due - today) / DAY_MS);
}

export function reviewState(doc: Pick<SdsDocument, 'review_due_date'>, now: Date = new Date()): SdsReviewState {
  const d = daysUntilReview(doc, now);
  if (d === null) return 'unknown';
  if (d < 0) return 'overdue';
  if (d <= SDS_DUE_SOON_DAYS) return 'due_soon';
  return 'current';
}

export function describeReview(doc: Pick<SdsDocument, 'review_due_date'>, now: Date = new Date()): string {
  const d = daysUntilReview(doc, now);
  if (d === null) return 'No review date';
  if (d < 0) return `Review overdue by ${-d} day${d === -1 ? '' : 's'}`;
  if (d === 0) return 'Review due today';
  if (d <= SDS_DUE_SOON_DAYS) return `Review due in ${d} day${d === 1 ? '' : 's'}`;
  return `Review due ${doc.review_due_date}`;
}

// ============================================================
// Search + filter (pure, so the UI stays instant and testable)
// ============================================================

function haystack(doc: SdsDocument): string {
  return [
    doc.product_name,
    doc.manufacturer,
    doc.product_code,
    doc.cas_numbers.join(' '),
    doc.location,
    doc.hazard_statements,
    doc.hazard_classes.map(hazardLabel).join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Every whitespace-separated term must appear somewhere in the sheet. */
export function matchesSdsQuery(doc: SdsDocument, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = haystack(doc);
  return terms.every((t) => hay.includes(t));
}

export const DEFAULT_SDS_FILTERS: SdsFilters = { query: '', status: 'active', hazard: 'all', attentionOnly: false };

export function sortSds(docs: SdsDocument[]): SdsDocument[] {
  return [...docs].sort((a, b) => a.product_name.localeCompare(b.product_name, undefined, { sensitivity: 'base' }));
}

export function filterSds(docs: SdsDocument[], f: SdsFilters, now: Date = new Date()): SdsDocument[] {
  return sortSds(
    docs.filter((d) => {
      if (f.status !== 'all' && d.status !== f.status) return false;
      if (f.hazard !== 'all' && !d.hazard_classes.includes(f.hazard)) return false;
      if (f.attentionOnly) {
        const s = reviewState(d, now);
        if (s !== 'overdue' && s !== 'due_soon') return false;
      }
      return matchesSdsQuery(d, f.query);
    }),
  );
}

export interface SdsStats {
  total: number;
  danger: number;
  needsReview: number;
  withFile: number;
}

export function summarizeSds(docs: SdsDocument[], now: Date = new Date()): SdsStats {
  const active = docs.filter((d) => d.status === 'active');
  return {
    total: active.length,
    danger: active.filter((d) => d.signal_word === 'danger').length,
    needsReview: active.filter((d) => {
      const s = reviewState(d, now);
      return s === 'overdue' || s === 'due_soon';
    }).length,
    withFile: active.filter((d) => !!d.file_path).length,
  };
}

// ============================================================
// Form <-> row
// ============================================================

export function emptySdsForm(): SdsForm {
  return {
    product_name: '',
    manufacturer: '',
    product_code: '',
    cas_text: '',
    signal_word: 'none',
    hazard_classes: [],
    hazard_statements: '',
    first_aid: '',
    ppe: '',
    storage_notes: '',
    location: '',
    revision_date: '',
    review_due_date: '',
    file_path: null,
    file_name: null,
    file_mime: null,
  };
}

export function docToForm(doc: SdsDocument): SdsForm {
  return {
    product_name: doc.product_name,
    manufacturer: doc.manufacturer ?? '',
    product_code: doc.product_code ?? '',
    cas_text: doc.cas_numbers.join(', '),
    signal_word: doc.signal_word,
    hazard_classes: doc.hazard_classes.filter((h) => HAZARD_KEYS.has(h)),
    hazard_statements: doc.hazard_statements ?? '',
    first_aid: doc.first_aid ?? '',
    ppe: doc.ppe ?? '',
    storage_notes: doc.storage_notes ?? '',
    location: doc.location ?? '',
    revision_date: doc.revision_date ?? '',
    review_due_date: doc.review_due_date ?? '',
    file_path: doc.file_path,
    file_name: doc.file_name,
    file_mime: doc.file_mime,
  };
}

export function validateSdsForm(form: SdsForm): SdsFormErrors {
  const errors: SdsFormErrors = {};
  const name = form.product_name.trim();
  if (!name) errors.product_name = 'Enter the product name exactly as it appears on the label.';
  else if (name.length > SDS_LIMITS.productName) errors.product_name = `Keep the name under ${SDS_LIMITS.productName} characters.`;

  if (form.manufacturer.length > SDS_LIMITS.manufacturer) errors.manufacturer = `Keep this under ${SDS_LIMITS.manufacturer} characters.`;
  if (form.product_code.length > SDS_LIMITS.productCode) errors.product_code = `Keep this under ${SDS_LIMITS.productCode} characters.`;
  if (form.location.length > SDS_LIMITS.location) errors.location = `Keep this under ${SDS_LIMITS.location} characters.`;
  if (form.hazard_statements.length > SDS_LIMITS.hazardStatements) errors.hazard_statements = `Keep this under ${SDS_LIMITS.hazardStatements} characters.`;
  if (form.first_aid.length > SDS_LIMITS.firstAid) errors.first_aid = `Keep this under ${SDS_LIMITS.firstAid} characters.`;
  if (form.ppe.length > SDS_LIMITS.ppe) errors.ppe = `Keep this under ${SDS_LIMITS.ppe} characters.`;
  if (form.storage_notes.length > SDS_LIMITS.storageNotes) errors.storage_notes = `Keep this under ${SDS_LIMITS.storageNotes} characters.`;

  const cas = splitCasText(form.cas_text);
  const badCas = cas.filter((c) => !isValidCas(c));
  if (cas.length > SDS_LIMITS.casCount) errors.cas_text = `Add at most ${SDS_LIMITS.casCount} CAS numbers.`;
  else if (badCas.length > 0) {
    errors.cas_text = `Not a valid CAS number: ${badCas.slice(0, 3).join(', ')}${badCas.length > 3 ? '…' : ''}. Format is 1234-56-7.`;
  }

  const rev = form.revision_date ? utcDay(form.revision_date) : null;
  const due = form.review_due_date ? utcDay(form.review_due_date) : null;
  if (form.revision_date && rev === null) errors.revision_date = 'Enter a valid date.';
  if (form.review_due_date && due === null) errors.review_due_date = 'Enter a valid date.';
  if (rev !== null && due !== null && due < rev) errors.review_due_date = 'The review date cannot be before the revision date.';

  return errors;
}

export function hasSdsErrors(errors: SdsFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

function nullable(v: string): string | null {
  const t = v.trim();
  return t ? t : null;
}

export function formToRow(form: SdsForm) {
  return {
    product_name: form.product_name.trim(),
    manufacturer: nullable(form.manufacturer),
    product_code: nullable(form.product_code),
    cas_numbers: splitCasText(form.cas_text),
    signal_word: form.signal_word,
    hazard_classes: form.hazard_classes.filter((h) => HAZARD_KEYS.has(h)),
    hazard_statements: nullable(form.hazard_statements),
    first_aid: nullable(form.first_aid),
    ppe: nullable(form.ppe),
    storage_notes: nullable(form.storage_notes),
    location: nullable(form.location),
    revision_date: form.revision_date || null,
    review_due_date: form.review_due_date || null,
    file_path: form.file_path,
    file_name: form.file_name,
    file_mime: form.file_mime,
  };
}

// ============================================================
// Files
// ============================================================

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '');
  return (cleaned || 'sds').slice(-120);
}

export function buildSdsPath(ownerId: string, uniqueId: string, fileName: string): string {
  return `${ownerId}/${uniqueId}-${sanitizeFileName(fileName)}`;
}

export function validateSdsFile(file: { size: number; type: string }): string | null {
  if (!(SDS_FILE_TYPES as readonly string[]).includes(file.type)) return 'Upload a PDF or an image (JPG, PNG, WebP).';
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > SDS_MAX_FILE_BYTES) return 'The file is larger than 25 MB.';
  return null;
}

// ============================================================
// Errors
// ============================================================

interface PgLikeError {
  code?: string;
  message?: string;
}

/** True when the SDS tables/functions are not in the database yet (migration not applied). */
export function isSdsUnavailable(err: unknown): boolean {
  const e = (err ?? {}) as PgLikeError;
  const msg = e.message ?? '';
  if (e.code === '42P01' || e.code === '42883' || e.code === 'PGRST205' || e.code === 'PGRST202') return true;
  return /sds_(documents|job_links|acknowledgements)/.test(msg) && /does not exist|schema cache/.test(msg);
}

export function describeSdsError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof Error && !('code' in err)) return err.message || fallback;
  const e = (err ?? {}) as PgLikeError;
  const msg = e.message ?? '';
  if (isSdsUnavailable(err)) return 'The SDS library is not set up on this database yet. Apply the latest migration and reload.';
  if (e.code === '42501' || msg.includes('not_permitted') || msg.includes('row-level security')) {
    return 'You do not have permission to do that. Ask your account owner for the "Manage Team" permission.';
  }
  if (msg.includes('sds_not_found')) return 'That sheet is archived or no longer exists.';
  if (msg.includes('job_not_found')) return 'That job could not be found.';
  if (msg.includes('checklist_item_not_found')) return 'That checklist item no longer exists on this job.';
  if (msg.includes('sds_not_attached')) return 'Attach the sheet to the job before confirming you reviewed it.';
  if (msg.includes('name_required')) return 'Your name is missing from your profile, so the review could not be recorded.';
  if (msg.includes('note_too_long')) return `Keep the note under ${SDS_LIMITS.note} characters.`;
  if (e.code === '23514') return 'One of the fields is out of range. Check the form and try again.';
  return msg && msg.length < 140 ? msg : fallback;
}

// ============================================================
// Network
// ============================================================

export async function fetchSdsList(accountOwnerId: string): Promise<SdsDocument[]> {
  const { data, error } = await supabase
    .from('sds_documents')
    .select('*')
    .eq('user_id', accountOwnerId)
    .order('product_name')
    .limit(2000);
  if (error) throw error;
  return (data ?? []) as SdsDocument[];
}

export async function saveSds(accountOwnerId: string, id: string | null, form: SdsForm): Promise<SdsDocument> {
  const row = formToRow(form);
  if (id) {
    const { data, error } = await supabase
      .from('sds_documents')
      .update(row)
      .eq('id', id)
      .eq('user_id', accountOwnerId)
      .select('*')
      .single();
    if (error) throw error;
    return data as SdsDocument;
  }
  const { data, error } = await supabase
    .from('sds_documents')
    .insert({ ...row, user_id: accountOwnerId })
    .select('*')
    .single();
  if (error) throw error;
  return data as SdsDocument;
}

export async function setSdsArchived(accountOwnerId: string, id: string, archived: boolean): Promise<void> {
  const { error } = await supabase
    .from('sds_documents')
    .update({ status: archived ? 'archived' : 'active' })
    .eq('id', id)
    .eq('user_id', accountOwnerId);
  if (error) throw error;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function uploadSdsFile(
  accountOwnerId: string,
  file: File,
): Promise<{ file_path: string; file_name: string; file_mime: string }> {
  const problem = validateSdsFile(file);
  if (problem) throw new Error(problem);
  const path = buildSdsPath(accountOwnerId, newId(), file.name);
  const { error } = await supabase.storage.from(SDS_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return { file_path: path, file_name: file.name.slice(0, 255), file_mime: file.type };
}

/** Best-effort cleanup of an upload that was replaced or abandoned. Never throws. */
export async function removeSdsFile(path: string): Promise<void> {
  try {
    await supabase.storage.from(SDS_BUCKET).remove([path]);
  } catch {
    /* orphaned file is harmless; the bucket is private */
  }
}

export async function getSdsFileUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(SDS_BUCKET).createSignedUrl(path, SDS_SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) throw error ?? new Error('Could not open the file.');
  return data.signedUrl;
}

type RawLink = Omit<SdsJobLink, 'sds'> & { sds: SdsSummary | SdsSummary[] | null };

export async function fetchJobSds(jobId: string): Promise<{ links: SdsJobLink[]; acks: SdsAck[] }> {
  const [linksRes, acksRes] = await Promise.all([
    supabase
      .from('sds_job_links')
      .select(
        'id, sds_id, job_id, checklist_item_id, note, created_at, sds:sds_documents(id, product_name, manufacturer, signal_word, hazard_classes, first_aid, ppe, revision_date, review_due_date, status, file_path, file_name)',
      )
      .eq('job_id', jobId)
      .order('created_at'),
    supabase.from('sds_acknowledgements').select('sds_id, ack_user_id, ack_name, acknowledged_at').eq('job_id', jobId),
  ]);
  if (linksRes.error) throw linksRes.error;
  if (acksRes.error) throw acksRes.error;
  const links = ((linksRes.data ?? []) as unknown as RawLink[]).map((l) => ({
    ...l,
    sds: Array.isArray(l.sds) ? (l.sds[0] ?? null) : l.sds,
  }));
  return { links, acks: (acksRes.data ?? []) as SdsAck[] };
}

export async function attachSds(
  sdsId: string,
  jobId: string,
  checklistItemId: string | null,
  note?: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('attach_sds_to_job', {
    p_sds_id: sdsId,
    p_job_id: jobId,
    p_checklist_item_id: checklistItemId,
    p_note: note?.trim().slice(0, SDS_LIMITS.note) || null,
  });
  if (error) throw error;
  return data as string;
}

export async function detachSds(linkId: string): Promise<void> {
  const { error } = await supabase.rpc('detach_sds_from_job', { p_link_id: linkId });
  if (error) throw error;
}

export async function acknowledgeSds(sdsId: string, jobId: string, name: string): Promise<string> {
  const { data, error } = await supabase.rpc('acknowledge_sds_for_job', { p_sds_id: sdsId, p_job_id: jobId, p_name: name });
  if (error) throw error;
  return data as string;
}

/**
 * Opens a sheet in a new tab. The tab is opened synchronously (inside the
 * click) and pointed at the signed URL afterwards, so mobile pop-up blockers
 * do not swallow it.
 */
export async function openSdsFile(path: string): Promise<void> {
  const win = typeof window !== 'undefined' ? window.open('', '_blank') : null;
  try {
    const url = await getSdsFileUrl(path);
    if (win) {
      win.opener = null;
      win.location.href = url;
    } else if (typeof window !== 'undefined') {
      window.location.assign(url);
    }
  } catch (err) {
    win?.close();
    throw err;
  }
}
