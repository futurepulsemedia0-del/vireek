/**
 * Live video sessions (technician <-> remote expert) — pure logic.
 * No network, no DOM: everything here is unit-tested in videoSession.test.ts.
 * The API layer lives in videoSessionApi.ts, the WebRTC engine in videoCallEngine.ts.
 */

// ============================================================
// TYPES
// ============================================================

export type CallRole = 'technician' | 'expert';
export type StoredStatus = 'waiting' | 'live' | 'ended' | 'cancelled';
export type VideoSessionStatus = StoredStatus | 'expired';

export interface VideoSessionRow {
  id: string;
  user_id: string;
  job_id: string;
  created_by: string;
  created_by_name: string | null;
  join_token: string;
  title: string;
  expert_label: string | null;
  status: StoredStatus;
  recording_allowed: boolean;
  expires_at: string;
  technician_joined_at: string | null;
  expert_joined_at: string | null;
  expert_name: string | null;
  expert_consented_at: string | null;
  last_heartbeat_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  ended_by: 'technician' | 'manager' | null;
  duration_seconds: number | null;
  created_at: string;
}

export interface VideoClipRow {
  id: string;
  session_id: string;
  job_id: string;
  storage_path: string;
  mime: 'video/webm' | 'video/mp4';
  size_bytes: number;
  duration_seconds: number;
  sha256: string;
  recorded_by_name: string | null;
  created_at: string;
}

/** What the token RPC returns (display-safe; no customer data). */
export interface PublicSession {
  id: string;
  title: string;
  status: VideoSessionStatus;
  expires_at: string;
  business_name: string | null;
  technician_name: string | null;
  expert_label: string | null;
  recording_allowed: boolean;
  expert_consented: boolean;
  role: CallRole;
  owner_id: string | null;
  job_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
}

export interface JoinResult {
  session_id: string;
  role: CallRole;
  status: VideoSessionStatus;
  recording_allowed: boolean;
  expert_consented: boolean;
}

// ============================================================
// LIMITS & CONSTANTS
// ============================================================

export const LIMITS = {
  NAME_MIN: 2,
  NAME_MAX: 60,
  TITLE_MAX: 120,
  LABEL_MAX: 80,
  MAX_CLIP_SECONDS: 300,
  HEARTBEAT_MS: 30_000,
  STATS_MS: 3_000,
  VIDEO_BITRATE: 1_200_000,
  AUDIO_BITRATE: 64_000,
} as const;

export const TTL_OPTIONS = [
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 240, label: '4 hours' },
  { minutes: 1440, label: '24 hours' },
] as const;

export const DEFAULT_TTL_MINUTES = 240;
export const CLIPS_BUCKET = 'video-session-clips';
export const TOKEN_RE = /^[0-9a-f]{64}$/;

export const FALLBACK_ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

// ============================================================
// TOKENS & LINKS
// ============================================================

export function isValidToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

