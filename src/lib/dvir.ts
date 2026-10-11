/**
 * Vehicle DVIR (Driver Vehicle Inspection Report) — pre-trip / post-trip inspections.
 *
 * Reuses `vehicles` + `vehicle_faults`. All writes go through SECURITY DEFINER RPCs
 * (submit_vehicle_inspection / resolve_vehicle_defect); the server re-validates every rule below,
 * so the pure helpers here only exist for instant UI feedback and are unit-tested.
 */

import { supabase } from '@/lib/supabase';

export type InspectionType = 'pre_trip' | 'post_trip';
export type ItemSeverity = 'minor' | 'major' | 'out_of_service';
export type AnswerResult = 'pass' | 'defect' | 'na';
export type InspectionStatus = 'satisfactory' | 'defects_noted' | 'unsafe';

export const INSPECTION_TYPE_LABELS: Record<InspectionType, string> = { pre_trip: 'Pre-trip', post_trip: 'Post-trip' };
export const SEVERITY_LABELS: Record<ItemSeverity, string> = { minor: 'Minor', major: 'Major', out_of_service: 'Out of service' };
export const STATUS_LABELS: Record<InspectionStatus, string> = {
  satisfactory: 'Satisfactory',
  defects_noted: 'Defects noted',
  unsafe: 'Unsafe — out of service',
};

export const MAX_PHOTOS_PER_ITEM = 6;
export const MIN_TEXT = 3;

export interface ChecklistItem {
  id: string;
  item_key: string;
  label: string;
  category: string;
  severity_if_defect: ItemSeverity;
  applies_to: 'pre_trip' | 'post_trip' | 'both';
  requires_photo: boolean;
  sort_order: number;
  active: boolean;
}

export interface ItemAnswer {
  result: AnswerResult | null;
  note: string;
  photos: File[];
}
export type AnswerMap = Record<string, ItemAnswer>;

export interface DvirVehicle {
  id: string;
  label: string;
  make: string | null;
  model: string | null;
  license_plate: string | null;
  status: 'active' | 'in_shop' | 'retired';
  odometer_miles: number;
  assigned_technician_id: string | null;
}

export interface DvirFault {
  id: string;
  vehicle_id: string;
  code: string;
  description: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
  blocks_dispatch: boolean;
  photo_paths: string[];
  first_seen_at: string;
  last_seen_at: string;
  inspection_id: string | null;
}

export interface StoredResult {
  key: string;
  label: string;
  category: string;
  severity: ItemSeverity;
  result: AnswerResult;
  note: string | null;
  photos: string[];
}

export interface InspectionRow {
  id: string;
  vehicle_id: string;
  technician_id: string | null;
  inspection_type: InspectionType;
  odometer_miles: number;
  odometer_anomaly: boolean;
  status: InspectionStatus;
  declared_unsafe: boolean;
  defect_count: number;
  results: StoredResult[];
  notes: string | null;
  signed_name: string;
  signature_path: string;
  created_at: string;
}

export interface BlockedTechnician {
  technician_id: string;
  vehicle_id: string;
  vehicle_label: string;
  defect_count: number;
}

