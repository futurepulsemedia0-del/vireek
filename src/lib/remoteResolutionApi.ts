/**
 * Vireek Remote Resolution Engine — API layer (Supabase).
 *
 * Staff: RLS-scoped table reads + SECURITY DEFINER RPCs that re-check the account server-side.
 * Customer: token-gated RPCs keyed by jobs.reschedule_token (same secret as /service, /approve, /track).
 * The AI turn goes through the `remote-resolution` edge function; probability, safety and dispatch
 * decisions are made there in plain code, never in the browser.
 */

import { supabase } from '@/lib/supabase';
import {
  LIMITS,
  friendlyDbError,
  type RrCase,
  type RrDevice,
  type RrRoom,
  type RrSettings,
  type RrSignal,
  type RrStats,
} from '@/lib/remoteResolution';

export class RrError extends Error {
  code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = 'RrError';
    this.code = code;
  }
}

async function functionError(error: unknown, fallback: string): Promise<RrError> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown; code?: unknown };
      return new RrError(typeof body?.error === 'string' && body.error ? body.error : fallback, typeof body?.code === 'string' ? body.code : null);
    } catch {
      /* fall through */
    }
  }
  return new RrError(fallback);
}

// ============================================================
// MEDIA ENCODING (runs in the browser, keeps uploads small)
// ============================================================

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsDataURL(blob);
  });
}

/** Resizes to max 1280px and re-encodes as JPEG under ~1.2 MB (EXIF location is dropped by the re-encode). */
export async function fileToJpegBase64(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new RrError('Please choose a photo.');
  if (file.size > 25 * 1024 * 1024) throw new RrError('That photo is too large.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new RrError('That photo could not be read. Try a JPEG or PNG.');
  }
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new RrError('Your browser cannot process photos.');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  for (const quality of [0.82, 0.7, 0.55, 0.4]) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality));
    if (blob && blob.size <= 1_200_000) return blobToBase64(blob);
  }
  throw new RrError('That photo is too detailed to upload. Try a closer, simpler shot.');
}

function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

async function blobToWavBase64(blob: Blob): Promise<string> {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) throw new RrError('Your browser cannot record audio.');
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const target = 16_000;
    const frames = Math.max(1, Math.ceil(decoded.duration * target));
    const offline = new OfflineAudioContext(1, frames, target); // resamples + down-mixes to mono
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    const wav = encodeWav16(rendered.getChannelData(0), target);
    return blobToBase64(new Blob([wav], { type: 'audio/wav' }));
  } finally {
    void ctx.close();
  }
}

export interface Recorder {
  stop: () => Promise<string>;
  cancel: () => void;
}

/** Starts a microphone recording that auto-stops at LIMITS.audioSeconds. Resolves to base64 WAV (16 kHz mono). */
export async function startRecording(onAutoStop?: () => void): Promise<Recorder> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new RrError('Recording is not supported on this device.');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
  } catch {
    throw new RrError('Microphone access was blocked. You can skip this step.');
  }
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
  });
  const release = () => stream.getTracks().forEach((t) => t.stop());
  rec.start();
  const timer = window.setTimeout(() => {
    if (rec.state === 'recording') {
      rec.stop();
      onAutoStop?.();
    }
  }, LIMITS.audioSeconds * 1000);

  return {
    stop: async () => {
      window.clearTimeout(timer);
      if (rec.state === 'recording') rec.stop();
      await stopped;
      release();
      if (chunks.length === 0) throw new RrError('Nothing was recorded.');
      return blobToWavBase64(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
    },
    cancel: () => {
      window.clearTimeout(timer);
      if (rec.state === 'recording') rec.stop();
      release();
    },
  };
}

// ============================================================
// CUSTOMER (token-gated)
// ============================================================

export function getResolveLink(token: string): string {
  return `${window.location.origin}/resolve/${token}`;
}

export async function fetchRoom(token: string): Promise<RrRoom | null> {
  const { data, error } = await supabase.rpc('get_remote_resolution_room', { p_token: token });
  if (error || !data) return null;
  return data as RrRoom;
}

