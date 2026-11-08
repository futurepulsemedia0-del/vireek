// src/lib/photoProvenanceApi.ts
//
// Client API for job-photo provenance: capture -> hash on device -> durable offline queue -> upload -> server
// countersignature (edge function `photo-provenance`) -> sealed into the existing job evidence chain.
// Pure logic (hashing, state machine, display model) is in ./photoProvenance (unit-tested).
//
// The queue is a small dedicated IndexedDB store because the field outbox module (src/lib/offline/outbox.ts, db.ts)
// was not part of the reviewed archive. Once those files are reviewed, `flushQueue` can be registered as an outbox
// op type instead; the wire format (edge function body) does not change.

import { supabase } from '@/lib/supabase';
import {
  afterAttempt, evidencePhotoPath, isDue, normalizeMime, MIME_EXT, sha256Hex, shouldRequestLocation,
  type CaptureSource, type PhotoSettings, type PhotoSummary, type QueuedCapture, type RedactionRegion,
  redactionTransform, normalizeRegions, toPixelRect,
} from '@/lib/photoProvenance';

const BUCKET = 'job-evidence-chain';
const DB_NAME = 'vireek-photo-provenance';
const SETTINGS_KEY = 'vireek.photoProvenance.settings.v1';
const OWNER_KEY = 'vireek.photoProvenance.owner.v1';
const MAX_EDGE = 1600;

// ------------------------------------------------------------------ tiny IndexedDB wrapper

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb_unavailable'));
  });
}

async function tx<T>(stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = run(t);
    t.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error ?? new Error('indexeddb_error')); };
    t.onabort = () => { db.close(); reject(t.error ?? new Error('indexeddb_aborted')); };
  });
}

const blobKey = (id: string, part: string) => `${id}:${part}`;

async function putItem(item: QueuedCapture): Promise<void> {
  await tx(['queue'], 'readwrite', (t) => t.objectStore('queue').put(item));
  notifyQueue();
}
export async function listQueue(): Promise<QueuedCapture[]> {
  try {
    return ((await tx(['queue'], 'readonly', (t) => t.objectStore('queue').getAll())) ?? []) as QueuedCapture[];
  } catch {
    return [];
  }
}
async function getBlob(id: string, part: string): Promise<Blob | undefined> {
  return (await tx(['blobs'], 'readonly', (t) => t.objectStore('blobs').get(blobKey(id, part)))) as Blob | undefined;
}
async function removeItem(item: QueuedCapture): Promise<void> {
  await tx(['queue', 'blobs'], 'readwrite', (t) => {
    t.objectStore('queue').delete(item.id);
    t.objectStore('blobs').delete(blobKey(item.id, 'original'));
    item.derivatives.forEach((_, i) => t.objectStore('blobs').delete(blobKey(item.id, `d${i}`)));
  });
  notifyQueue();
}

// ------------------------------------------------------------------ queue observers

const listeners = new Set<() => void>();
export const subscribeQueue = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
function notifyQueue(): void {
  listeners.forEach((l) => l());
}

export interface QueueStats { pending: number; failed: number; offline: number }
export async function getQueueStats(jobId?: string): Promise<QueueStats> {
  const items = (await listQueue()).filter((i) => (jobId ? i.job_id === jobId : true));
  return {
    pending: items.filter((i) => i.state === 'pending' || i.state === 'uploading').length,
    failed: items.filter((i) => i.state === 'failed').length,
    offline: items.filter((i) => i.offline && i.state !== 'done').length,
  };
}

// ------------------------------------------------------------------ account owner + settings (cached for offline use)

export async function getOwnerId(): Promise<string> {
  try {
    const { data, error } = await supabase.rpc('get_account_owner_id');
    if (!error && typeof data === 'string') {
      localStorage.setItem(OWNER_KEY, data);
      return data;
    }
  } catch { /* offline: fall through to the cache */ }
  const cached = localStorage.getItem(OWNER_KEY);
  if (!cached) throw new Error('owner_unknown');
  return cached;
}

