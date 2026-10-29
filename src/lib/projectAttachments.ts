// Project attachments — pure types and rules shared by Submittals and Punch
// Lists. No Supabase import (see projectAttachmentsApi.ts).
// Keep ALLOWED_MIME_TYPES and MAX_ATTACHMENT_BYTES in sync with the
// `project-attachments` bucket in the submittals_punch_lists migration.

export type AttachmentPurpose = 'package' | 'review' | 'before' | 'after' | 'general';
export type AttachmentParent = { kind: 'submittal_revision'; id: string } | { kind: 'punch_item'; id: string };

export interface ProjectAttachment {
  id: string;
  user_id: string;
  project_id: string;
  submittal_revision_id: string | null;
  punch_item_id: string | null;
  purpose: AttachmentPurpose;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  caption: string | null;
  uploaded_by: string | null;
  created_at: string;
}

export const ATTACHMENT_BUCKET = 'project-attachments';
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_PARENT = 30;

export const PURPOSE_LABEL: Record<AttachmentPurpose, string> = {
  package: 'Submittal package',
  review: 'Reviewer markup',
  before: 'Before',
  after: 'After',
  general: 'General',
};

const EXTENSION_MIME: Record<string, string> = {
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
  csv: 'text/csv',
  txt: 'text/plain',
};

export const ALLOWED_MIME_TYPES: readonly string[] = [...new Set(Object.values(EXTENSION_MIME))];
export const FILE_INPUT_ACCEPT = ALLOWED_MIME_TYPES.join(',');

/** Browsers often report '' (or octet-stream) for HEIC and Office files — fall back to the extension. */
export function resolveMime(file: { name: string; type: string }): string {
  const declared = (file.type || '').toLowerCase().split(';')[0].trim();
  if (declared && declared !== 'application/octet-stream') return declared;
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  return EXTENSION_MIME[ext] ?? declared;
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

/** HEIC/HEIF cannot be rendered by most browsers — show a file tile instead of a thumbnail. */
export function canPreviewInline(mime: string): boolean {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(mime);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Safe storage file name: no path parts, ASCII only, ≤ 80 chars, extension kept. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const rawStem = dot > 0 ? base.slice(0, dot) : base;
  const rawExt = dot > 0 ? base.slice(dot + 1) : '';
  const clean = (s: string) => s.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const stem = clean(rawStem).slice(0, 60) || 'file';
  const ext = clean(rawExt).slice(0, 8).toLowerCase();
  return ext ? `${stem}.${ext}` : stem;
}

/** `<owner>/<project>/<uuid>-<name>` — the first folder is the tenant (enforced by storage policy). */
export function buildStoragePath(ownerId: string, projectId: string, fileName: string, uuid: string): string {
  return `${ownerId}/${projectId}/${uuid}-${sanitizeFileName(fileName)}`;
}

export type FileCheck = { ok: true; mime: string } | { ok: false; error: string };

export function validateAttachmentFile(file: { name: string; type: string; size: number }, existingCount: number): FileCheck {
  if (existingCount >= MAX_ATTACHMENTS_PER_PARENT) return { ok: false, error: `You can attach up to ${MAX_ATTACHMENTS_PER_PARENT} files here.` };
  if (!Number.isFinite(file.size) || file.size <= 0) return { ok: false, error: `“${file.name}” is empty.` };
  if (file.size > MAX_ATTACHMENT_BYTES) return { ok: false, error: `“${file.name}” is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.` };
  const mime = resolveMime(file);
  if (!ALLOWED_MIME_TYPES.includes(mime)) return { ok: false, error: `“${file.name}” is not a supported file type. Use PDF, photos, Word, Excel, CSV or text.` };
  return { ok: true, mime };
}

export function countByPurpose(items: Pick<ProjectAttachment, 'purpose'>[], purpose: AttachmentPurpose): number {
  return items.filter((a) => a.purpose === purpose).length;
}
