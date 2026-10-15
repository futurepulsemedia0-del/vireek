import { supabase } from '@/lib/supabase';

export type MessageKind = 'text' | 'photo' | 'audio';
export type SenderRole = 'technician' | 'office';

export interface JobMessage {
  id: string;
  job_id: string;
  sender_user_id: string;
  sender_role: SenderRole;
  kind: MessageKind;
  body: string | null;
  media_path: string | null;
  media_mime: string | null;
  media_duration_ms: number | null;
  client_id: string | null;
  created_at: string;
}

export interface ThreadSummary {
  job_id: string;
  customer_name: string;
  address: string | null;
  service_type: string | null;
  job_status: string;
  scheduled_datetime: string | null;
  last_kind: MessageKind | null;
  last_body: string | null;
  last_sender_role: SenderRole | null;
  last_message_at: string | null;
  unread_count: number;
}

export const MEDIA_BUCKET = 'job-message-media';
export const MAX_TEXT_LENGTH = 4000;
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
export const MAX_VOICE_SECONDS = 120;
const PAGE_SIZE = 50;
const MESSAGE_COLUMNS =
  'id, job_id, sender_user_id, sender_role, kind, body, media_path, media_mime, media_duration_ms, client_id, created_at';

// ---------- pure helpers (unit-tested) ----------

export function newClientId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
}

export function mimeToExt(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase();
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
    'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg',
  };
  return map[base] ?? 'bin';
}

/** Bucket allow-list rejects `audio/webm;codecs=opus`; always send the bare type. */
export function baseMime(mime: string): string {
  return mime.split(';')[0].trim().toLowerCase();
}

export function buildMediaPath(ownerId: string, jobId: string, mime: string): string {
  return `${ownerId}/${jobId}/${newClientId()}.${mimeToExt(mime)}`;
}

export function pickRecorderMime(isSupported: (m: string) => boolean): string | undefined {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => isSupported(m));
}

export function validatePhoto(file: Pick<File, 'type' | 'size'>): string | null {
  if (!file.type.startsWith('image/')) return 'Please choose an image file.';
  if (file.size > MAX_PHOTO_BYTES) return 'That photo is larger than 15 MB.';
  return null;
}

export function formatDuration(ms: number | null | undefined): string {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function previewText(s: Pick<ThreadSummary, 'last_kind' | 'last_body' | 'last_sender_role'>, viewer: SenderRole): string {
  if (!s.last_kind) return 'No messages yet';
  const prefix = s.last_sender_role === viewer ? 'You: ' : '';
  if (s.last_kind === 'photo') return `${prefix}📷 Photo`;
  if (s.last_kind === 'audio') return `${prefix}🎙 Voice note`;
  return `${prefix}${s.last_body ?? ''}`;
}

/** Merge by id and client_id so an optimistic row and its realtime echo never duplicate. */
export function mergeMessages(existing: JobMessage[], incoming: JobMessage[]): JobMessage[] {
  const byKey = new Map<string, JobMessage>();
  for (const m of existing) byKey.set(m.client_id ?? m.id, m);
  for (const m of incoming) byKey.set(m.client_id ?? m.id, m);
  return [...byKey.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function shouldShowDayDivider(prev: JobMessage | undefined, cur: JobMessage): boolean {
  return !prev || new Date(prev.created_at).toDateString() !== new Date(cur.created_at).toDateString();
}

// ---------- API ----------

export async function fetchThreadSummaries(): Promise<ThreadSummary[]> {
  const { data, error } = await supabase.rpc('get_job_thread_summaries', { p_limit: 100 });
  if (error) throw error;
  return (data ?? []) as ThreadSummary[];
}

/** Newest-first page, returned oldest-first for rendering. */
export async function fetchMessages(jobId: string, before?: string): Promise<{ messages: JobMessage[]; hasMore: boolean }> {
  let q = supabase.from('job_messages').select(MESSAGE_COLUMNS).eq('job_id', jobId)
    .order('created_at', { ascending: false }).limit(PAGE_SIZE + 1);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as JobMessage[];
  return { messages: rows.slice(0, PAGE_SIZE).reverse(), hasMore: rows.length > PAGE_SIZE };
}

async function insertMessage(row: Record<string, unknown>): Promise<JobMessage> {
  const { data, error } = await supabase.from('job_messages').insert(row).select(MESSAGE_COLUMNS).single();
  if (error) {
    // Unique client_id hit = the first attempt actually landed; fetch it instead of failing.
    if (error.code === '23505' && typeof row.client_id === 'string') {
      const { data: existing } = await supabase.from('job_messages').select(MESSAGE_COLUMNS)
        .eq('job_id', row.job_id as string).eq('client_id', row.client_id).maybeSingle();
      if (existing) return existing as JobMessage;
    }
    throw error;
  }
  return data as JobMessage;
}

export function sendTextMessage(jobId: string, body: string, clientId = newClientId()) {
  const trimmed = body.trim();
  if (!trimmed) return Promise.reject(new Error('empty_message'));
  return insertMessage({ job_id: jobId, kind: 'text', body: trimmed.slice(0, MAX_TEXT_LENGTH), client_id: clientId });
}

async function uploadMedia(ownerId: string, jobId: string, blob: Blob, mime: string): Promise<string> {
  const path = buildMediaPath(ownerId, jobId, mime);
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, blob, { contentType: baseMime(mime), upsert: false });
  if (error) throw error;
  return path;
}

export async function sendPhotoMessage(ownerId: string, jobId: string, file: File, clientId = newClientId()) {
  const problem = validatePhoto(file);
  if (problem) throw new Error(problem);
  const prepared = await compressImage(file);
  const path = await uploadMedia(ownerId, jobId, prepared, prepared.type || file.type);
  return insertMessage({ job_id: jobId, kind: 'photo', media_path: path, media_mime: baseMime(prepared.type || file.type), client_id: clientId });
}

export async function sendAudioMessage(ownerId: string, jobId: string, blob: Blob, durationMs: number, clientId = newClientId()) {
  const mime = blob.type || 'audio/webm';
  const path = await uploadMedia(ownerId, jobId, blob, mime);
  return insertMessage({
    job_id: jobId, kind: 'audio', media_path: path, media_mime: baseMime(mime),
    media_duration_ms: Math.min(Math.round(durationMs), 600_000), client_id: clientId,
  });
}

/** Resize large camera photos (field uploads are on cellular). Falls back to the original on any failure (e.g. HEIC). */
async function compressImage(file: File, maxEdge = 1600, quality = 0.82): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 400_000) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

export async function getSignedUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrls(paths, 3600);
  if (error) throw error;
  const out: Record<string, string> = {};
  for (const row of data ?? []) if (row.path && row.signedUrl) out[row.path] = row.signedUrl;
  return out;
}

export async function markThreadRead(jobId: string): Promise<void> {
  await supabase.rpc('mark_job_thread_read', { p_job_id: jobId });
}

export async function fetchUnreadTotal(): Promise<number> {
  const rows = await fetchThreadSummaries();
  return rows.reduce((n, r) => n + r.unread_count, 0);
}