export async function getPhotoSettings(): Promise<PhotoSettings | null> {
  try {
    const { data, error } = await supabase.rpc('get_evidence_photo_settings');
    if (!error && data) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
      return data as PhotoSettings;
    }
  } catch { /* offline */ }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as PhotoSettings) : null;
  } catch {
    return null;
  }
}

export async function savePhotoSettings(input: { capture_location: boolean; location_retention_days: number; photo_retention_days: number }): Promise<PhotoSettings> {
  const { data, error } = await supabase.rpc('save_evidence_photo_settings', {
    p_capture_location: input.capture_location,
    p_location_retention_days: input.location_retention_days,
    p_photo_retention_days: input.photo_retention_days,
  });
  if (error) throw new Error(error.message);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  return data as PhotoSettings;
}

// ------------------------------------------------------------------ capture

async function currentFix(settings: PhotoSettings | null): Promise<QueuedCapture['location']> {
  if (!shouldRequestLocation(settings)) return null;      // privacy by default: never ask the OS unless allowed
  try {
    const { isNative } = await import('@/lib/native/platform');
    if (isNative()) {
      const { getNativeFix } = await import('@/lib/native/geolocation');
      const fix = await getNativeFix(8000);
      return fix ? { lat: fix.lat, lng: fix.lng, accuracy_m: fix.accuracy ?? null } : null;
    }
    if (!('geolocation' in navigator)) return null;
    return await new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy ?? null }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
      );
    });
  } catch {
    return null;
  }
}

/** Re-encoded, EXIF-free, downscaled copy. Returns null when the browser cannot decode the format (e.g. HEIC). */
async function makeResizedCopy(file: Blob): Promise<{ blob: Blob; width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close(); return null; }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
    return blob && blob.size < file.size ? { blob, width, height } : null;
  } catch {
    return null;
  }
}

export interface CaptureInput {
  file: File | Blob;
  jobId: string;
  source: CaptureSource;
}

/**
 * Fingerprints the ORIGINAL bytes on the device, stores them in the durable queue and tries to deliver immediately.
 * Never throws because of the network: an undelivered photo stays queued and is marked "offline capture".
 */
export async function capturePhoto(input: CaptureInput): Promise<{ clientCaptureId: string; delivered: boolean }> {
  const mime = normalizeMime(input.file.type);
  if (!MIME_EXT[mime]) throw new Error('unsupported_image_type');
  const [ownerId, settings] = await Promise.all([getOwnerId(), getPhotoSettings()]);
  const deviceAt = new Date().toISOString();                    // device clock — always labelled "device time"
  const location = await currentFix(settings);

  const original = { sha256: await sha256Hex(input.file), mime, bytes: input.file.size };
  const resized = await makeResizedCopy(input.file);
  const derivatives: QueuedCapture['derivatives'] = [];
  const derivativeBlobs: Blob[] = [];
  if (resized) {
    const sha = await sha256Hex(resized.blob);
    if (sha !== original.sha256) {
      derivatives.push({ sha256: sha, mime: 'image/jpeg', bytes: resized.blob.size, kind: 'analysis_resize', width: resized.width, height: resized.height, transform: { type: 'resize', max_edge: MAX_EDGE, quality: 0.8, exif_stripped: true } });
      derivativeBlobs.push(resized.blob);
    }
  }

  const id = crypto.randomUUID();
  await tx(['blobs'], 'readwrite', (t) => {
    t.objectStore('blobs').put(input.file, blobKey(id, 'original'));
    derivativeBlobs.forEach((b, i) => t.objectStore('blobs').put(b, blobKey(id, `d${i}`)));
  });
  await putItem({
    id, job_id: input.jobId, owner_id: ownerId, source: input.source, device_captured_at: deviceAt, queued_at: null, offline: false,
    location, original, derivatives, state: 'pending', attempts: 0, next_attempt_at: 0, last_error: null,
  });
  const delivered = await flushQueue();
  return { clientCaptureId: id, delivered: delivered.delivered > 0 };
}

// ------------------------------------------------------------------ delivery

