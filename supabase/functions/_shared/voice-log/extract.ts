// Pure, dependency-free logic shared by the `voice-log-extract` Edge Function (Deno)
// and the technician app (Vite). Keep it free of Deno/DOM/Node APIs.

export type Severity = 'info' | 'minor' | 'major' | 'safety';
export const VOICE_LANGS = ['auto', 'en', 'es', 'fa'] as const;
export type VoiceLang = (typeof VOICE_LANGS)[number];

export interface VoiceFinding { text: string; severity: Severity; equipment_hint: string | null; confidence: number }
export interface VoicePart { name: string; quantity: number; confidence: number }
export interface VoiceExtraction {
  language: string;
  transcript: string;
  summary: string;
  findings: VoiceFinding[];
  parts: VoicePart[];
  time_minutes: number | null;
  time_confidence: number;
  customer_notes: string[];
  needs_review: boolean;
}

export const LOW_CONFIDENCE = 0.6;
const MAX_TEXT = 600;
const MAX_ITEMS = 25;
const SEVERITIES: readonly Severity[] = ['info', 'minor', 'major', 'safety'];

/** Gemini responseSchema (OpenAPI subset). */
export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    language: { type: 'STRING' },
    transcript: { type: 'STRING' },
    summary: { type: 'STRING' },
    findings: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          severity: { type: 'STRING', enum: ['info', 'minor', 'major', 'safety'] },
          equipment_hint: { type: 'STRING', nullable: true },
          confidence: { type: 'NUMBER' },
        },
        required: ['text', 'severity', 'confidence'],
      },
    },
    parts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING' }, quantity: { type: 'NUMBER' }, confidence: { type: 'NUMBER' } },
        required: ['name', 'quantity', 'confidence'],
      },
    },
    time_minutes: { type: 'NUMBER', nullable: true },
    time_confidence: { type: 'NUMBER' },
    customer_notes: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['transcript', 'summary', 'findings', 'parts', 'customer_notes'],
} as const;

export const SYSTEM_PROMPT = [
  'You turn a field technician\'s spoken dictation (English, Spanish or Persian; accents and noise are common) into a structured job log.',
  'Rules: transcribe faithfully; never invent facts, part names, quantities or times that were not said.',
  'If unsure of a word or number, lower the confidence (0-1) instead of guessing.',
  'severity "safety" only when the technician describes a hazard (gas, CO, electrical, structural, fire); do NOT give instructions or advice.',
  'time_minutes is the work time the technician stated, converted to minutes, else null.',
  'Keep text fields in the language spoken. Output JSON only.',
].join(' ');

const clamp01 = (n: unknown, fallback = 0.5): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;

function cleanText(v: unknown, max = MAX_TEXT): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Redacts emails, SSNs, card numbers (Luhn) and long phone-like numbers from free text. */
export function redactPii(input: string): string {
  let out = input.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]');
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[id]');
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[card]' : m;
  });
  // Phone: 9-13 digits AND visibly formatted (+, parentheses, spaces, dots, dashes) so bare serial numbers survive.
  out = out.replace(/(?<![\w])\+?\(?\d[\d\s().-]{7,}\d(?![\w])/g, (m) => {
    const digits = m.replace(/\D/g, '').length;
    return digits >= 9 && digits <= 13 && /[+\s().-]/.test(m) ? '[phone]' : m;
  });
  return out;
}

