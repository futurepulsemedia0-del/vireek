/**
 * Video quotes - network layer.
 *
 * Technician side : RLS-scoped reads + SECURITY DEFINER RPCs + one authenticated edge function.
 * Customer side   : ONLY the `quote-video-public` edge function (no direct table / storage access).
 */

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import {
  DEFAULT_RETENTION_DAYS,
  buildStoragePath,
  friendlyVideoError,
  uploadErrorMessage,
  validateUpload,
  type PublicQuoteVideo,
  type QuoteVideoRow,
} from '@/lib/quoteVideo';

const BUCKET = 'quote-videos';
const PREVIEW_TTL_SECONDS = 600;

const VIDEO_COLUMNS =
  'id, quote_id, title, note, storage_path, mime_type, size_bytes, duration_seconds, shared, shared_at, view_count, first_viewed_at, last_viewed_at, max_progress, completed_at, acknowledged_at, acknowledged_name, created_at';

export class QuoteVideoError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'QuoteVideoError';
  }
}

async function edgeErrorCode(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const body = (await error.context.json().catch(() => null)) as { error?: string } | null;
    return body?.error ?? 'INTERNAL';
  }
  return 'INTERNAL';
}

function fail(code: string, fallback?: string): never {
  throw new QuoteVideoError(code, friendlyVideoError(code, fallback));
}

function randomId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

// ============================================================
// TECHNICIAN
// ============================================================

export async function listQuoteVideos(quoteId: string): Promise<QuoteVideoRow[]> {
  const { data, error } = await supabase
    .from('quote_videos')
    .select(VIDEO_COLUMNS)
    .eq('quote_id', quoteId)
    .is('deleted_at', null)
    .is('purged_at', null)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as QuoteVideoRow[];
}

/** Uploads the file, then registers it. The server re-verifies the object, path, size and per-quote cap. */
export async function uploadQuoteVideo(input: {
  ownerId: string;
  quoteId: string;
  blob: Blob;
  fileName?: string;
  title: string;
  note: string;
  durationSeconds: number | null;
}): Promise<QuoteVideoRow> {
  const check = validateUpload({
    type: input.blob.type,
    fileName: input.fileName,
    sizeBytes: input.blob.size,
    durationSeconds: input.durationSeconds,
  });
  if (!check.ok) throw new QuoteVideoError(check.code, uploadErrorMessage(check.code));

  const path = buildStoragePath(input.ownerId, input.quoteId, randomId(), check.mime);
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, input.blob, { upsert: false, contentType: check.mime, cacheControl: '3600' });
  if (uploadError) throw new QuoteVideoError('UPLOAD_FAILED', `Upload failed: ${uploadError.message}`);

  const { data, error } = await supabase.rpc('create_quote_video', {
    p_quote_id: input.quoteId,
    p_path: path,
    p_title: input.title.trim() || 'Explanation of findings',
    p_note: input.note.trim() || null,
    p_mime: check.mime,
    p_size: input.blob.size,
    p_duration: input.durationSeconds != null ? Math.max(1, Math.round(input.durationSeconds)) : null,
  });
  if (error) {
    // Registration failed: remove the unregistered file (allowed by the bucket's delete policy).
    await supabase.storage.from(BUCKET).remove([path]).catch(() => undefined);
    fail(error.message);
  }
  return data as QuoteVideoRow;
}

export async function setQuoteVideoShared(id: string, shared: boolean): Promise<QuoteVideoRow> {
  const { data, error } = await supabase.rpc('set_quote_video_shared', { p_id: id, p_shared: shared });
  if (error) fail(error.message);
  return data as QuoteVideoRow;
}

export async function deleteQuoteVideo(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_quote_video', { p_id: id });
  if (error) fail(error.message);
}

/** Short-lived signed URL so the technician can preview before sharing. */
export async function signQuoteVideoPreview(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, PREVIEW_TTL_SECONDS);
  if (error || !data?.signedUrl) throw new QuoteVideoError('SIGN_FAILED', 'Could not load the preview. Please try again.');
  return data.signedUrl;
}

export async function getQuoteVideoRetentionDays(): Promise<number> {
  const { data, error } = await supabase.from('quote_video_settings').select('retention_days').maybeSingle();
  if (error) throw error;
  return (data as { retention_days?: number } | null)?.retention_days ?? DEFAULT_RETENTION_DAYS;
}

export async function setQuoteVideoRetentionDays(days: number): Promise<number> {
  const { data, error } = await supabase.rpc('set_quote_video_retention', { p_days: days });
  if (error) fail(error.message);
  return data as number;
}

export interface LiveSessionInfo {
  sessionId: string;
  url: string;
  expiresAt: string;
}

export async function startLiveEstimate(quoteId: string, displayName: string): Promise<LiveSessionInfo> {
  const { data, error } = await supabase.functions.invoke('quote-video-session', {
    body: { action: 'start', quote_id: quoteId, display_name: displayName },
  });
  if (error) fail(await edgeErrorCode(error));
  return { sessionId: data.session_id, url: data.url, expiresAt: data.expires_at };
}

export async function endLiveEstimate(sessionId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('quote-video-session', {
    body: { action: 'end', session_id: sessionId },
  });
  if (error) fail(await edgeErrorCode(error));
}

// ============================================================
// CUSTOMER (public edge function only)
// ============================================================

export interface PublicVideoState {
  videos: PublicQuoteVideo[];
  live: boolean;
  quoteStatus: string;
}

/** Never throws: the video section is supplementary and must not break the quote page. */
export async function fetchPublicQuoteVideos(token: string): Promise<PublicVideoState | null> {
  const { data, error } = await supabase.functions.invoke('quote-video-public', { body: { action: 'list', token } });
  if (error || !data) return null;
  return {
    videos: (data.videos ?? []) as PublicQuoteVideo[],
    live: Boolean(data.live),
    quoteStatus: String(data.quote_status ?? ''),
  };
}

export async function fetchLiveStatus(token: string): Promise<boolean> {
  const { data, error } = await supabase.functions.invoke('quote-video-public', { body: { action: 'live_status', token } });
  return !error && Boolean(data?.live);
}

export interface VideoEventResult {
  max_progress: number;
  completed: boolean;
  acknowledged: boolean;
}

/** Fire-and-forget engagement tracking (viewed / progress / completed). Failures are silent by design. */
export function trackVideoEvent(token: string, videoId: string, event: 'viewed' | 'progress' | 'completed', progress?: number): void {
  void supabase.functions
    .invoke('quote-video-public', { body: { action: 'event', token, video_id: videoId, event, progress } })
    .catch(() => undefined);
}

export async function acknowledgeVideo(token: string, videoId: string, name: string): Promise<VideoEventResult> {
  const { data, error } = await supabase.functions.invoke('quote-video-public', {
    body: { action: 'event', token, video_id: videoId, event: 'acknowledged', name },
  });
  if (error) fail(await edgeErrorCode(error));
  return data.result as VideoEventResult;
}

export async function joinLiveEstimate(token: string, name: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('quote-video-public', {
    body: { action: 'join_live', token, name },
  });
  if (error) fail(await edgeErrorCode(error));
  return data.url as string;
}