type EdgeOutcome = { ok: true } | { ok: false; status: number | null; message: string };

async function invokeEdge(body: Record<string, unknown>): Promise<EdgeOutcome> {
  const { error } = await supabase.functions.invoke('photo-provenance', { body });
  if (!error) return { ok: true };
  const ctx = (error as { context?: unknown }).context;
  if (ctx instanceof Response) {
    let message = error.message;
    try { message = ((await ctx.clone().json()) as { error?: string }).error ?? message; } catch { /* keep default */ }
    return { ok: false, status: ctx.status, message };
  }
  return { ok: false, status: null, message: error.message };      // FunctionsFetchError = network
}

async function uploadBlob(path: string, blob: Blob, mime: string): Promise<EdgeOutcome> {
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: mime, upsert: false });
  if (!error) return { ok: true };
  const status = Number((error as { statusCode?: string | number }).statusCode ?? NaN);
  if (status === 409 || /already exists/i.test(error.message)) return { ok: true };   // content-addressed: same path = same bytes (server re-checks)
  return { ok: false, status: Number.isFinite(status) ? status : null, message: error.message };
}

let flushing: Promise<{ delivered: number }> | null = null;

/** Delivers every due item. Re-entrant safe (one flush at a time). */
export function flushQueue(): Promise<{ delivered: number }> {
  if (flushing) return flushing;
  flushing = (async () => {
    let delivered = 0;
    const now = Date.now();
    const { data: session } = await supabase.auth.getSession();
    if (!session.session) return { delivered };
    for (const item of (await listQueue()).filter((i) => isDue(i, now))) {
      let current: QueuedCapture = { ...item, state: 'uploading' };
      await putItem(current);
      const outcome = await deliver(current);
      current = afterAttempt(current, outcome, Date.now());
      if (current.state === 'done') { await removeItem(current); delivered++; } else await putItem(current);
    }
    return { delivered };
  })().finally(() => { flushing = null; });
  return flushing;
}

async function deliver(item: QueuedCapture): Promise<EdgeOutcome> {
  const originalBlob = await getBlob(item.id, 'original');
  if (!originalBlob) return { ok: false, status: 404, message: 'The photo is no longer on this device.' };
  const originalPath = evidencePhotoPath(item.owner_id, item.job_id, item.original.sha256, item.original.mime);
  const up = await uploadBlob(originalPath, originalBlob, item.original.mime);
  if (!up.ok) return up;

  const derivs = [];
  for (let i = 0; i < item.derivatives.length; i++) {
    const d = item.derivatives[i];
    const blob = await getBlob(item.id, `d${i}`);
    if (!blob) continue;
    const path = evidencePhotoPath(item.owner_id, item.job_id, d.sha256, d.mime);
    const r = await uploadBlob(path, blob, d.mime);
    if (!r.ok) return r;
    derivs.push({ path, sha256: d.sha256, mime: d.mime, bytes: d.bytes, kind: d.kind, width: d.width, height: d.height, transform: d.transform });
  }

  return invokeEdge({
    action: 'record_capture',
    job_id: item.job_id,
    client_capture_id: item.id,
    original: { path: originalPath, ...item.original },
    source: item.source,
    device_captured_at: item.device_captured_at,
    offline: item.offline,
    queued_at: item.queued_at,
    location: item.location,
    derivatives: derivs,
  });
}

let autoFlushStarted = false;
/** Flush on: app start, back online, tab visible, every 45 s. Idempotent. */
export function startPhotoQueueAutoFlush(): void {
  if (autoFlushStarted || typeof window === 'undefined') return;
  autoFlushStarted = true;
  const go = () => { void flushQueue().catch(() => undefined); };
  window.addEventListener('online', go);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') go(); });
  window.setInterval(go, 45_000);
  go();
}

// ------------------------------------------------------------------ summary, redaction, shares, privacy

export async function fetchPhotoSummary(jobId: string): Promise<PhotoSummary> {
  const { data, error } = await supabase.rpc('get_evidence_photo_summary', { p_job_id: jobId });
  if (error) throw new Error(error.message);
  return data as PhotoSummary;
}