export function buildJoinUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/live/${token}`;
}

/** Accepts a full join URL or a bare token; returns the token or null. */
export function extractToken(input: string): string | null {
  const m = input.trim().match(/[0-9a-f]{64}/i);
  return m ? m[0].toLowerCase() : null;
}

export function buildShare(url: string, opts: { business?: string | null; title: string }) {
  const who = opts.business ? `${opts.business} needs your help` : 'You are invited to a live video session';
  const text = `${who}: "${opts.title}". Join from any phone or computer, no account needed: ${url}`;
  return {
    text,
    smsHref: `sms:?&body=${encodeURIComponent(text)}`,
    mailHref: `mailto:?subject=${encodeURIComponent(`Live video session: ${opts.title}`)}&body=${encodeURIComponent(text)}`,
  };
}

// ============================================================
// STATUS & TIME
// ============================================================

/** Mirrors video_session_effective_status() in SQL so lists agree with the server. */
export function effectiveStatus(
  row: Pick<VideoSessionRow, 'status' | 'expires_at' | 'last_heartbeat_at' | 'started_at' | 'created_at'>,
  now: number = Date.now(),
): VideoSessionStatus {
  if (row.status === 'ended' || row.status === 'cancelled') return row.status;
  if (row.status === 'waiting' && new Date(row.expires_at).getTime() < now) return 'expired';
  if (row.status === 'live') {
    const seen = new Date(row.last_heartbeat_at ?? row.started_at ?? row.created_at).getTime();
    if (Number.isFinite(seen) && seen < now - 90_000) return 'ended';
  }
  return row.status;
}

export const STATUS_META: Record<VideoSessionStatus, { label: string; tone: 'success' | 'warning' | 'neutral' | 'danger' }> = {
  waiting: { label: 'Waiting for expert', tone: 'warning' },
  live: { label: 'Live now', tone: 'success' },
  ended: { label: 'Ended', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  expired: { label: 'Link expired', tone: 'danger' },
};

export function isJoinable(status: VideoSessionStatus): boolean {
  return status === 'waiting' || status === 'live';
}

export function formatDuration(totalSeconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function expiresInLabel(expiresAt: string, now: number = Date.now()): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'expired';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `expires in ${Math.max(1, mins)} min`;
  const hours = Math.round(mins / 60);
  return `expires in ${hours} h`;
}

// ============================================================
// VALIDATION
// ============================================================

export function validateDisplayName(name: string): string | null {
  const t = name.trim();
  if (t.length < LIMITS.NAME_MIN) return 'Enter your name so the technician knows who joined.';
  if (t.length > LIMITS.NAME_MAX) return `Keep your name under ${LIMITS.NAME_MAX} characters.`;
  return null;
}

export function validateStartForm(input: { title: string; expertLabel: string }): { title?: string; expertLabel?: string } {
  const errors: { title?: string; expertLabel?: string } = {};
  const t = input.title.trim();
  if (!t) errors.title = 'Give the session a short title.';
  else if (t.length > LIMITS.TITLE_MAX) errors.title = `Keep the title under ${LIMITS.TITLE_MAX} characters.`;
  if (input.expertLabel.trim().length > LIMITS.LABEL_MAX) errors.expertLabel = `Keep this under ${LIMITS.LABEL_MAX} characters.`;
  return errors;
}

export function ttlToIso(minutes: number, now: number = Date.now()): string {
  const allowed = TTL_OPTIONS.some((o) => o.minutes === minutes) ? minutes : DEFAULT_TTL_MINUTES;
  return new Date(now + allowed * 60_000).toISOString();
}

// ============================================================
// RECORDING
// ============================================================

/** MP4 first (seekable everywhere), then WebM. */
const RECORDER_CANDIDATES: { mime: string; base: 'video/mp4' | 'video/webm'; ext: 'mp4' | 'webm' }[] = [
  { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', base: 'video/mp4', ext: 'mp4' },
  { mime: 'video/mp4', base: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', base: 'video/webm', ext: 'webm' },
  { mime: 'video/webm;codecs=vp8,opus', base: 'video/webm', ext: 'webm' },
  { mime: 'video/webm', base: 'video/webm', ext: 'webm' },
];

export function pickRecorderMime(isSupported: (mime: string) => boolean) {
  for (const c of RECORDER_CANDIDATES) {
    try {
      if (isSupported(c.mime)) return c;
    } catch {
      /* ignore and try the next candidate */
    }
  }
  return null;
}

export function clipStoragePath(ownerId: string, sessionId: string, clipId: string, ext: 'mp4' | 'webm'): string {
  return `${ownerId}/${sessionId}/${clipId}.${ext}`;
}

export interface RecordGate {
  role: CallRole;
  recordingAllowed: boolean;
  expertConsented: boolean;
  connected: boolean;
  hasLocalVideo: boolean;
  recorderSupported: boolean;
}

export function recordGate(g: RecordGate): { ok: boolean; reason: string | null } {
  if (g.role !== 'technician') return { ok: false, reason: 'Only the technician can record.' };
  if (!g.recordingAllowed) return { ok: false, reason: 'Recording is turned off for this session.' };
  if (!g.recorderSupported) return { ok: false, reason: 'This browser cannot record video.' };
  if (!g.connected) return { ok: false, reason: 'Connect with the expert to record.' };
  if (!g.hasLocalVideo) return { ok: false, reason: 'Your camera is not available.' };
  if (!g.expertConsented) return { ok: false, reason: 'The expert has not agreed to recording.' };
  return { ok: true, reason: null };
}

// ============================================================
// CONNECTION QUALITY
// ============================================================

export type ConnectionQuality = 'good' | 'fair' | 'poor' | 'unknown';

export function assessQuality(s: { rttMs: number | null; lossPct: number | null; bitrateKbps: number | null; expectVideo: boolean }): ConnectionQuality {
  const { rttMs, lossPct, bitrateKbps, expectVideo } = s;
  if (rttMs == null && lossPct == null && bitrateKbps == null) return 'unknown';
  if ((rttMs ?? 0) > 400 || (lossPct ?? 0) > 8 || (expectVideo && bitrateKbps != null && bitrateKbps < 60)) return 'poor';
  if ((rttMs ?? 0) > 200 || (lossPct ?? 0) > 3 || (expectVideo && bitrateKbps != null && bitrateKbps < 200)) return 'fair';
  return 'good';
}

export function reconnectDelay(attempt: number): number {
  return Math.min(10_000, 1_000 * 2 ** Math.max(0, attempt));
}

// ============================================================
// ICE SERVERS
// ============================================================

/** Never trust the response shape: keep only well-formed entries, fall back to public STUN. */
export function sanitizeIceServers(raw: unknown): RTCIceServer[] {
  if (!Array.isArray(raw)) return FALLBACK_ICE;
  const out: RTCIceServer[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = (Array.isArray(r.urls) ? r.urls : [r.urls]).filter(
      (u): u is string => typeof u === 'string' && /^(stun|stuns|turn|turns):/.test(u),
    );
    if (urls.length === 0) continue;
    const entry: RTCIceServer = { urls };
    if (typeof r.username === 'string') entry.username = r.username;
    if (typeof r.credential === 'string') entry.credential = r.credential;
    out.push(entry);
  }
  return out.length ? out : FALLBACK_ICE;
}

export function hasRelay(servers: RTCIceServer[]): boolean {
  return servers.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/.test(u)));
}

// ============================================================
// SIGNALING MESSAGES (untrusted input)
// ============================================================

export type SignalMessage =
  | { type: 'offer'; from: string; to: string; sdp: string; restart?: boolean }
  | { type: 'answer'; from: string; to: string; sdp: string }
  | { type: 'ice'; from: string; to: string; candidate: RTCIceCandidateInit }
  | { type: 'restart'; from: string; to: string }
  | { type: 'recording'; from: string; on: boolean }
  | { type: 'bye'; from: string };

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_SDP = 60_000;

export function parseSignal(raw: unknown): SignalMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.from !== 'string' || !ID_RE.test(m.from)) return null;
  const to = typeof m.to === 'string' && ID_RE.test(m.to) ? m.to : null;
  switch (m.type) {
    case 'offer':
      if (!to || typeof m.sdp !== 'string' || m.sdp.length === 0 || m.sdp.length > MAX_SDP) return null;
      return { type: 'offer', from: m.from, to, sdp: m.sdp, restart: m.restart === true };
    case 'answer':
      if (!to || typeof m.sdp !== 'string' || m.sdp.length === 0 || m.sdp.length > MAX_SDP) return null;
      return { type: 'answer', from: m.from, to, sdp: m.sdp };
    case 'ice': {
      const c = m.candidate as { candidate?: unknown; sdpMid?: unknown; sdpMLineIndex?: unknown } | null;
      if (!to || !c || typeof c.candidate !== 'string' || c.candidate.length > 2_000) return null;
      return {
        type: 'ice',
        from: m.from,
        to,
        candidate: {
          candidate: c.candidate,
          sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid : null,
          sdpMLineIndex: typeof c.sdpMLineIndex === 'number' ? c.sdpMLineIndex : null,
        },
      };
    }
    case 'restart':
      return to ? { type: 'restart', from: m.from, to } : null;
    case 'recording':
      return { type: 'recording', from: m.from, on: m.on === true };
    case 'bye':
      return { type: 'bye', from: m.from };
    default:
      return null;
  }
}

// ============================================================
// ERRORS
// ============================================================

const CODE_MESSAGES: Record<string, string> = {
  session_not_found: 'This session link is not valid. Ask for a new link.',
  session_expired: 'This link has expired. Ask the technician for a new one.',
  session_ended: 'This session has already ended.',
  name_required: 'Enter your name to join.',
  not_allowed: 'You do not have permission to do that.',
  not_authenticated: 'Please sign in and try again.',
  consent_missing: 'The expert has not agreed to recording.',
  recording_not_allowed: 'Recording is turned off for this session.',
  confirmation_required: 'Confirm that the customer on site knows about the recording.',
  upload_missing: 'The upload did not finish. Try saving the clip again.',
  invalid_clip: 'This clip could not be saved. Try recording again.',
  invalid_path: 'This clip could not be saved. Try recording again.',
  clip_not_found: 'That clip no longer exists.',
};

export function friendlyVideoError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const e = err as { message?: unknown; code?: unknown; name?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : '';
  for (const code of Object.keys(CODE_MESSAGES)) if (message.includes(code)) return CODE_MESSAGES[code];
  if (e?.code === '42501' || /row-level security|permission denied/i.test(message)) return 'You do not have access to this job.';
  if (/Failed to fetch|NetworkError|network/i.test(message)) return 'No connection. Check your internet and try again.';
  return fallback;
}

export type MediaIssueKind = 'denied' | 'not-found' | 'in-use' | 'insecure' | 'unsupported' | 'other';

export function classifyMediaError(err: unknown): { kind: MediaIssueKind; message: string } {
  const name = (err as { name?: unknown } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return { kind: 'denied', message: 'Camera or microphone access is blocked. Allow it in your browser settings, then try again.' };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return { kind: 'not-found', message: 'No camera or microphone was found on this device.' };
    case 'NotReadableError':
    case 'TrackStartError':
      return { kind: 'in-use', message: 'Your camera or microphone is being used by another app. Close it and try again.' };
    default:
      return { kind: 'other', message: 'We could not start your camera or microphone.' };
  }
}
