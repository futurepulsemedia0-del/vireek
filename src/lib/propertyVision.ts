/**
 * Persistent Property Vision — client library.
 *
 * Photo -> Vision -> Equipment -> Model -> Serial -> Condition -> Installation quality
 *       -> Hazard -> Component -> Property Graph   (Image -> Memory -> Structured Reality)
 *
 * Server counterparts:
 *   supabase/migrations/20270215000000_persistent_property_vision.sql
 *   supabase/functions/property-vision-analyze/index.ts
 *
 * All tables are read-only for the client; writes go through the edge function
 * (AI analysis) or the pv_* RPCs (human review).
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type PvSeverity = 'info' | 'low' | 'medium' | 'high' | 'emergency';
export type PvCondition = 'good' | 'fair' | 'poor' | 'critical' | 'unknown';
export type PvFindingType = 'hazard' | 'installation_issue' | 'condition_indicator' | 'component';
export type PvFindingStatus = 'open' | 'not_reobserved' | 'resolved' | 'dismissed';

export interface PvAsset {
  id: string;
  customer_id: string | null;
  property_key: string | null;
  equipment_id: string | null;
  kind: string;
  label: string;
  location_label: string | null;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  serial_verified: boolean;
  specs: string | null;
  condition: PvCondition;
  condition_score: number | null;
  install_year: number | null;
  age_basis: 'human' | 'label_date' | 'serial_decode' | 'visual' | 'unknown';
  age_confidence: number | null;
  age_years_est: number | null;
  age_range_min: number | null;
  age_range_max: number | null;
  expected_lifespan_years: number | null;
  remaining_life_years: number | null;
  installation_quality: 'good' | 'acceptable' | 'deficient' | 'unsafe' | 'unknown';
  open_findings_count: number;
  open_hazard_count: number;
  max_open_severity: PvSeverity | null;
  capture_count: number;
  primary_capture_id: string | null;
  match_confidence: number | null;
  possible_duplicate_of: string | null;
  human_confirmed: boolean;
  status: 'active' | 'replaced' | 'removed' | 'merged';
  first_seen_at: string;
  last_seen_at: string;
}

export interface PvFinding {
  id: string;
  asset_id: string | null;
  finding_type: PvFindingType;
  code: string;
  locus: string;
  title: string;
  description: string | null;
  severity: PvSeverity;
  status: PvFindingStatus;
  standard_hint: string | null;
  verify_required: boolean;
  attrs: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  times_observed: number;
}

export interface PvEvent {
  id: string;
  asset_id: string | null;
  finding_id: string | null;
  capture_id: string | null;
  event_type: string;
  severity: PvSeverity;
  summary: string;
  delta: Record<string, unknown>;
  actor_type: 'ai' | 'staff' | 'system';
  occurred_at: string;
}

export interface PvCapture {
  id: string;
  storage_path: string;
  location_label: string | null;
  captured_at: string;
  room_type: string | null;
  job_id: string | null;
}

export interface PvAnalyzeResult {
  run_id: string | null;
  duplicates: number;
  already_analyzed?: boolean;
  scene?: { room_type: string; summary: string };
  assets: { asset_id: string; is_new: boolean; match_status: 'auto' | 'suggested' | 'new'; match_basis: string; candidate_id: string | null; local_id: string }[];
  findings: {
    new: { asset_id: string | null; summary: string; severity: PvSeverity }[];
    worsened: { asset_id: string | null; summary: string; severity: PvSeverity }[];
    not_reobserved: { asset_id: string | null; summary: string; severity: PvSeverity }[];
  };
  changes: { asset_id: string | null; event_type: string; severity: PvSeverity; summary: string }[];
}

export interface PvScope {
  customerId?: string | null;
  jobId?: string | null;
}

export const MAX_PV_PHOTOS = 4;
const BUCKET = 'property-vision';
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_EDGE_PX = 2048;

// ============================================================
// LABELS / STYLES
// ============================================================

export const SEVERITY_STYLES: Record<PvSeverity, string> = {
  emergency: 'bg-danger-500/15 text-danger-500',
  high: 'bg-danger-500/10 text-danger-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-accent/10 text-accent',
  info: 'bg-bg-tertiary text-text-secondary',
};

export const CONDITION_STYLES: Record<PvCondition, string> = {
  good: 'bg-success-500/10 text-success-500',
  fair: 'bg-accent/10 text-accent',
  poor: 'bg-warning-500/10 text-warning-500',
  critical: 'bg-danger-500/10 text-danger-500',
  unknown: 'bg-bg-tertiary text-text-secondary',
};

export function humanize(code: string): string {
  const s = code.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function severityRank(s: string | null | undefined): number {
  return ({ emergency: 5, high: 4, medium: 3, low: 2, info: 1 } as Record<string, number>)[s ?? 'info'] ?? 1;
}

export function ageLabel(a: Pick<PvAsset, 'age_basis' | 'install_year' | 'age_years_est' | 'age_range_min' | 'age_range_max'>): string {
  if (a.age_basis === 'unknown') return 'Age unknown';
  if (a.age_basis === 'visual') {
    return a.age_range_min != null && a.age_range_max != null ? `~${a.age_range_min}–${a.age_range_max} yrs (visual estimate)` : 'Age: visual estimate';
  }
  const src = { human: 'confirmed', label_date: 'from label', serial_decode: 'from serial' }[a.age_basis];
  return a.install_year ? `Installed ${a.install_year} (${src})` : `${a.age_years_est ?? '?'} yrs (${src})`;
}

export function remainingLabel(a: Pick<PvAsset, 'remaining_life_years' | 'age_basis'>): string {
  if (a.remaining_life_years == null) return 'Remaining life unknown';
  const prefix = a.age_basis === 'visual' ? '~' : '';
  return a.remaining_life_years <= 0 ? 'At or past typical service life' : `${prefix}${a.remaining_life_years} yrs typical life left`;
}

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ============================================================
// UPLOAD (client-side downscale + fingerprint)
// ============================================================

let ownerIdCache: string | null = null;
async function getOwnerId(): Promise<string> {
  if (ownerIdCache) return ownerIdCache;
  const { data, error } = await supabase.rpc('get_account_owner_id');
  if (error || typeof data !== 'string' || !data) throw new Error('Could not resolve your account.');
  ownerIdCache = data;
  return data;
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Downscale big camera photos (keeps vision quality, cuts upload + token cost). Falls back to the original. */
async function prepareImage(file: File): Promise<{ blob: Blob; mime: string }> {
  const passthrough = { blob: file as Blob, mime: file.type || 'image/jpeg' };
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size <= MAX_BYTES && /jpe?g|webp|png/.test(file.type)) { bmp.close(); return passthrough; }
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bmp.close(); return passthrough; }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.86));
    return blob ? { blob, mime: 'image/jpeg' } : passthrough;
  } catch {
    return passthrough; // e.g. HEIC on a browser that cannot decode it
  }
}