/** Renders the original with black boxes, re-encodes (drops EXIF), uploads, and has the server countersign the copy. */
export async function createRedactedCopy(input: {
  captureId: string; jobId: string; originalSha256: string; source: Blob; regions: RedactionRegion[];
}): Promise<{ sha256: string }> {
  const regions = normalizeRegions(input.regions);
  if (!regions.length) throw new Error('no_regions');
  const bitmap = await createImageBitmap(input.source, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) { bitmap.close(); throw new Error('canvas_unavailable'); }
  ctx.drawImage(bitmap, 0, 0);
  ctx.fillStyle = '#000';
  regions.forEach((r) => { const p = toPixelRect(r, canvas.width, canvas.height); ctx.fillRect(p.x, p.y, p.w, p.h); });
  const width = canvas.width, height = canvas.height;
  bitmap.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
  if (!blob) throw new Error('encode_failed');

  const ownerId = await getOwnerId();
  const sha256 = await sha256Hex(blob);
  const path = evidencePhotoPath(ownerId, input.jobId, sha256, 'image/jpeg');
  const up = await uploadBlob(path, blob, 'image/jpeg');
  if (!up.ok) throw new Error(up.message);
  const res = await invokeEdge({
    action: 'register_derivative', capture_id: input.captureId, parent_sha256: input.originalSha256,
    derivative: { path, sha256, mime: 'image/jpeg', bytes: blob.size, kind: 'redacted', width, height, transform: redactionTransform(regions) },
  });
  if (!res.ok) throw new Error(res.message);
  return { sha256 };
}

/** Signed URL of a stored evidence file (private bucket, account members only). */
export async function signedPhotoUrl(path: string, seconds = 300): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, seconds);
  return error ? null : data.signedUrl;
}

export async function downloadPhotoBlob(path: string): Promise<Blob> {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error('download_failed');
  return data;
}

export interface ShareRow { id: string; label: string | null; photos: number; created_at: string; expires_at: string; revoked_at: string | null; view_count: number; last_viewed_at: string | null }

export async function createShare(input: { jobId: string; captureIds: string[]; ttlDays: number; label?: string }): Promise<{ id: string; token: string; expires_at: string; url: string }> {
  const { data, error } = await supabase.rpc('create_evidence_photo_share', {
    p_job_id: input.jobId, p_capture_ids: input.captureIds, p_ttl_days: input.ttlDays, p_label: input.label ?? null,
  });
  if (error) throw new Error(error.message);
  const r = data as { id: string; token: string; expires_at: string };
  return { ...r, url: `${window.location.origin}/verify/photo/${r.token}` };
}
export async function listShares(jobId: string): Promise<ShareRow[]> {
  const { data, error } = await supabase.rpc('list_evidence_photo_shares', { p_job_id: jobId });
  if (error) throw new Error(error.message);
  return (data ?? []) as ShareRow[];
}
export async function revokeShare(shareId: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_evidence_photo_share', { p_share_id: shareId });
  if (error) throw new Error(error.message);
}
export async function purgeLocation(captureId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('purge_evidence_photo_location', { p_capture_id: captureId });
  if (error) throw new Error(error.message);
  return data === true;
}
export async function purgeMemberLocations(memberId: string): Promise<number> {
  const { data, error } = await supabase.rpc('purge_evidence_photo_locations_for_member', { p_member: memberId });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}
export async function eraseCapture(captureId: string): Promise<void> {
  const res = await invokeEdge({ action: 'erase', capture_id: captureId });
  if (!res.ok) throw new Error(res.message);
}

export type PublicShare =
  | { found: false }
  | { found: true; state: 'revoked' | 'expired' }
  | { found: true; state: 'active'; issued_at: string; expires_at: string; chain_valid: boolean; captures: PhotoSummary['captures'] };

export async function fetchPublicShare(token: string): Promise<PublicShare> {
  const { data, error } = await supabase.rpc('verify_evidence_photo_share', { p_token: token });
  if (error) throw new Error(error.message);
  return data as PublicShare;
}
