// ============================================================
// TYPES & CONSTANTS
// ============================================================

export type DocumentCategory = 'license' | 'insurance' | 'contract' | 'permit' | 'other';

export const DOCUMENT_CATEGORIES: DocumentCategory[] = [
  'license',
  'insurance',
  'contract',
  'permit',
  'other',
];

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  license: 'License',
  insurance: 'Insurance',
  contract: 'Contract',
  permit: 'Permit',
  other: 'Other',
};

export interface DocumentRecord {
  id: string;
  user_id: string;
  customer_id: string | null;
  title: string;
  category: DocumentCategory;
  reference_number: string | null;
  issuer: string | null;
  issued_on: string | null;
  expires_on: string | null;
  alert_days: number;
  notes: string | null;
  current_version_id: string | null;
  version_count: number;
  current_file_name: string | null;
  current_file_size: number | null;
  current_mime_type: string | null;
  last_alert_stage: 'expiring' | 'expired' | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  customer?: { id: string; name: string } | null;
}

export interface DocumentVersion {
  id: string;
  document_id: string;
  user_id: string;
  version_number: number;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number;
  note: string | null;
  uploaded_by: string | null;
  created_at: string;
}

export const DOCUMENTS_BUCKET = 'documents';
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const SIGNED_URL_TTL_SECONDS = 60;
export const ALERT_DAY_OPTIONS = [7, 14, 30, 60, 90] as const;

// Mirrors the bucket's allowed_mime_types in the migration.
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
]);

const EXTENSION_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  csv: 'text/csv',
};

export const DOCUMENT_ACCEPT_ATTR = Object.keys(EXTENSION_TO_MIME)
  .map((e) => `.${e}`)
  .join(',');

// ============================================================
// PURE HELPERS (unit-tested)
// ============================================================

export type ExpiryState = 'expired' | 'expiring' | 'valid' | 'none';

/** Parses a `YYYY-MM-DD` string as a LOCAL calendar date (no timezone drift). */
export function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole calendar days from today to the date (negative = past). */
export function daysUntil(value: string | null | undefined, now: Date = new Date()): number | null {
  const target = parseDateOnly(value);
  if (!target) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export function getExpiryState(
  expiresOn: string | null | undefined,
  alertDays: number,
  now: Date = new Date(),
): ExpiryState {
  const days = daysUntil(expiresOn, now);
  if (days === null) return 'none';
  if (days < 0) return 'expired';
  if (days <= alertDays) return 'expiring';
  return 'valid';
}

export function describeExpiry(
  expiresOn: string | null | undefined,
  now: Date = new Date(),
): string {
  const days = daysUntil(expiresOn, now);
  if (days === null) return 'No expiry date';
  if (days < 0) return `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  return `Expires in ${days} days`;
}

export const EXPIRY_STATE_STYLES: Record<ExpiryState, string> = {
  expired: 'bg-danger/10 text-danger',
  expiring: 'bg-warning-500/10 text-warning-500',
  valid: 'bg-success-500/10 text-success-500',
  none: 'bg-bg-tertiary text-text-secondary',
};

export const EXPIRY_STATE_LABELS: Record<ExpiryState, string> = {
  expired: 'Expired',
  expiring: 'Expiring soon',
  valid: 'Valid',
  none: 'No expiry',
};

/** Sort weight: most urgent first (expired → expiring → valid → none). */
export function expirySortKey(
  doc: Pick<DocumentRecord, 'expires_on' | 'alert_days'>,
  now: Date = new Date(),
): number {
  const days = daysUntil(doc.expires_on, now);
  return days === null ? Number.MAX_SAFE_INTEGER : days;
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : '';
}

/** Resolves a trustworthy mime type (browsers sometimes send an empty `type`). */
export function resolveMimeType(file: Pick<File, 'name' | 'type'>): string | null {
  const ext = extensionOf(file.name);
  // A file whose extension is known-but-unsupported (e.g. a renamed .exe) is rejected
  // even if the browser reported an allowed mime type.
  if (ext && !EXTENSION_TO_MIME[ext]) return null;
  if (file.type && ALLOWED_MIME.has(file.type)) return file.type;
  return EXTENSION_TO_MIME[ext] ?? null;
}

/** Returns a human-readable error, or null when the file is acceptable. */
export function validateDocumentFile(file: Pick<File, 'name' | 'type' | 'size'>): string | null {
  if (file.size <= 0) return 'This file is empty.';
  if (file.size > MAX_DOCUMENT_BYTES)
    return `Files can be up to ${formatFileSize(MAX_DOCUMENT_BYTES)}.`;
  if (!resolveMimeType(file))
    return 'Unsupported file type. Use PDF, an image, Word, Excel, CSV or text.';
  return null;
}

/** ASCII-only storage-safe file name (original name is kept in the DB row). */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const ext = extensionOf(base);
  const stem = ext ? base.slice(0, base.length - ext.length - 1) : base;
  const clean = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[._-]+|[._-]+$/g, '');
  const safeStem = clean(stem).slice(0, 80) || 'file';
  const safeExt = clean(ext).slice(0, 10);
  return safeExt ? `${safeStem}.${safeExt}` : safeStem;
}

export function buildStoragePath(
  ownerId: string,
  documentId: string,
  versionId: string,
  fileName: string,
): string {
  return `${ownerId}/${documentId}/${versionId}-${sanitizeFileName(fileName)}`;
}

export interface DocumentFilterInput {
  category: DocumentCategory | 'all';
  state: ExpiryState | 'all';
  customerId: string | 'all';
  query: string;
}

export function filterDocuments(
  docs: DocumentRecord[],
  f: DocumentFilterInput,
  now: Date = new Date(),
): DocumentRecord[] {
  const q = f.query.trim().toLowerCase();
  return docs.filter((d) => {
    if (f.category !== 'all' && d.category !== f.category) return false;
    if (f.customerId !== 'all' && d.customer_id !== f.customerId) return false;
    if (f.state !== 'all' && getExpiryState(d.expires_on, d.alert_days, now) !== f.state)
      return false;
    if (q) {
      const hay = [d.title, d.reference_number, d.issuer, d.customer?.name, d.current_file_name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function summarizeDocuments(docs: DocumentRecord[], now: Date = new Date()) {
  const counts = { total: docs.length, expired: 0, expiring: 0, valid: 0, none: 0 };
  for (const d of docs) counts[getExpiryState(d.expires_on, d.alert_days, now)] += 1;
  return counts;
}

export interface DocumentInput {
  title: string;
  category: DocumentCategory;
  reference_number: string;
  issuer: string;
  issued_on: string;
  expires_on: string;
  alert_days: number;
  notes: string;
  customer_id: string | null;
}

export function validateDocumentInput(input: DocumentInput): string | null {
  if (!input.title.trim()) return 'Give the document a title.';
  if (input.issued_on && input.expires_on && input.expires_on < input.issued_on) {
    return 'The expiry date cannot be before the issue date.';
  }
  return null;
}
