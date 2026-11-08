// src/lib/photoProvenance.ts
//
// Pure, dependency-free logic for job-photo provenance. No Supabase, no DOM except `crypto.subtle`.
// The authoritative rules (location gates, job window, hash chain, retention) live in SQL
// (supabase/migrations/20281103000000_photo_provenance.sql) and in the photo-provenance edge function;
// this file only (a) fingerprints bytes on the device, (b) shapes what the UI shows, (c) drives the offline queue.
//
// HONEST LIMITS (also shown in the UI, see locales/en/photoProvenance.json -> limits.*):
//  - Proves integrity since the server RECEIVED the bytes (and since capture only as far as the device clock and the
//    app are honest). It does NOT prove the work was done correctly.
//  - Device clock and GPS can be spoofed. Web/gallery photos carry no capture guarantee.

export type CaptureSource = 'in_app_camera' | 'gallery_import' | 'web_input' | 'unknown';
export type PhotoStatus = 'unmodified' | 'imported' | 'offline' | 'integrity_failed';
export type DerivativeKind = 'analysis_resize' | 'thumbnail' | 'redacted';
export type AccuracyClass = 'high' | 'medium' | 'low' | 'unknown';
export type LocationStatus =
  | 'recorded' | 'not_requested' | 'policy_off' | 'consent_not_configured' | 'no_consent'
  | 'off_duty' | 'outside_job_window' | 'invalid' | 'purged';

export interface PhotoDerivativeView {
  id: string;
  kind: DerivativeKind;
  sha256: string;
  parent_sha256: string;
  width: number | null;
  height: number | null;
  bytes: number;
  created_at: string;
  modified: boolean;
  verified: boolean;
}

export interface PhotoCaptureView {
  id: string;
  short_id: string;
  original_sha256: string;
  original_bytes: number;
  original_mime: string;
  capture_source: CaptureSource;
  device_captured_at: string | null;
  device_time_status: 'ok' | 'missing' | 'future' | 'stale';
  server_received_at: string;
  time_skew_seconds: number | null;
  offline_queued: boolean;
  status: PhotoStatus;
  flags: Array<'imported' | 'offline_capture' | 'device_time_unreliable'>;
  location: {
    status: LocationStatus;
    accuracy_m: number | null;
    accuracy_class: AccuracyClass;
    within_job_window: boolean;
    purged: boolean;
    coordinates?: { latitude: number; longitude: number } | null;
  };
  derivatives: PhotoDerivativeView[];
  verification: {
    chain_ok: boolean;
    commit_ok: boolean;
    location_commit_ok: boolean | null;
    entry_seq: number | null;
    entry_hash: string | null;
    prev_hash: string | null;
  };
  files_erased: boolean;
  erasure_requested: boolean;
}

export interface PhotoSummary {
  job_id: string;
  chain_valid: boolean;
  captures: PhotoCaptureView[];
  counts: { total: number; unmodified?: number; imported?: number; offline?: number; integrity_failed?: number; with_location?: number };
}

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const MIME_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };

// ------------------------------------------------------------------ fingerprints

export async function sha256Hex(data: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  const buf =
    data instanceof Blob ? await data.arrayBuffer() : data instanceof Uint8Array ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer) : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Content-addressed path inside the private job-evidence-chain bucket: {owner}/{job}/photo/{sha256}.{ext}. */
export function evidencePhotoPath(ownerId: string, jobId: string, sha256: string, mime: string): string {
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error('unsupported_mime');
  if (!SHA256_RE.test(sha256)) throw new Error('invalid_sha256');
  return `${ownerId}/${jobId}/photo/${sha256}.${ext}`;
}

export function normalizeMime(type: string): string {
  const t = type.toLowerCase().split(';')[0].trim();
  return t === 'image/jpg' ? 'image/jpeg' : t;
}

// ------------------------------------------------------------------ display model

export function accuracyClassFor(accuracyM: number | null | undefined): AccuracyClass {
  if (accuracyM === null || accuracyM === undefined || !Number.isFinite(accuracyM) || accuracyM < 0) return 'unknown';
  if (accuracyM <= 20) return 'high';
  if (accuracyM <= 100) return 'medium';
  return 'low';
}

/** i18n key suffix for the primary status badge (photoProvenance:status.<key>). */
export function statusKey(c: Pick<PhotoCaptureView, 'status'>): PhotoStatus {
  return c.status;
}

/** Everything a person should know before trusting the photo, as i18n keys (no prose here). */
export function trustNotes(c: PhotoCaptureView): string[] {
  const notes: string[] = [];
  if (c.status === 'integrity_failed') notes.push('note.integrityFailed');
  if (c.capture_source !== 'in_app_camera') notes.push('note.notFromAppCamera');
  if (c.offline_queued) notes.push('note.offlineDeviceTime');
  if (c.device_time_status !== 'ok') notes.push(`note.deviceTime.${c.device_time_status}`);
  if (c.time_skew_seconds !== null && Math.abs(c.time_skew_seconds) > 300 && !c.offline_queued) notes.push('note.clockSkew');
  if (c.location.status === 'recorded') notes.push(`note.locationAccuracy.${c.location.accuracy_class}`);
  else notes.push(`note.location.${c.location.status}`);
  c.derivatives.forEach((d) => {
    if (d.modified) notes.push('note.hasRedactedCopy');
  });
  return [...new Set(notes)];
}