export interface SubmitOutcome {
  inspection_id: string;
  result_status: InspectionStatus;
  defect_count: number;
  blocked: boolean;
  odometer_anomaly: boolean;
  duplicate: boolean;
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

export function emptyAnswers(items: ChecklistItem[]): AnswerMap {
  return Object.fromEntries(items.map((i) => [i.item_key, { result: null, note: '', photos: [] } as ItemAnswer]));
}

export function photoRequired(item: Pick<ChecklistItem, 'severity_if_defect' | 'requires_photo'>): boolean {
  return item.severity_if_defect === 'out_of_service' || item.requires_photo;
}

export function evaluateInspection(
  items: ChecklistItem[],
  answers: AnswerMap,
  declaredUnsafe: boolean,
): { status: InspectionStatus; defects: number; blocking: number } {
  let defects = 0;
  let blocking = 0;
  for (const item of items) {
    if (answers[item.item_key]?.result !== 'defect') continue;
    defects += 1;
    if (item.severity_if_defect === 'out_of_service') blocking += 1;
  }
  const unsafe = blocking > 0 || declaredUnsafe;
  return { status: unsafe ? 'unsafe' : defects > 0 ? 'defects_noted' : 'satisfactory', defects, blocking };
}

export interface ValidationInput {
  items: ChecklistItem[];
  answers: AnswerMap;
  odometerText: string;
  declaredUnsafe: boolean;
  notes: string;
  signedName: string;
  hasSignature: boolean;
}

/** Returns human-readable blockers; empty array means the form can be submitted. */
export function validateInspection(input: ValidationInput): string[] {
  const errors: string[] = [];
  const odo = parseOdometer(input.odometerText);
  if (odo === null) errors.push('Enter the odometer reading');

  const unanswered = input.items.filter((i) => !input.answers[i.item_key]?.result).length;
  if (unanswered > 0) errors.push(`${unanswered} checklist item${unanswered === 1 ? '' : 's'} not answered`);

  for (const item of input.items) {
    const a = input.answers[item.item_key];
    if (a?.result !== 'defect') continue;
    if (a.note.trim().length < MIN_TEXT) errors.push(`Describe the defect: ${item.label}`);
    if (photoRequired(item) && a.photos.length === 0) errors.push(`Add a photo: ${item.label}`);
  }

  if (input.declaredUnsafe && input.notes.trim().length < MIN_TEXT) errors.push('Explain why the vehicle is unsafe');
  if (input.signedName.trim().length < 2) errors.push('Type your full name');
  if (!input.hasSignature) errors.push('Sign the report');
  return errors;
}

export function parseOdometer(text: string): number | null {
  const cleaned = text.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 && n < 5_000_000 ? n : null;
}

export function isOdometerAnomaly(entered: number, lastKnown: number | null | undefined): boolean {
  return entered < (lastKnown ?? 0);
}

export function groupByCategory(items: ChecklistItem[]): Array<{ category: string; items: ChecklistItem[] }> {
  const map = new Map<string, ChecklistItem[]>();
  for (const item of [...items].sort((a, b) => a.sort_order - b.sort_order)) {
    map.set(item.category, [...(map.get(item.category) ?? []), item]);
  }
  return [...map.entries()].map(([category, list]) => ({ category, items: list }));
}

export function slugifyKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

export function faultTitle(f: Pick<DvirFault, 'code' | 'description'>): string {
  return f.description?.trim() || f.code.replace(/^DVIR:/, '').replace(/_/g, ' ').toLowerCase();
}

/** True when the vehicle has an open dispatch-blocking defect. */
export function vehicleBlocked(faults: Array<Pick<DvirFault, 'vehicle_id' | 'blocks_dispatch'>>, vehicleId: string): boolean {
  return faults.some((f) => f.vehicle_id === vehicleId && f.blocks_dispatch);
}

/** Supabase errors are plain objects, not Error instances. */
export function errorMessage(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message || fallback;
  }
  return fallback;
}