export interface UploadedPhoto {
  path: string; sha256: string; mime: string; bytes: number; capturedAt: string;
  latitude: number | null; longitude: number | null;
}

export async function uploadPropertyPhoto(file: File, geo: { latitude: number; longitude: number } | null): Promise<UploadedPhoto> {
  if (!file.type.startsWith('image/')) throw new Error('Only image files can be analyzed.');
  const ownerId = await getOwnerId();
  const { blob, mime } = await prepareImage(file);
  if (blob.size > MAX_BYTES) throw new Error('This photo is too large even after compression. Try a smaller one.');
  const sha256 = await sha256Hex(blob);
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/heic' ? 'heic' : 'jpg';
  // Content-addressed path: re-uploading the same photo is a harmless no-op.
  const path = `${ownerId}/${sha256.slice(0, 2)}/${sha256}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: mime, upsert: false });
  if (error && !/already exists|duplicate/i.test(error.message)) throw error;
  const lm = file.lastModified;
  return {
    path, sha256, mime, bytes: blob.size,
    capturedAt: new Date(lm && lm <= Date.now() ? lm : Date.now()).toISOString(),
    latitude: geo?.latitude ?? null, longitude: geo?.longitude ?? null,
  };
}

/** Best-effort, non-blocking location (never prompts twice, never fails the upload). */
export function tryGetLocation(timeoutMs = 4000): Promise<{ latitude: number; longitude: number } | null> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
      () => resolve(null),
      { timeout: timeoutMs, maximumAge: 5 * 60_000 },
    );
  });
}

export async function analyzePropertyPhotos(
  scope: PvScope, photos: UploadedPhoto[], opts: { locationLabel?: string; assetId?: string | null } = {},
): Promise<PvAnalyzeResult> {
  const { data, error } = await supabase.functions.invoke('property-vision-analyze', {
    body: { customerId: scope.customerId ?? null, jobId: scope.jobId ?? null, captures: photos, locationLabel: opts.locationLabel ?? null, assetId: opts.assetId ?? null },
  });
  if (error) {
    // Surface the server's friendly message instead of the generic "non-2xx" text.
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) { const j = await ctx.json(); if (j?.error) throw new Error(j.error); }
    } catch (e) { if (e instanceof Error && e.message && !/JSON|Unexpected/.test(e.message)) throw e; }
    throw error;
  }
  if (data?.error) throw new Error(data.error);
  return data as PvAnalyzeResult;
}

// ============================================================
// READS
// ============================================================

const ASSET_SELECT = '*';

export async function fetchAssets(scope: PvScope & { propertyKey?: string | null }): Promise<PvAsset[]> {
  let q = supabase.from('property_assets').select(ASSET_SELECT).neq('status', 'merged')
    .order('max_open_severity', { ascending: false, nullsFirst: false }).order('last_seen_at', { ascending: false }).limit(200);
  if (scope.customerId) q = q.eq('customer_id', scope.customerId);
  if (scope.propertyKey) q = q.eq('property_key', scope.propertyKey);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as PvAsset[]).sort((a, b) => severityRank(b.max_open_severity) - severityRank(a.max_open_severity) || +new Date(b.last_seen_at) - +new Date(a.last_seen_at));
}

export async function fetchAssetDetail(assetId: string): Promise<{ findings: PvFinding[]; events: PvEvent[]; captures: PvCapture[] }> {
  const [f, e, c] = await Promise.all([
    supabase.from('property_findings').select('*').eq('asset_id', assetId).order('last_seen_at', { ascending: false }).limit(200),
    supabase.from('property_events').select('*').eq('asset_id', assetId).neq('event_type', 'observed').order('occurred_at', { ascending: false }).limit(100),
    supabase.from('property_capture_assets').select('capture_id, property_vision_captures(id, storage_path, location_label, captured_at, room_type, job_id)').eq('asset_id', assetId).neq('match_status', 'rejected').limit(24),
  ]);
  if (f.error) throw f.error;
  if (e.error) throw e.error;
  const captures = ((c.data ?? []) as unknown as { property_vision_captures: PvCapture | PvCapture[] | null }[])
    .map((r) => (Array.isArray(r.property_vision_captures) ? r.property_vision_captures[0] : r.property_vision_captures))
    .filter((x): x is PvCapture => !!x)
    .sort((a, b) => +new Date(b.captured_at) - +new Date(a.captured_at));
  return { findings: (f.data ?? []) as PvFinding[], events: (e.data ?? []) as PvEvent[], captures };
}

/** Short-lived signed URLs for private photos (batch, one round trip). */
export async function signedPhotoUrls(paths: string[], expiresIn = 3600): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths, expiresIn);
  const out: Record<string, string> = {};
  for (const r of data ?? []) if (r.path && r.signedUrl) out[r.path] = r.signedUrl;
  return out;
}

// ============================================================
// HUMAN REVIEW (RPCs)
// ============================================================

async function rpc(name: string, args: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
}

export const confirmAsset = (id: string) => rpc('pv_review_asset', { p_asset_id: id, p_action: 'confirm', p_patch: {} });
export const dismissDuplicateHint = (id: string) => rpc('pv_review_asset', { p_asset_id: id, p_action: 'not_duplicate', p_patch: {} });
export const promoteAssetToEquipment = (id: string) => rpc('pv_review_asset', { p_asset_id: id, p_action: 'promote', p_patch: {} });
export const setAssetStatus = (id: string, status: 'active' | 'replaced' | 'removed') =>
  rpc('pv_review_asset', { p_asset_id: id, p_action: 'set_status', p_patch: { status } });
export const correctAsset = (id: string, patch: Partial<Pick<PvAsset, 'label' | 'make' | 'model' | 'serial_number' | 'install_year' | 'location_label' | 'kind'>>) =>
  rpc('pv_review_asset', { p_asset_id: id, p_action: 'correct', p_patch: patch });
export const reviewFinding = (id: string, action: 'resolve' | 'dismiss' | 'reopen', note?: string) =>
  rpc('pv_review_finding', { p_finding_id: id, p_action: action, p_note: note ?? null });
export const mergeAssets = (keep: string, drop: string) => rpc('pv_merge_assets', { p_keep: keep, p_drop: drop });
