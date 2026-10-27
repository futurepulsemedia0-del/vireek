/**
 * Live video sessions — Supabase API layer.
 * Staff reads/inserts rely on RLS; guests only call token-gated SECURITY DEFINER RPCs.
 */

import { supabase } from '@/lib/supabase';
import {
  CLIPS_BUCKET,
  FALLBACK_ICE,
  hasRelay,
  isValidToken,
  sanitizeIceServers,
  ttlToIso,
  type JoinResult,
  type PublicSession,
  type VideoClipRow,
  type VideoSessionRow,
} from '@/lib/videoSession';

const SESSION_COLUMNS =
  'id, user_id, job_id, created_by, created_by_name, join_token, title, expert_label, status, recording_allowed, expires_at, technician_joined_at, expert_joined_at, expert_name, expert_consented_at, last_heartbeat_at, started_at, ended_at, ended_by, duration_seconds, created_at';
const CLIP_COLUMNS = 'id, session_id, job_id, storage_path, mime, size_bytes, duration_seconds, sha256, recorded_by_name, created_at';

export type SessionWithJob = VideoSessionRow & { jobs: { customer_name: string | null; service_type: string | null } | null };

// ---------------- staff ----------------

export async function createVideoSession(input: {
  jobId: string;
  title: string;
  expertLabel: string;
  recordingAllowed: boolean;
  ttlMinutes: number;
}): Promise<VideoSessionRow> {
  const { data, error } = await supabase
    .from('video_sessions')
    .insert({
      job_id: input.jobId,
      title: input.title.trim(),
      expert_label: input.expertLabel.trim() || null,
      recording_allowed: input.recordingAllowed,
      expires_at: ttlToIso(input.ttlMinutes),
    })
    .select(SESSION_COLUMNS)
    .single();
  if (error) throw error;
  return data as VideoSessionRow;
}

export async function fetchJobVideoSessions(jobId: string): Promise<VideoSessionRow[]> {
  const { data, error } = await supabase
    .from('video_sessions')
    .select(SESSION_COLUMNS)
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  return (data as VideoSessionRow[]) ?? [];
}

export async function fetchVideoSessionPage(opts: { before?: string; limit?: number }): Promise<SessionWithJob[]> {
  let q = supabase
    .from('video_sessions')
    .select(`${SESSION_COLUMNS}, jobs(customer_name, service_type)`)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 30);
  if (opts.before) q = q.lt('created_at', opts.before);
  const { data, error } = await q;
  if (error) throw error;
  return (data as unknown as SessionWithJob[]) ?? [];
}

export async function fetchClips(sessionIds: string[]): Promise<VideoClipRow[]> {
  if (sessionIds.length === 0) return [];
  const { data, error } = await supabase
    .from('video_session_clips')
    .select(CLIP_COLUMNS)
    .in('session_id', sessionIds)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data as VideoClipRow[]) ?? [];
}

export async function endVideoSession(token: string): Promise<{ status: string; duration_seconds: number | null }> {
  const { data, error } = await supabase.rpc('end_video_session', { p_token: token });
  if (error) throw error;
  return data as { status: string; duration_seconds: number | null };
}

export async function getClipUrl(path: string, seconds = 3600): Promise<string> {
  const { data, error } = await supabase.storage.from(CLIPS_BUCKET).createSignedUrl(path, seconds);
  if (error || !data?.signedUrl) throw error ?? new Error('Could not open this clip.');
  return data.signedUrl;
}

export async function deleteClip(clipId: string): Promise<void> {
  const { data, error } = await supabase.rpc('delete_video_clip', { p_clip_id: clipId });
  if (error) throw error;
  if (typeof data === 'string' && data) {
    const { error: rmError } = await supabase.storage.from(CLIPS_BUCKET).remove([data]);
    if (rmError) console.warn('video clip file removal failed', rmError.message);
  }
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Uploads the file, then registers it (server re-checks consent, path and that the file exists). */
export async function uploadClip(input: {
  path: string;
  blob: Blob;
  mime: 'video/webm' | 'video/mp4';
  sessionId: string;
  durationSeconds: number;
}): Promise<VideoClipRow> {
  const sha256 = await sha256Hex(input.blob);
  const { error: upError } = await supabase.storage
    .from(CLIPS_BUCKET)
    .upload(input.path, input.blob, { contentType: input.mime, upsert: false, cacheControl: '3600' });
  // A retry after a half-finished attempt finds the file already there: that is fine.
  if (upError && !/already exists|duplicate/i.test(upError.message)) throw upError;

  const { data, error } = await supabase.rpc('attach_video_clip', {
    p_session_id: input.sessionId,
    p_storage_path: input.path,
    p_mime: input.mime,
    p_size_bytes: input.blob.size,
    p_duration_seconds: Math.max(1, Math.round(input.durationSeconds)),
    p_sha256: sha256,
    p_technician_confirmed: true,
  });
  if (error) {
    await supabase.storage.from(CLIPS_BUCKET).remove([input.path]).catch(() => undefined);
    throw error;
  }
  return data as VideoClipRow;
}

// ---------------- token (guests + technician) ----------------

export async function getPublicSession(token: string): Promise<PublicSession | null> {
  if (!isValidToken(token)) return null;
  const { data, error } = await supabase.rpc('get_video_session_public', { p_token: token });
  if (error) throw error;
  return (data as PublicSession | null) ?? null;
}

export async function joinVideoSession(token: string, displayName: string, consentRecording: boolean): Promise<JoinResult> {
  const { data, error } = await supabase.rpc('join_video_session', {
    p_token: token,
    p_display_name: displayName.trim() || null,
    p_consent_recording: consentRecording,
  });
  if (error) throw error;
  return data as JoinResult;
}

export async function sendHeartbeat(token: string): Promise<string> {
  const { data, error } = await supabase.rpc('video_session_heartbeat', { p_token: token });
  if (error) throw error;
  return String(data ?? 'not_found');
}

/** TURN credentials come from the video-ice edge function; STUN-only is the safe fallback. */
export async function fetchIceServers(token: string): Promise<{ iceServers: RTCIceServer[]; relay: boolean }> {
  try {
    const { data, error } = await supabase.functions.invoke('video-ice', { body: { token } });
    if (error) throw error;
    const iceServers = sanitizeIceServers((data as { iceServers?: unknown } | null)?.iceServers);
    return { iceServers, relay: hasRelay(iceServers) };
  } catch {
    return { iceServers: FALLBACK_ICE, relay: false };
  }
}