export interface TurnInput {
  answers?: { question_id: string; value: string }[];
  freeText?: string;
  stepResult?: { step_id: string; result: 'no_change' | 'fixed' | 'cannot_do' };
  photoBase64?: string;
  audioBase64?: string;
}

function turnBody(input: TurnInput): Record<string, unknown> {
  return {
    locale: typeof navigator !== 'undefined' ? navigator.language : 'en',
    answers: input.answers,
    freeText: input.freeText?.trim() || undefined,
    stepResult: input.stepResult,
    photo: input.photoBase64 ? { data: input.photoBase64 } : undefined,
    audio: input.audioBase64 ? { data: input.audioBase64 } : undefined,
  };
}

/** One conversational turn as the customer. Returns the refreshed room. */
export async function submitCustomerTurn(token: string, input: TurnInput): Promise<RrRoom | null> {
  const { data, error } = await supabase.functions.invoke('remote-resolution', { body: { token, ...turnBody(input) } });
  if (error) throw await functionError(error, 'Could not send that. Please try again.');
  if (data?.error) throw new RrError(String(data.error), typeof data.code === 'string' ? data.code : null);
  return (data?.room as RrRoom | null) ?? null;
}

type RpcResult = { ok: boolean; error?: string; status?: string };

async function customerRpc(fn: string, args: Record<string, unknown>): Promise<void> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error || !data) throw new RrError('Could not send that. Please try again.');
  const res = data as RpcResult;
  if (!res.ok) throw new RrError(res.error ?? 'unknown', res.error ?? null);
}

export const confirmOutcome = (token: string, outcome: 'fixed' | 'not_fixed') =>
  customerRpc('rr_customer_confirm', { p_token: token, p_outcome: outcome });
export const requestVisit = (token: string) => customerRpc('rr_customer_request_visit', { p_token: token });
export const reportProblemBack = (token: string) => customerRpc('rr_customer_report_back', { p_token: token });

// ============================================================
// STAFF
// ============================================================

export async function flushCases(): Promise<void> {
  await supabase.rpc('remote_resolution_flush');
}

export async function fetchCaseForJob(jobId: string): Promise<RrCase | null> {
  await flushCases().catch(() => undefined);
  const { data, error } = await supabase.from('remote_resolution_cases').select('*').eq('job_id', jobId).maybeSingle();
  if (error) throw new Error(friendlyDbError(error.message));
  return (data as RrCase | null) ?? null;
}

export async function fetchSignals(caseId: string): Promise<RrSignal[]> {
  const { data, error } = await supabase
    .from('remote_resolution_signals')
    .select('id, kind, source, key, value, confidence, created_at')
    .eq('case_id', caseId)
    .order('created_at', { ascending: true })
    .limit(120);
  if (error) throw new Error(friendlyDbError(error.message));
  return (data as RrSignal[]) ?? [];
}

export async function startCase(jobId: string, symptom: string, locale?: string): Promise<RrCase> {
  const { data, error } = await supabase
    .from('remote_resolution_cases')
    .insert({ job_id: jobId, symptom: symptom.trim(), locale: locale ?? null })
    .select('*')
    .single();
  if (error) throw new Error(friendlyDbError(error.message));
  return data as RrCase;
}

async function moveCase(id: string, status: 'dispatch_required' | 'withdrawn' | 'reopened', from: string[]): Promise<void> {
  const { data, error } = await supabase
    .from('remote_resolution_cases')
    .update({ status })
    .eq('id', id)
    .in('status', from)
    .select('id');
  if (error) throw new Error(friendlyDbError(error.message));
  if (!data || data.length === 0) throw new Error('This case already moved on. Refresh and try again.');
}

export const dispatchCase = (id: string) => moveCase(id, 'dispatch_required', ['intake', 'troubleshooting']);
export const withdrawCase = (id: string) => moveCase(id, 'withdrawn', ['intake', 'troubleshooting']);
export const reopenCase = (id: string) => moveCase(id, 'reopened', ['resolved_pending', 'resolved_remotely']);

