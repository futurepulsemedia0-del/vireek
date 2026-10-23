// supabase/functions/_shared/quote-video/engine.ts
//
// Pure rules for Video Quotes / Video Messages / Live Video Estimates.
// No Deno / DOM / network access on purpose: the edge functions, the React app
// (src/lib/quoteVideo.ts) and the Vitest suite all import this one file, so the
// limits and validation can never drift apart.

export const QUOTE_VIDEO_BUCKET = "quote-videos";
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
/** Hard cap for an in-app recording (keeps files ~30 MB at the default bitrate). */
export const MAX_RECORD_SECONDS = 180;
/** Hard cap for an uploaded file's reported duration. */
export const MAX_UPLOAD_SECONDS = 600;
export const MAX_VIDEOS_PER_QUOTE = 5;
export const DEFAULT_RETENTION_DAYS = 365;
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 1825;
export const SIGNED_URL_TTL_SECONDS = 1800;
export const LIVE_ROOM_TTL_SECONDS = 2 * 60 * 60;
export const MAX_CUSTOMER_JOINS = 12;
/** Watching this far counts as "watched" (people skip the closing seconds). */
export const WATCHED_THRESHOLD_PERCENT = 90;

export const ALLOWED_VIDEO_MIME = ["video/mp4", "video/webm", "video/quicktime"] as const;
export type QuoteVideoMime = (typeof ALLOWED_VIDEO_MIME)[number];

export const EXT_BY_MIME: Record<QuoteVideoMime, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

export type PublicVideoEvent = "viewed" | "progress" | "completed" | "acknowledged";
export const PUBLIC_VIDEO_EVENTS: readonly PublicVideoEvent[] = ["viewed", "progress", "completed", "acknowledged"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Strip codec parameters and map browser quirks onto the bucket's allow-list. */
export function normalizeVideoMime(rawType: string | null | undefined, fileName = ""): QuoteVideoMime | null {
  const base = (rawType ?? "").split(";")[0].trim().toLowerCase();
  if ((ALLOWED_VIDEO_MIME as readonly string[]).includes(base)) return base as QuoteVideoMime;
  if (base === "video/x-m4v" || base === "video/3gpp") return "video/mp4";
  if (base === "" || base === "application/octet-stream") {
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
    if (lower.endsWith(".mov")) return "video/quicktime";
    if (lower.endsWith(".webm")) return "video/webm";
  }
  return null;
}

export type UploadCheck = { ok: true; mime: QuoteVideoMime } | { ok: false; code: "TYPE" | "SIZE" | "EMPTY" | "DURATION" };

export function validateUpload(input: {
  type: string | null | undefined;
  fileName?: string;
  sizeBytes: number;
  durationSeconds?: number | null;
}): UploadCheck {
  const mime = normalizeVideoMime(input.type, input.fileName);
  if (!mime) return { ok: false, code: "TYPE" };
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) return { ok: false, code: "EMPTY" };
  if (input.sizeBytes > MAX_VIDEO_BYTES) return { ok: false, code: "SIZE" };
  const d = input.durationSeconds;
  if (d != null && Number.isFinite(d) && d > MAX_UPLOAD_SECONDS) return { ok: false, code: "DURATION" };
  return { ok: true, mime };
}

/** <owner>/<quote>/<file> - must match the regex enforced in create_quote_video(). */
export function buildStoragePath(ownerId: string, quoteId: string, fileId: string, mime: QuoteVideoMime): string {
  return `${ownerId}/${quoteId}/${fileId}.${EXT_BY_MIME[mime]}`;
}

export function isPathForQuote(path: unknown, ownerId: string, quoteId: string): boolean {
  if (typeof path !== "string" || !isUuid(ownerId) || !isUuid(quoteId)) return false;
  const prefix = `${ownerId}/${quoteId}/`;
  if (!path.startsWith(prefix)) return false;
  return /^[A-Za-z0-9._-]{1,120}$/.test(path.slice(prefix.length));
}

/** Whole-percent playback progress, clamped to 0-100. */
export function watchPercent(currentTime: number, duration: number): number {
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((currentTime / duration) * 100)));
}

