// supabase/functions/_shared/photo-provenance/core.ts
//
// Pure, dependency-free helpers for the photo-provenance edge function (unit-testable without Deno).
// Authoritative rules (location gates, job window, hash chain) live in SQL (20281103000000_photo_provenance.sql);
// this file only validates the request shape and re-hashes stored bytes.

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const BUCKET = "job-evidence-chain";
export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_CAPTURES_PER_HOUR = 150;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHA_RE = /^[0-9a-f]{64}$/;

export const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};
export const SOURCES = ["in_app_camera", "gallery_import", "web_input", "unknown"] as const;
export type CaptureSource = (typeof SOURCES)[number];
export const DERIVATIVE_KINDS = ["analysis_resize", "thumbnail", "redacted"] as const;
export type DerivativeKind = (typeof DERIVATIVE_KINDS)[number];

export interface StoredFile {
  path: string;
  sha256: string;
  mime: string;
  bytes: number;
}
export interface DerivativeInput extends StoredFile {
  kind: DerivativeKind;
  width: number | null;
  height: number | null;
  transform: Record<string, unknown>;
}
export interface CaptureRequest {
  jobId: string;
  clientCaptureId: string;
  original: StoredFile;
  source: CaptureSource;
  deviceCapturedAt: string | null;
  offline: boolean;
  queuedAt: string | null;
  location: { lat: number; lng: number; accuracy_m: number | null } | null;
  derivatives: DerivativeInput[];
}

type Row = Record<string, unknown>;
const isObj = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

/** Content-addressed storage path: {owner}/{job}/photo/{sha256}.{ext}. */
export function expectedPath(ownerId: string, jobId: string, sha256: string, mime: string): string {
  return `${ownerId}/${jobId}/photo/${sha256}.${MIME_EXT[mime]}`;
}

export function parseStoredFile(raw: unknown, ownerId: string, jobId: string): StoredFile {
  if (!isObj(raw)) throw new HttpError(400, "Missing file descriptor.");
  const sha256 = typeof raw.sha256 === "string" ? raw.sha256.toLowerCase() : "";
  if (!SHA_RE.test(sha256)) throw new HttpError(400, "Invalid file fingerprint.");
  const mime = typeof raw.mime === "string" ? raw.mime.toLowerCase() : "";
  if (!(mime in MIME_EXT)) throw new HttpError(400, "Unsupported image type.");
  const bytes = Number(raw.bytes);
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_BYTES) throw new HttpError(400, "Invalid file size.");
  const path = typeof raw.path === "string" ? raw.path : "";
  if (path !== expectedPath(ownerId, jobId, sha256, mime)) throw new HttpError(400, "Invalid file path.");
  return { path, sha256, mime, bytes };
}

function parseIso(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || v.length > 40) throw new HttpError(400, `Invalid ${field}.`);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new HttpError(400, `Invalid ${field}.`);
  return new Date(t).toISOString();
}

export function parseDerivative(raw: unknown, ownerId: string, jobId: string): DerivativeInput {
  const file = parseStoredFile(raw, ownerId, jobId);
  const r = raw as Row;
  const kind = String(r.kind ?? "");
  if (!(DERIVATIVE_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "Invalid derivative kind.");
  const dim = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 20000) throw new HttpError(400, "Invalid image dimensions.");
    return n;
  };
  const transform = isObj(r.transform) ? r.transform : {};
  if (JSON.stringify(transform).length > 2000) throw new HttpError(400, "Transform description too large.");
  return { ...file, kind: kind as DerivativeKind, width: dim(r.width), height: dim(r.height), transform };
}

export function parseCaptureRequest(raw: unknown, ownerId: string): CaptureRequest {
  if (!isObj(raw)) throw new HttpError(400, "Invalid request.");
  const jobId = String(raw.job_id ?? "");
  const clientCaptureId = String(raw.client_capture_id ?? "");
  if (!UUID_RE.test(jobId) || !UUID_RE.test(clientCaptureId)) throw new HttpError(400, "Invalid job or capture id.");
  const original = parseStoredFile(raw.original, ownerId, jobId);
  const source = String(raw.source ?? "unknown");
  if (!(SOURCES as readonly string[]).includes(source)) throw new HttpError(400, "Invalid capture source.");

  let location: CaptureRequest["location"] = null;
  if (raw.location !== null && raw.location !== undefined) {
    if (!isObj(raw.location)) throw new HttpError(400, "Invalid location.");
    const lat = Number(raw.location.lat);
    const lng = Number(raw.location.lng);
    const acc = raw.location.accuracy_m === null || raw.location.accuracy_m === undefined ? null : Number(raw.location.accuracy_m);
    // Out-of-range or non-numeric values are not trusted: SQL marks them 'invalid' only if they reach it, so drop here.
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (acc === null || (Number.isFinite(acc) && acc >= 0 && acc <= 100000))) {
      location = { lat, lng, accuracy_m: acc };
    }
  }

  const derivativesRaw = raw.derivatives ?? [];
  if (!Array.isArray(derivativesRaw) || derivativesRaw.length > 4) throw new HttpError(400, "At most 4 derivatives.");
  const derivatives = derivativesRaw.map((d) => parseDerivative(d, ownerId, jobId));
  if (derivatives.some((d) => d.kind === "redacted")) throw new HttpError(400, "Redacted copies are registered separately.");

  return {
    jobId,
    clientCaptureId,
    original,
    source: source as CaptureSource,
    deviceCapturedAt: parseIso(raw.device_captured_at, "device time"),
    offline: raw.offline === true,
    queuedAt: parseIso(raw.queued_at, "queued time"),
    location,
    derivatives,
  };
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", buf as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