/** Friendly message for errors raised by the dispatch gate trigger / RPCs. */
export function friendlyDispatchError(message: string | null | undefined): string | null {
  if (!message) return null;
  const m = message.match(/DVIR_BLOCKED:\s*(.+)$/s);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

let ownerIdPromise: Promise<string> | null = null;
async function getOwnerId(): Promise<string> {
  ownerIdPromise ??= (async () => {
    const { data, error } = await supabase.rpc('get_account_owner_id');
    if (error || !data) throw error ?? new Error('Account not found');
    return data as string;
  })().catch((e) => {
    ownerIdPromise = null;
    throw e;
  });
  return ownerIdPromise;
}

export async function fetchChecklist(type: InspectionType): Promise<ChecklistItem[]> {
  const { data, error } = await supabase.rpc('dvir_get_checklist', { p_inspection_type: type });
  if (error) throw error;
  return (data ?? []) as ChecklistItem[];
}

export async function fetchAllChecklistItems(): Promise<ChecklistItem[]> {
  await fetchChecklist('pre_trip'); // seeds defaults on first use
  const { data, error } = await supabase.from('dvir_checklist_items').select('*').order('sort_order');
  if (error) throw error;
  return (data ?? []) as ChecklistItem[];
}

export async function fetchDvirVehicles(): Promise<DvirVehicle[]> {
  const { data, error } = await supabase
    .from('vehicles')
    .select('id, label, make, model, license_plate, status, odometer_miles, assigned_technician_id')
    .neq('status', 'retired')
    .order('label');
  if (error) throw error;
  return (data ?? []).map((v) => ({ ...v, odometer_miles: Number(v.odometer_miles ?? 0) })) as DvirVehicle[];
}

export async function fetchOpenDvirFaults(): Promise<DvirFault[]> {
  const { data, error } = await supabase
    .from('vehicle_faults')
    .select('id, vehicle_id, code, description, severity, blocks_dispatch, photo_paths, first_seen_at, last_seen_at, inspection_id')
    .eq('source', 'dvir')
    .is('cleared_at', null)
    .order('last_seen_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as DvirFault[];
}

export async function fetchRecentInspections(limit = 50): Promise<InspectionRow[]> {
  const { data, error } = await supabase
    .from('vehicle_inspections')
    .select('id, vehicle_id, technician_id, inspection_type, odometer_miles, odometer_anomaly, status, declared_unsafe, defect_count, results, notes, signed_name, signature_path, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({ ...r, odometer_miles: Number(r.odometer_miles) })) as InspectionRow[];
}

export async function fetchBlockedTechnicians(): Promise<BlockedTechnician[]> {
  const { data, error } = await supabase.rpc('dvir_blocked_technicians');
  if (error) throw error;
  return (data ?? []) as BlockedTechnician[];
}

export async function resolveDefect(faultId: string, note: string): Promise<{ stillBlocked: boolean }> {
  const { data, error } = await supabase.rpc('resolve_vehicle_defect', { p_fault_id: faultId, p_note: note.trim() });
  if (error) throw error;
  if (data?.status !== 'resolved') throw new Error('Defect was already resolved');
  return { stillBlocked: Boolean(data.still_blocked) };
}

export async function saveChecklistItem(
  item: Partial<ChecklistItem> & Pick<ChecklistItem, 'item_key' | 'label'>,
): Promise<void> {
  const { error } = await supabase.from('dvir_checklist_items').upsert(
    {
      item_key: item.item_key,
      label: item.label.trim(),
      category: (item.category ?? 'General').trim() || 'General',
      severity_if_defect: item.severity_if_defect ?? 'major',
      applies_to: item.applies_to ?? 'both',
      requires_photo: item.requires_photo ?? false,
      sort_order: item.sort_order ?? 1000,
      active: item.active ?? true,
    },
    { onConflict: 'user_id,item_key' },
  );
  if (error) throw error;
}

export async function signedMediaUrl(path: string, expiresIn = 600): Promise<string | null> {
  const { data, error } = await supabase.storage.from('dvir-media').createSignedUrl(path, expiresIn);
  return error ? null : data.signedUrl;
}

// ---- uploads --------------------------------------------------------------

async function compressImage(file: File, maxEdge = 1600, quality = 0.82): Promise<Blob> {
  try {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

async function uploadBlob(path: string, blob: Blob, contentType: string): Promise<void> {
  const { error } = await supabase.storage.from('dvir-media').upload(path, blob, { upsert: false, contentType, cacheControl: '3600' });
  // A retry after a partially failed submit re-uploads the same deterministic path: treat as success.
  if (error && !/already exists|duplicate|409/i.test(`${error.message} ${(error as { statusCode?: string }).statusCode ?? ''}`)) throw error;
}

export interface SignatureInput {
  type: 'drawn' | 'typed';
  data: string;
  typedFont?: string;
}

export async function signatureToBlob(sig: SignatureInput, typedFamily = "'Dancing Script', cursive"): Promise<Blob> {
  if (sig.type === 'drawn') return (await fetch(sig.data)).blob();
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Signature could not be rendered');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#171717';
  ctx.font = `64px ${typedFamily}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(sig.data, 24, 90, canvas.width - 48);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Signature could not be rendered');
  return blob;
}

function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { timeout: 4000, maximumAge: 60_000 },
    );
  });
}

export interface SubmitParams {
  submissionId: string;
  vehicleId: string;
  type: InspectionType;
  odometerMiles: number;
  items: ChecklistItem[];
  answers: AnswerMap;
  notes: string;
  declaredUnsafe: boolean;
  signedName: string;
  signature: SignatureInput;
  signatureFontFamily?: string;
}

export async function submitInspection(p: SubmitParams): Promise<SubmitOutcome> {
  const owner = await getOwnerId();
  const base = `${owner}/${p.vehicleId}/${p.submissionId}`;

  const sigPath = `${base}/signature.png`;
  await uploadBlob(sigPath, await signatureToBlob(p.signature, p.signatureFontFamily), 'image/png');

  const results: Array<Record<string, unknown>> = [];
  for (const item of p.items) {
    const a = p.answers[item.item_key];
    const entry: Record<string, unknown> = { key: item.item_key, result: a?.result ?? 'na' };
    if (a?.result === 'defect') {
      entry.note = a.note.trim();
      const paths: string[] = [];
      for (const [i, file] of a.photos.slice(0, MAX_PHOTOS_PER_ITEM).entries()) {
        const path = `${base}/${item.item_key}-${i + 1}.jpg`;
        await uploadBlob(path, await compressImage(file), 'image/jpeg');
        paths.push(path);
      }
      entry.photos = paths;
    }
    results.push(entry);
  }

  const pos = await currentPosition();
  const { data, error } = await supabase.rpc('submit_vehicle_inspection', {
    p_vehicle_id: p.vehicleId,
    p_inspection_type: p.type,
    p_odometer_miles: p.odometerMiles,
    p_results: results,
    p_notes: p.notes.trim() || null,
    p_declared_unsafe: p.declaredUnsafe,
    p_signed_name: p.signedName.trim(),
    p_signature_path: sigPath,
    p_client_submission_id: p.submissionId,
    p_latitude: pos?.lat ?? null,
    p_longitude: pos?.lng ?? null,
  });
  if (error) throw error;
  return {
    inspection_id: data.inspection_id,
    result_status: data.result_status,
    defect_count: data.defect_count ?? 0,
    blocked: Boolean(data.blocked ?? data.result_status === 'unsafe'),
    odometer_anomaly: Boolean(data.odometer_anomaly),
    duplicate: Boolean(data.duplicate),
  };
}