/** The 25 / 50 / 75 / 90 / 100 step a progress value belongs to (0 below 25). */
export function progressStep(percent: number): 0 | 25 | 50 | 75 | 90 | 100 {
  if (percent >= 100) return 100;
  if (percent >= WATCHED_THRESHOLD_PERCENT) return 90;
  if (percent >= 75) return 75;
  if (percent >= 50) return 50;
  if (percent >= 25) return 25;
  return 0;
}

export function isWatched(maxProgress: number): boolean {
  return maxProgress >= WATCHED_THRESHOLD_PERCENT;
}

export type ParsedEventBody =
  | { ok: true; videoId: string; event: PublicVideoEvent; progress: number | null; name: string | null }
  | { ok: false; error: string };

export function sanitizeDisplayName(raw: unknown, fallback: string, max = 60): string {
  if (typeof raw !== "string") return fallback;
  // Drop control characters, collapse whitespace.
  // deno-lint-ignore no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return cleaned || fallback;
}

export function parseEventBody(body: Record<string, unknown> | null): ParsedEventBody {
  if (!body) return { ok: false, error: "INVALID_BODY" };
  if (!isUuid(body.video_id)) return { ok: false, error: "INVALID_VIDEO" };
  const event = body.event;
  if (typeof event !== "string" || !(PUBLIC_VIDEO_EVENTS as readonly string[]).includes(event)) {
    return { ok: false, error: "INVALID_EVENT" };
  }
  let progress: number | null = null;
  if (event === "progress") {
    const p = Number(body.progress);
    if (!Number.isFinite(p)) return { ok: false, error: "INVALID_PROGRESS" };
    progress = Math.max(0, Math.min(100, Math.floor(p)));
  }
  let name: string | null = null;
  if (event === "acknowledged") {
    name = sanitizeDisplayName(body.name, "", 120);
    if (!name) return { ok: false, error: "NAME_REQUIRED" };
  }
  return { ok: true, videoId: body.video_id, event: event as PublicVideoEvent, progress, name };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export function clampRetentionDays(days: unknown): number {
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  return Math.max(MIN_RETENTION_DAYS, Math.min(MAX_RETENTION_DAYS, n));
}

/**
 * When a video becomes deletable: retention_days after the LATER of upload and
 * the customer's response. Mirrors quote_videos_due_for_purge() in SQL.
 */
export function retentionExpiry(createdAt: Date, respondedAt: Date | null, retentionDays: number): Date {
  const anchor = respondedAt && respondedAt.getTime() > createdAt.getTime() ? respondedAt : createdAt;
  return new Date(anchor.getTime() + clampRetentionDays(retentionDays) * 86_400_000);
}

export function isPurgeDue(input: {
  createdAt: Date;
  respondedAt: Date | null;
  retentionDays: number;
  deletedAt: Date | null;
  quoteDeleted: boolean;
  legalHold: boolean;
  now: Date;
}): boolean {
  if (input.legalHold) return false;
  if (input.deletedAt || input.quoteDeleted) return true;
  return retentionExpiry(input.createdAt, input.respondedAt, input.retentionDays).getTime() < input.now.getTime();
}

// ---------------------------------------------------------------------------
// Live sessions
// ---------------------------------------------------------------------------

export type LiveSessionLike = { status: string; expires_at: string; customer_join_count?: number | null };
export type LiveState = "none" | "live" | "expired" | "ended";

export function liveSessionState(session: LiveSessionLike | null | undefined, now: Date): LiveState {
  if (!session) return "none";
  if (session.status === "ended") return "ended";
  if (new Date(session.expires_at).getTime() <= now.getTime()) return "expired";
  return "live";
}

export function canCustomerJoin(session: LiveSessionLike | null | undefined, now: Date): boolean {
  return liveSessionState(session, now) === "live" && (session?.customer_join_count ?? 0) < MAX_CUSTOMER_JOINS;
}

/** Unguessable, non-identifying room name (Daily allows A-Z a-z 0-9 _ -). */
export function buildRoomName(randomHex: string): string {
  const clean = randomHex.replace(/[^a-f0-9]/gi, "").toLowerCase().slice(0, 24);
  return `vq-${clean}`;
}

export function secondsFromNow(now: Date, seconds: number): number {
  return Math.floor(now.getTime() / 1000) + seconds;
}