/** Which record (original or a derivative) a locally-selected file corresponds to; null = no match. */
export function matchFileHash(
  sha256: string,
  captures: Array<Pick<PhotoCaptureView, 'id' | 'short_id' | 'original_sha256' | 'derivatives'>>,
): { captureId: string; shortId: string; as: 'original' | DerivativeKind } | null {
  const h = sha256.toLowerCase();
  for (const c of captures) {
    if (c.original_sha256 === h) return { captureId: c.id, shortId: c.short_id, as: 'original' };
    const d = c.derivatives.find((x) => x.sha256 === h);
    if (d) return { captureId: c.id, shortId: c.short_id, as: d.kind };
  }
  return null;
}

export function summaryCounts(captures: PhotoCaptureView[]): { total: number; unmodified: number; imported: number; offline: number; integrityFailed: number; withLocation: number } {
  const n = (s: PhotoStatus) => captures.filter((c) => c.status === s).length;
  return {
    total: captures.length,
    unmodified: n('unmodified'),
    imported: n('imported'),
    offline: n('offline'),
    integrityFailed: n('integrity_failed'),
    withLocation: captures.filter((c) => c.location.status === 'recorded').length,
  };
}

/** Plain-text block for proposals, invoices and dispute notes. `t` is the caller's i18n function (keys below). */
export function summaryText(
  captures: PhotoCaptureView[],
  t: (key: string, opts?: Record<string, unknown>) => string,
  formatDate: (iso: string) => string,
): string {
  const counts = summaryCounts(captures);
  const lines: string[] = [t('summary.heading'), t('summary.counts', counts)];
  captures.forEach((c, i) => {
    lines.push(
      t('summary.line', {
        n: i + 1,
        status: t(`status.${c.status}`),
        received: formatDate(c.server_received_at),
        hash: c.original_sha256.slice(0, 12),
      }),
    );
  });
  lines.push(t('limits.summary'));
  return lines.join('\n');
}

// ------------------------------------------------------------------ location capture rules (client side)

export interface PhotoSettings {
  capture_location: boolean;
  consent_required_configured: boolean;
  tracking_gate: 'allowed' | 'no_consent' | 'off_duty';
  can_manage: boolean;
  location_retention_days: number;
  photo_retention_days: number;
}

/**
 * The client only ASKS the OS for a fix when the account allows it and the gate is open. The server re-checks everything
 * (policy, consent, shift, job window) and discards coordinates that fail, so this is a privacy-minimising courtesy, not the
 * control. When settings are unknown (first run offline) the answer is no: location stays off by default.
 */
export function shouldRequestLocation(settings: PhotoSettings | null | undefined): boolean {
  return !!settings && settings.capture_location && settings.consent_required_configured && settings.tracking_gate === 'allowed';
}

// ------------------------------------------------------------------ offline queue (pure state machine)

export type QueueState = 'pending' | 'uploading' | 'done' | 'failed';

export interface QueuedCapture {
  id: string;                        // client_capture_id (idempotency key)
  job_id: string;
  owner_id: string;
  source: CaptureSource;
  /** Device clock when the photo was taken. ALWAYS labelled "device time" in the UI. */
  device_captured_at: string;
  /** Set the first time the device failed to reach the server, i.e. the photo is an offline capture. */
  queued_at: string | null;
  offline: boolean;
  location: { lat: number; lng: number; accuracy_m: number | null } | null;
  original: { sha256: string; mime: string; bytes: number };
  derivatives: Array<{ sha256: string; mime: string; bytes: number; kind: DerivativeKind; width: number | null; height: number | null; transform: Record<string, unknown> }>;
  state: QueueState;
  attempts: number;
  next_attempt_at: number;           // epoch ms
  last_error: string | null;
}

export const QUEUE_MAX_ATTEMPTS = 12;

export function queueBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(5000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000);
  return Math.round(base * (0.75 + random() * 0.5));
}

export function isDue(item: QueuedCapture, now: number): boolean {
  return item.state === 'pending' && item.next_attempt_at <= now;
}

/** Errors that will never succeed on retry (bad request, forbidden, hash mismatch): stop instead of looping. */
export function isPermanentFailure(status: number | null): boolean {
  return status !== null && [400, 403, 404, 413, 422].includes(status);
}

/** Pure transition after one upload attempt. `status` = HTTP status when the server answered, null for a network error. */
export function afterAttempt(
  item: QueuedCapture,
  result: { ok: true } | { ok: false; status: number | null; message: string },
  now: number,
  random: () => number = Math.random,
): QueuedCapture {
  if (result.ok) return { ...item, state: 'done', last_error: null };
  const queued_at = item.queued_at ?? new Date(now).toISOString();
  if (result.status === null || result.status === 401 || result.status >= 500 || result.status === 429) {
    // Dead zone / expired session / server trouble: keep the photo and mark it as an OFFLINE capture. Network failures
    // do not consume the attempt budget (field data must never be dropped because of signal).
    const attempts = result.status === null ? item.attempts : item.attempts + 1;
    if (attempts >= QUEUE_MAX_ATTEMPTS) return { ...item, state: 'failed', attempts, offline: true, queued_at, last_error: result.message };
    return { ...item, state: 'pending', attempts, offline: true, queued_at, next_attempt_at: now + queueBackoffMs(Math.max(1, attempts), random), last_error: result.message };
  }
  return { ...item, state: 'failed', attempts: item.attempts + 1, queued_at, last_error: result.message };
}