/** Validates/clamps untrusted model output. Returns null when nothing usable. */
export function normalizeExtraction(raw: unknown): VoiceExtraction | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const findings: VoiceFinding[] = (Array.isArray(r.findings) ? r.findings : []).slice(0, MAX_ITEMS).flatMap((f) => {
    if (!f || typeof f !== 'object') return [];
    const o = f as Record<string, unknown>;
    const text = redactPii(cleanText(o.text));
    if (!text) return [];
    const sev = SEVERITIES.includes(o.severity as Severity) ? (o.severity as Severity) : 'info';
    const hint = redactPii(cleanText(o.equipment_hint, 120));
    return [{ text, severity: sev, equipment_hint: hint || null, confidence: clamp01(o.confidence) }];
  });

  const parts: VoicePart[] = (Array.isArray(r.parts) ? r.parts : []).slice(0, MAX_ITEMS).flatMap((p) => {
    if (!p || typeof p !== 'object') return [];
    const o = p as Record<string, unknown>;
    const name = redactPii(cleanText(o.name, 160));
    if (!name) return [];
    const q = typeof o.quantity === 'number' && Number.isFinite(o.quantity) ? Math.round(o.quantity) : NaN;
    const valid = q >= 1 && q <= 999;
    // Invalid/missing quantity -> 1 with confidence forced below the review threshold.
    return [{ name, quantity: valid ? q : 1, confidence: valid ? clamp01(o.confidence) : Math.min(clamp01(o.confidence), 0.3) }];
  });

  const tm = typeof r.time_minutes === 'number' && Number.isFinite(r.time_minutes) ? Math.round(r.time_minutes) : null;
  const time_minutes = tm !== null && tm > 0 && tm <= 1440 ? tm : null;
  const time_confidence = time_minutes === null ? 0 : clamp01(r.time_confidence);

  const customer_notes = (Array.isArray(r.customer_notes) ? r.customer_notes : [])
    .slice(0, MAX_ITEMS).map((n) => redactPii(cleanText(n))).filter(Boolean);

  const transcript = redactPii(cleanText(r.transcript, 6000));
  const summary = redactPii(cleanText(r.summary, 1200));
  if (!transcript && !findings.length && !parts.length && time_minutes === null && !customer_notes.length) return null;

  const needs_review =
    findings.some((f) => f.confidence < LOW_CONFIDENCE || f.severity === 'safety') ||
    parts.some((p) => p.confidence < LOW_CONFIDENCE) ||
    (time_minutes !== null && time_confidence < LOW_CONFIDENCE);

  return {
    language: cleanText(r.language, 12) || 'und',
    transcript, summary, findings, parts, time_minutes, time_confidence, customer_notes, needs_review,
  };
}

export const AI_NOTE_PREFIX = '[AI-assisted voice log — reviewed and approved by technician]';

/** Plain-text job note written ONLY after the technician approves. */
export function buildJobNote(e: VoiceExtraction, ref?: string): string {
  // `ref` (short draft id) makes an accidental duplicate note recognisable after an offline retry.
  const lines: string[] = [ref ? `${AI_NOTE_PREFIX} [ref:${ref.slice(0, 8)}]` : AI_NOTE_PREFIX];
  if (e.summary) lines.push(e.summary);
  if (e.findings.length) lines.push('Findings:', ...e.findings.map((f) => `- ${f.severity === 'safety' ? '[SAFETY] ' : ''}${f.text}`));
  if (e.parts.length) lines.push('Parts:', ...e.parts.map((p) => `- ${p.quantity} × ${p.name}`));
  if (e.time_minutes !== null) lines.push(`Time: ${e.time_minutes} min`);
  if (e.customer_notes.length) lines.push('Customer notes:', ...e.customer_notes.map((n) => `- ${n}`));
  return lines.join('\n').slice(0, 4000);
}

export function mimeFromExt(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = { webm: 'audio/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', caf: 'audio/x-caf' };
  return map[ext] ?? 'audio/webm';
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const AUDIO_EXT_RE = /^(webm|ogg|mp3|m4a|mp4|aac|wav)$/i;

/** Required storage path: `${userId}/${jobId}/voice-log-${draftId}.${ext}` */
export function expectedAudioPath(userId: string, jobId: string, draftId: string, ext: string): string {
  return `${userId}/${jobId}/voice-log-${draftId}.${ext.toLowerCase()}`;
}
