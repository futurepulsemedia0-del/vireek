/**
 * AI Photo + Voice-Based Estimating - client domain logic.
 *
 * A technician's photos, a short video and/or a voice note go to the
 * `field-estimate` Edge Function, which returns a diagnosis, scope of work,
 * parts and a Good / Better / Best draft. Nothing here writes to `quotes`:
 * the result is a DRAFT that the quote builder applies and a human reviews.
 *
 * Server counterpart: supabase/functions/field-estimate (index.ts,
 * normalize.ts). Keep the result types below in sync with normalize.ts.
 */

import { supabase } from '@/lib/supabase';
import type { EstimateOption, EstimateTier } from '@/lib/estimates';

// ============================================================
// TYPES (mirror supabase/functions/field-estimate/normalize.ts)
// ============================================================

export type FieldSeverity = 'low' | 'medium' | 'high' | 'emergency';
export type FieldLineKind = 'labor' | 'part' | 'fee' | 'other';
export type FieldLineSource = 'price_book' | 'ai_estimate';

export interface FieldEstimateLine {
  description: string;
  kind: FieldLineKind;
  quantity: number;
  unit_price_cents: number;
  source: FieldLineSource;
  price_book_item_id: string | null;
  needs_review: boolean;
}

export interface FieldEstimateTier {
  tier: EstimateTier;
  name: string;
  summary: string;
  highlights: string[];
  warranty_label: string | null;
  labor_hours: number | null;
  crew_size: number | null;
  line_items: FieldEstimateLine[];
  total_cents: number;
}

export interface FieldEstimateDiagnosis {
  summary: string;
  probable_cause: string;
  customer_summary: string;
  service_type: string;
  severity: FieldSeverity;
  confidence: number;
  evidence: string[];
}

export interface FieldEstimateResult {
  transcript: string;
  diagnosis: FieldEstimateDiagnosis;
  safety_flags: string[];
  missing_info: string[];
  scope_of_work: string[];
  parts: { name: string; quantity: number; source: FieldLineSource }[];
  tiers: FieldEstimateTier[];
  recommended_tier: EstimateTier;
  warnings: string[];
  inputs: { photos: number; voice: boolean; video: boolean; price_book_items: number };
  model: string;
}

/** Internal report persisted in `quotes.ai_report`. Never shown to customers. */
export interface AiReport {
  version: 1;
  generated_at: string;
  model: string;
  transcript: string;
  diagnosis: FieldEstimateDiagnosis;
  safety_flags: string[];
  missing_info: string[];
  scope_of_work: string[];
  parts: FieldEstimateResult['parts'];
  recommended_tier: EstimateTier;
  tiers: { tier: EstimateTier; total_cents: number; labor_hours: number | null; crew_size: number | null }[];
  unverified_line_count: number;
  inputs: FieldEstimateResult['inputs'];
}

export const FIELD_LIMITS = {
  photos: 8,
  videoSeconds: 45,
  videoBytes: 40 * 1024 * 1024,
  audioSeconds: 180,
  notesChars: 2000,
} as const;

export const SEVERITY_META: Record<FieldSeverity, { label: string; className: string }> = {
  low: { label: 'Low priority', className: 'bg-bg-tertiary text-text-secondary' },
  medium: { label: 'Medium priority', className: 'bg-accent/10 text-accent' },
  high: { label: 'High priority', className: 'bg-warning-500/10 text-warning-500' },
  emergency: { label: 'Emergency', className: 'bg-danger/10 text-danger' },
};

// ============================================================
// RESULT -> QUOTE BUILDER
// ============================================================

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Converts the AI tiers into the builder's option shape (fresh ids, no photo binding). */
export function tiersToOptions(result: FieldEstimateResult): EstimateOption[] {
  return result.tiers.map((t) => ({
    id: newId(),
    tier: t.tier,
    name: t.name,
    summary: t.summary,
    line_items: t.line_items.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit_price_cents: l.unit_price_cents,
    })),
    highlights: t.highlights,
    warranty_label: t.warranty_label,
    photo_ids: [],
    recommended: t.tier === result.recommended_tier,
  }));
}