// ------------------------------------------------------------------ redaction geometry

export interface RedactionRegion {
  /** Fractions of the image (0..1) so the same region works at any resolution. */
  x: number; y: number; w: number; h: number;
  kind: 'person' | 'sensitive';
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Clamps regions into the image and drops empty / tiny ones (< 0.5% of an edge). */
export function normalizeRegions(regions: RedactionRegion[]): RedactionRegion[] {
  return regions
    .map((r) => {
      const x = clamp01(Math.min(r.x, r.x + r.w));
      const y = clamp01(Math.min(r.y, r.y + r.h));
      const x2 = clamp01(Math.max(r.x, r.x + r.w));
      const y2 = clamp01(Math.max(r.y, r.y + r.h));
      return { x, y, w: x2 - x, h: y2 - y, kind: r.kind };
    })
    .filter((r) => r.w >= 0.005 && r.h >= 0.005)
    .slice(0, 50);
}

export function toPixelRect(r: RedactionRegion, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const x = Math.floor(r.x * width);
  const y = Math.floor(r.y * height);
  return { x, y, w: Math.min(width - x, Math.ceil(r.w * width)), h: Math.min(height - y, Math.ceil(r.h * height)) };
}

/** Stored as the derivative's `transform`: what was done, never WHERE (positions would reveal what was hidden). */
export function redactionTransform(regions: RedactionRegion[]): Record<string, unknown> {
  return {
    type: 'redaction',
    regions: regions.length,
    people: regions.filter((r) => r.kind === 'person').length,
    sensitive: regions.filter((r) => r.kind === 'sensitive').length,
    exif_stripped: true,
  };
}

// ------------------------------------------------------------------ external-reader text (PDF, disputes, proposals)
// English on purpose: these blocks are read by banks, insurers and clients outside the app. Never includes coordinates,
// names or addresses.

const STATUS_EN: Record<PhotoStatus, string> = {
  unmodified: 'unmodified since capture',
  imported: 'imported (not taken with the in-app camera)',
  offline: 'captured offline (time is the device clock)',
  integrity_failed: 'INTEGRITY CHECK FAILED',
};
export const PHOTO_EVIDENCE_HEADING = 'Verified photo summary (Vireek evidence chain)';
export const PHOTO_EVIDENCE_LIMITS =
  'Limits: this proves the photo files are unchanged since the server received them, not that the work was done correctly. Device time and GPS can be spoofed.';

const utc = (iso: string | null): string => {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'n/a' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

/** Lines: [heading, counts, one line per photo…, limits]. The first and last lines are always the heading and the limits. */
export function photoEvidencePlainLines(captures: PhotoCaptureView[], maxPhotos = 30): string[] {
  const counts = summaryCounts(captures);
  const lines = [
    PHOTO_EVIDENCE_HEADING,
    `${counts.total} photos: ${counts.unmodified} unmodified since capture, ${counts.imported} imported, ${counts.offline} offline captures, ${counts.integrityFailed} failed integrity checks.`,
  ];
  captures.slice(0, maxPhotos).forEach((c, i) => {
    const accuracy = c.location.status === 'recorded' ? `, location accuracy ${c.location.accuracy_class}` : '';
    const redacted = c.derivatives.some((d) => d.modified) ? ', redacted copy on record' : '';
    lines.push(
      `${i + 1}. ${STATUS_EN[c.status]} · server received ${utc(c.server_received_at)} · device time ${utc(c.device_captured_at)} (device clock) · SHA-256 ${c.original_sha256.slice(0, 16)}…${accuracy}${redacted}`,
    );
  });
  if (captures.length > maxPhotos) lines.push(`…and ${captures.length - maxPhotos} more photos not listed.`);
  lines.push(PHOTO_EVIDENCE_LIMITS);
  return lines;
}

export function photoEvidencePlainText(captures: PhotoCaptureView[], maxPhotos = 30): string {
  return photoEvidencePlainLines(captures, maxPhotos).join('\n');
}

/**
 * Puts the summary at the END of an existing free-text field. Re-inserting replaces the earlier block (idempotent).
 * Returns null when it would not fit in `max` characters (the caller must tell the person; nothing is truncated silently).
 */
export function appendSummaryWithinLimit(existing: string, summary: string, max: number): string | null {
  const at = existing.indexOf(PHOTO_EVIDENCE_HEADING);
  const base = (at >= 0 ? existing.slice(0, at) : existing).replace(/\s+$/, '');
  const next = base ? `${base}\n\n${summary}` : summary;
  return next.length <= max ? next : null;
}