export async function closeJobRemote(jobId: string): Promise<void> {
  const { data, error } = await supabase.rpc('rr_close_job_remote', { p_job_id: jobId });
  if (error) throw new Error(friendlyDbError(error.message));
  const res = data as RpcResult | null;
  if (!res?.ok) {
    throw new Error(
      res?.error === 'job_not_scheduled'
        ? 'The job is no longer in the scheduled state.'
        : res?.error === 'not_resolved'
          ? 'The customer has not confirmed a fix yet.'
          : 'Could not close the job.',
    );
  }
}

/** Staff answering on the customer's behalf (e.g. during a phone call). */
export async function submitStaffTurn(caseId: string, input: TurnInput): Promise<void> {
  const { data, error } = await supabase.functions.invoke('remote-resolution', { body: { caseId, ...turnBody(input) } });
  if (error) throw await functionError(error, 'Could not save that. Please try again.');
  if (data?.error) throw new RrError(String(data.error), typeof data.code === 'string' ? data.code : null);
}

export async function fetchActiveCases(limit = 25): Promise<(RrCase & { job: { customer_name: string; service_type: string | null } | null })[]> {
  await flushCases().catch(() => undefined);
  const { data, error } = await supabase
    .from('remote_resolution_cases')
    .select('*, job:jobs(customer_name, service_type)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(friendlyDbError(error.message));
  return (data as unknown as (RrCase & { job: { customer_name: string; service_type: string | null } | null })[]) ?? [];
}

export async function fetchStats(days: number): Promise<RrStats> {
  const { data, error } = await supabase.rpc('remote_resolution_stats', { p_days: days });
  if (error || !data) throw new Error('Could not load statistics.');
  return data as RrStats;
}

export async function fetchSettings(): Promise<RrSettings> {
  const { data, error } = await supabase.rpc('remote_resolution_get_settings');
  if (error || !data) throw new Error('Could not load settings.');
  return data as RrSettings;
}

export async function saveSettings(s: RrSettings): Promise<RrSettings> {
  const { data, error } = await supabase.rpc('remote_resolution_save_settings', {
    p_enabled: s.enabled,
    p_truck_roll_cost_cents: s.truck_roll_cost_cents,
    p_attempt_threshold: s.attempt_threshold,
    p_verification_hours: s.verification_hours,
    p_hold_hours: s.hold_hours,
  });
  if (error) throw new Error(friendlyDbError(error.message));
  return data as RrSettings;
}

// ---- devices ----------------------------------------------------------------

export async function fetchDevices(): Promise<RrDevice[]> {
  const { data, error } = await supabase
    .from('rr_devices')
    .select('id, equipment_id, label, vendor, key_prefix, active, last_seen_at, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(friendlyDbError(error.message));
  return (data as RrDevice[]) ?? [];
}

export async function registerDevice(equipmentId: string, label: string, vendor: string): Promise<{ device_id: string; key: string }> {
  const { data, error } = await supabase.rpc('rr_register_device', {
    p_equipment_id: equipmentId,
    p_label: label.trim(),
    p_vendor: vendor.trim() || null,
  });
  if (error) throw new Error(friendlyDbError(error.message));
  return data as { device_id: string; key: string };
}

export async function setDeviceActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('rr_devices').update({ active }).eq('id', id);
  if (error) throw new Error(friendlyDbError(error.message));
}

export async function fetchEquipmentOptions(): Promise<{ id: string; label: string }[]> {
  const { data, error } = await supabase
    .from('equipment')
    .select('id, equipment_type, make, model, status')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(friendlyDbError(error.message));
  return ((data as { id: string; equipment_type: string; make: string | null; model: string | null }[]) ?? []).map((e) => ({
    id: e.id,
    label: [e.equipment_type, e.make, e.model].filter(Boolean).join(' · '),
  }));
}