export function buildAiReport(result: FieldEstimateResult): AiReport {
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    model: result.model,
    transcript: result.transcript,
    diagnosis: result.diagnosis,
    safety_flags: result.safety_flags,
    missing_info: result.missing_info,
    scope_of_work: result.scope_of_work,
    parts: result.parts,
    recommended_tier: result.recommended_tier,
    tiers: result.tiers.map((t) => ({
      tier: t.tier,
      total_cents: t.total_cents,
      labor_hours: t.labor_hours,
      crew_size: t.crew_size,
    })),
    unverified_line_count: result.tiers.reduce(
      (n, t) => n + t.line_items.filter((l) => l.needs_review).length,
      0
    ),
    inputs: result.inputs,
  };
}

// ============================================================
// SERVER CALL
// ============================================================

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

export async function analyzeFieldEstimate(input: {
  photoPaths: string[];
  audioPath?: string | null;
  videoPath?: string | null;
  notes?: string;
  trade?: string;
}): Promise<FieldEstimateResult> {
  const { data, error } = await supabase.functions.invoke('field-estimate', {
    body: {
      photoPaths: input.photoPaths.slice(0, FIELD_LIMITS.photos),
      audioPath: input.audioPath ?? null,
      videoPath: input.videoPath ?? null,
      notes: input.notes?.trim().slice(0, FIELD_LIMITS.notesChars) ?? '',
      trade: input.trade ?? '',
    },
  });
  if (error) {
    throw new Error(await functionErrorMessage(error, 'Could not reach the AI estimator. Check your connection and try again.'));
  }
  if (data?.error) throw new Error(String(data.error));
  return data as FieldEstimateResult;
}

// ============================================================
// MEDIA: upload, duration probe, WAV normalisation
// ============================================================

export type FieldMediaKind = 'audio' | 'video';

const ALLOWED_MIME: Record<FieldMediaKind, string[]> = {
  audio: ['audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/flac'],
  video: ['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp', 'video/mpeg'],
};

const EXT_BY_MIME: Record<string, string> = {
  'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/flac': 'flac',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp', 'video/mpeg': 'mpg',
};

/** The storage bucket only accepts a fixed mime list - normalise before upload. */
function pickMime(kind: FieldMediaKind, blob: Blob, fileName = ''): string {
  const base = (blob.type || '').split(';')[0].trim().toLowerCase();
  const normalised = base === 'audio/x-wav' || base === 'audio/wave' ? 'audio/wav' : base;
  if (ALLOWED_MIME[kind].includes(normalised)) return normalised;
  const lower = fileName.toLowerCase();
  if (kind === 'video') return lower.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  return 'audio/wav';
}

export async function uploadFieldMedia(
  userId: string,
  sessionId: string,
  blob: Blob,
  kind: FieldMediaKind,
  fileName?: string
): Promise<string> {
  const contentType = pickMime(kind, blob, fileName);
  const path = `${userId}/${sessionId}/${newId()}.${EXT_BY_MIME[contentType] ?? 'bin'}`;
  const { error } = await supabase.storage
    .from('field-estimate-media')
    .upload(path, blob, { upsert: false, contentType, cacheControl: '60' });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return path;
}

/** Best-effort cleanup when analysis never reached the server (the server cleans up otherwise). */
export async function removeFieldMedia(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await supabase.storage.from('field-estimate-media').remove(paths).catch(() => undefined);
}

/** Seconds, or null when the browser can't tell (some WebM files report Infinity). */
export function probeDuration(blob: Blob, kind: FieldMediaKind): Promise<number | null> {
  return new Promise((resolve) => {
    const el = document.createElement(kind === 'video' ? 'video' : 'audio');
    const url = URL.createObjectURL(blob);
    let done = false;
    const finish = (value: number | null) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      el.removeAttribute('src');
      el.load();
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), 5000);
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      window.clearTimeout(timer);
      finish(Number.isFinite(el.duration) ? el.duration : null);
    };
    el.onerror = () => {
      window.clearTimeout(timer);
      finish(null);
    };
    el.src = url;
  });
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Browsers record WebM/Opus (Chrome, Firefox) or MP4/AAC (Safari), and the AI
 * does not reliably accept WebM audio. Decoding to 16 kHz mono WAV works
 * everywhere, is ~32 KB/s (a 2-minute note is under 4 MB), and is what speech
 * models expect. Falls back to the original blob if decoding is unsupported.
 */
export async function toWav16kMono(blob: Blob): Promise<Blob> {
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx || typeof OfflineAudioContext === 'undefined') return blob;

  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), rate);
  } catch {
    return blob;
  } finally {
    void ctx.close().catch(() => undefined);
  }
}
