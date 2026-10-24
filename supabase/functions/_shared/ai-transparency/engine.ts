// supabase/functions/_shared/ai-transparency/engine.ts
//
// AI-transparency compliance engine — PURE logic (no I/O, no Deno/DOM APIs besides
// Web Crypto), shared by the dashboard, the edge functions and the unit tests.
//
// NOT LEGAL ADVICE. Transparency, emotion-recognition and synthetic-media rules differ
// by jurisdiction, change often and have exceptions. Everything here is a compliance
// AID for the account owner; it does not replace legal review.

export const AI_TRANSPARENCY_NOTICE_VERSION = 1;

export const JURISDICTION_DISCLAIMER =
  'Rules on AI transparency, synthetic media, emotion recognition and call recording vary by country, state and industry, and they change. ' +
  'This module is a compliance aid, not legal advice. Have qualified counsel review every feature you enable for the places where you operate.';

export type AiCategory = 'interactive_ai' | 'synthetic_audio' | 'emotion_recognition' | 'other_ai';
export type EmotionBasis = 'text' | 'voice_audio';
export type FeatureModality = 'text' | 'voice' | 'audio_file' | 'multimodal';
export type Enforcement = 'runtime' | 'registry';
export type LegalReviewStatus = 'not_reviewed' | 'in_review' | 'reviewed';

export const AI_CATEGORIES: readonly AiCategory[] = ['interactive_ai', 'synthetic_audio', 'emotion_recognition', 'other_ai'];
export const LEGAL_REVIEW_STATUSES: readonly LegalReviewStatus[] = ['not_reviewed', 'in_review', 'reviewed'];

export const CATEGORY_LABELS: Record<AiCategory, string> = {
  interactive_ai: 'Interactive AI',
  synthetic_audio: 'Synthetic audio generation',
  emotion_recognition: 'Emotion recognition',
  other_ai: 'Other AI processing',
};

export const EMOTION_BASIS_LABELS: Record<EmotionBasis, string> = {
  text: 'Sentiment from text',
  voice_audio: 'Emotion from voice audio',
};

export interface CatalogEntry {
  feature_key: string;
  label: string;
  description: string;
  categories: AiCategory[];
  emotion_basis: EmotionBasis | null;
  modality: FeatureModality;
  provider: string;
  surface: string;
  default_enabled: boolean;
  requires_notice: boolean;
  notice_version: number;
  enforcement: Enforcement;
  shipped: boolean;
  sort_order: number;
}

/**
 * Canonical classification of every AI feature. MUST stay identical to the seed rows in
 * supabase/migrations/20271120000000_ai_transparency_compliance.sql — a unit test fails if they drift.
 */
export const AI_FEATURE_CATALOG: readonly CatalogEntry[] = [
  {
    feature_key: 'ai_voice_receptionist', label: 'AI voice receptionist',
    description: 'The AI phone assistant answers and speaks with callers in a synthetic voice. Callers must be able to tell they are talking to an AI.',
    categories: ['interactive_ai', 'synthetic_audio'], emotion_basis: null, modality: 'voice', provider: 'Vapi',
    surface: 'Phone calls', default_enabled: true, requires_notice: false, notice_version: 1, enforcement: 'registry', shipped: true, sort_order: 10,
  },
  {
    feature_key: 'ai_chat_assistants', label: 'AI chat assistants',
    description: 'Website chat, live-chat widget, homeowner assistant and in-dashboard assistants that reply to people in text.',
    categories: ['interactive_ai'], emotion_basis: null, modality: 'text', provider: 'LLM provider',
    surface: 'Website and dashboard chat', default_enabled: true, requires_notice: false, notice_version: 1, enforcement: 'registry', shipped: true, sort_order: 20,
  },
  {
    feature_key: 'ai_messaging_auto_reply', label: 'AI messaging auto-reply',
    description: 'AI-drafted or AI-sent replies to SMS and WhatsApp conversations.',
    categories: ['interactive_ai'], emotion_basis: null, modality: 'text', provider: 'LLM provider',
    surface: 'SMS and WhatsApp', default_enabled: true, requires_notice: false, notice_version: 1, enforcement: 'registry', shipped: true, sort_order: 30,
  },
  {
    feature_key: 'ai_voice_cloning', label: 'Custom cloned voice',
    description: 'Creates a synthetic copy of a voice from an uploaded sample so the AI assistant can speak in it. Only use voices you have the right to clone.',
    categories: ['synthetic_audio'], emotion_basis: null, modality: 'audio_file', provider: 'ElevenLabs',
    surface: 'Settings, Clone Your Own Voice', default_enabled: true, requires_notice: false, notice_version: 1, enforcement: 'runtime', shipped: true, sort_order: 40,
  },
  {
    feature_key: 'ai_voicemail_drops_ai_voice', label: 'AI-voiced voicemail drops',
    description: 'Voicemail drop recordings that were produced with an AI or cloned voice and are played to recipients.',
    categories: ['synthetic_audio'], emotion_basis: null, modality: 'audio_file', provider: 'Uploaded audio',
    surface: 'Voicemail Drops', default_enabled: true, requires_notice: false, notice_version: 1, enforcement: 'runtime', shipped: true, sort_order: 50,
  },
  {
    feature_key: 'ai_call_sentiment_text', label: 'Call sentiment (from transcript text)',
    description: 'After a call, an AI reads the transcript text and labels the caller sentiment positive, neutral or negative. No voice audio is analysed.',
    categories: ['emotion_recognition'], emotion_basis: 'text', modality: 'text', provider: 'LLM provider',
    surface: 'Call intelligence', default_enabled: true, requires_notice: false, notice_version: 1, enforcement: 'runtime', shipped: true, sort_order: 60,
  },
  {
    feature_key: 'ai_live_call_sentiment_text', label: 'Live call sentiment (from transcript text)',
    description: 'During a live call, the running transcript text of the caller is scored for sentiment on the Live Calls board. No voice audio is analysed.',
    categories: ['emotion_recognition'], emotion_basis: 'text', modality: 'text', provider: 'Rules on transcript text',
    surface: 'Live Calls', default_enabled: true, requires_notice: false, notice_version: 1, enforcement: 'runtime', shipped: true, sort_order: 70,
  },
  {
    feature_key: 'ai_voice_emotion_signals', label: 'Emotion from voice audio',
    description: 'Infers emotional state from how a person sounds (tone, pitch, pace), not from the words. No shipped Vireek feature does this today; the entry exists so any such feature must be registered, off by default and notice-gated.',
    categories: ['emotion_recognition'], emotion_basis: 'voice_audio', modality: 'voice', provider: 'Not in use',
    surface: 'Reserved', default_enabled: false, requires_notice: true, notice_version: 1, enforcement: 'runtime', shipped: false, sort_order: 80,
  },
  {
    feature_key: 'ai_conversation_intel', label: 'Conversation Intelligence (recorded audio analysis)',
    description: 'Transcribes a consented in-home recording and extracts commitments, objections, safety items and coaching. It is instructed not to infer emotion from the voice.',
    categories: ['other_ai'], emotion_basis: null, modality: 'audio_file', provider: 'Gemini',
    surface: 'Conversations', default_enabled: true, requires_notice: false, notice_version: 1, enforcement: 'registry', shipped: true, sort_order: 90,
  },
];

export function findCatalogEntry(key: string): CatalogEntry | null {
  return AI_FEATURE_CATALOG.find((e) => e.feature_key === key) ?? null;
}

/** Returns a list of problems (empty = valid). Mirrors the CHECK constraints in the migration. */
export function validateCatalogEntry(e: CatalogEntry): string[] {
  const issues: string[] = [];
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(e.feature_key)) issues.push('feature_key format');
  if (e.categories.length < 1) issues.push('at least one category');
  if (new Set(e.categories).size !== e.categories.length) issues.push('duplicate category');
  for (const c of e.categories) if (!AI_CATEGORIES.includes(c)) issues.push(`unknown category ${c}`);
  const isEmotion = e.categories.includes('emotion_recognition');
  if (isEmotion !== (e.emotion_basis !== null)) issues.push('emotion_basis must be set exactly when emotion_recognition is a category');
  if (e.requires_notice !== (e.emotion_basis === 'voice_audio')) issues.push('requires_notice must equal emotion_basis = voice_audio');
  if (e.requires_notice && e.default_enabled) issues.push('notice-gated features must default to off');
  if (e.notice_version < 1) issues.push('notice_version');
  return issues;
}

// ── Gate decision ────────────────────────────────────────────────────────────

export interface FeatureStateRow {
  enabled: boolean;
  notice_ok: boolean;
}

export interface GateDecision {
  allowed: boolean;
  reason: 'enabled' | 'disabled' | 'notice_required' | 'default' | 'fallback_open' | 'fallback_closed' | 'unknown_feature';
}

/**
 * Decides whether a feature may run for an account.
 *  - state present  -> enabled AND (notice acknowledged when required)
 *  - rpcFailed      -> fail OPEN only for features that default on and need no notice (never break the
 *                      business on an outage), fail CLOSED for everything else
 *  - no state       -> the catalog default (still closed when a notice is required)
 */
export function decideGate(entry: CatalogEntry | null, state: FeatureStateRow | null, rpcFailed = false): GateDecision {
  if (!entry) return { allowed: false, reason: 'unknown_feature' };
  if (state) {
    if (!state.enabled) return { allowed: false, reason: 'disabled' };
    if (entry.requires_notice && !state.notice_ok) return { allowed: false, reason: 'notice_required' };
    return { allowed: true, reason: 'enabled' };
  }
  const open = entry.default_enabled && !entry.requires_notice;
  if (rpcFailed) return { allowed: open, reason: open ? 'fallback_open' : 'fallback_closed' };
  return { allowed: open, reason: 'default' };
}

// ── Notices ──────────────────────────────────────────────────────────────────

export const VOICE_EMOTION_ACKNOWLEDGEMENTS: readonly string[] = [
  'I understand this feature infers emotional state from voice audio, which many jurisdictions treat as sensitive or biometric-adjacent processing.',
  'I will tell every person whose voice is analysed, before analysis starts, using the notice below (or a legally reviewed equivalent), and I will honour objections.',
  'I will not use it to evaluate, discipline, rank or manage employees, contractors, students or job applicants, where such use is restricted or prohibited.',
  'I have obtained, or will obtain before relying on it, legal review for every jurisdiction where this feature will run.',
];

export function buildVoiceEmotionNotice(companyName: string): string {
  const name = companyName.trim() || 'This business';
  return (
    `${name} may use software that estimates emotional tone from the sound of your voice during this call. ` +
    `This is used only to help improve service and is never the sole basis for any decision about you. ` +
    `You can tell us you object at any time and we will turn it off for your call.`
  );
}

export function buildAiInteractionDisclosure(companyName: string, assistantName = 'our virtual assistant'): string {
  const name = companyName.trim() || 'this business';
  return `You are speaking with ${assistantName}, an AI assistant for ${name}. You can ask for a human at any time.`;
}

// ── Provenance manifest ─────────────────────────────────────────────────────

export type ProvenanceSubject = 'generated_audio' | 'stored_recording' | 'voice_clone';

export const PROVENANCE_SCHEMA = 'vireek.ai-provenance/1';

export interface ProvenanceInput {
  subjectType: ProvenanceSubject;
  featureKey: string;
  provider: string;
  aiGeneratedAudio: boolean;
  aiProcessed: boolean;
  model?: string | null;
  contentSha256?: string | null;
  generatedAt?: string;
}

export interface ProvenanceManifest {
  schema: typeof PROVENANCE_SCHEMA;
  subject_type: ProvenanceSubject;
  feature_key: string;
  provider: string;
  ai_generated_audio: boolean;
  ai_processed: boolean;
  model: string | null;
  content_sha256: string | null;
  generated_at: string;
  generator: 'Vireek';
}

export function buildProvenanceManifest(i: ProvenanceInput): ProvenanceManifest {
  return {
    schema: PROVENANCE_SCHEMA,
    subject_type: i.subjectType,
    feature_key: i.featureKey,
    provider: i.provider,
    ai_generated_audio: i.aiGeneratedAudio,
    ai_processed: i.aiProcessed,
    model: i.model ?? null,
    content_sha256: i.contentSha256 ?? null,
    generated_at: i.generatedAt ?? new Date().toISOString(),
    generator: 'Vireek',
  };
}

export type EmbedMethod = 'id3v2.4' | 'none';

/** Container formats where metadata can be written in place without re-encoding. */
export function canEmbedProvenance(mime: string): boolean {
  const m = mime.split(';')[0].trim().toLowerCase();
  return m === 'audio/mpeg' || m === 'audio/mp3';
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

function synchsafe(n: number): number[] {
  return [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];
}
function unsynchsafe(b: Uint8Array, o: number): number {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function txxxFrame(description: string, value: string): Uint8Array {
  const d = enc.encode(description);
  const v = enc.encode(value);
  const body = new Uint8Array(1 + d.length + 1 + v.length);
  body[0] = 0x03; // UTF-8
  body.set(d, 1);
  body[1 + d.length] = 0x00;
  body.set(v, 2 + d.length);
  const frame = new Uint8Array(10 + body.length);
  frame.set(enc.encode('TXXX'), 0);
  frame.set(synchsafe(body.length), 4);
  frame.set(body, 10);
  return frame;
}

export interface EmbedResult {
  bytes: Uint8Array;
  embedded: boolean;
  method: EmbedMethod;
  reason: string | null;
}

/**
 * Prepends an ID3v2.4 tag carrying machine-readable provenance (TXXX frames) to an MP3.
 * Never alters audio frames. If the file already starts with an ID3 tag it is returned untouched
 * (embedded=false) so existing tags are never corrupted; the DB sidecar record still applies.
 */
export function embedId3Provenance(audio: Uint8Array, manifest: ProvenanceManifest): EmbedResult {
  if (audio.length >= 3 && audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) {
    return { bytes: audio, embedded: false, method: 'none', reason: 'file already has an ID3 tag' };
  }
  const frames = [
    txxxFrame('VIREEK_AI_GENERATED_AUDIO', String(manifest.ai_generated_audio)),
    txxxFrame('VIREEK_AI_PROCESSED', String(manifest.ai_processed)),
    txxxFrame('VIREEK_PROVENANCE', JSON.stringify(manifest)),
  ];
  const bodyLen = frames.reduce((s, f) => s + f.length, 0);
  const out = new Uint8Array(10 + bodyLen + audio.length);
  out.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00], 0);
  out.set(synchsafe(bodyLen), 6);
  let o = 10;
  for (const f of frames) { out.set(f, o); o += f.length; }
  out.set(audio, o);
  return { bytes: out, embedded: true, method: 'id3v2.4', reason: null };
}

/** Reads back the TXXX provenance frames written by embedId3Provenance (used by tests and audits). */
export function readId3Provenance(audio: Uint8Array): Record<string, string> | null {
  if (audio.length < 10 || audio[0] !== 0x49 || audio[1] !== 0x44 || audio[2] !== 0x33 || audio[3] !== 0x04) return null;
  const end = Math.min(audio.length, 10 + unsynchsafe(audio, 6));
  const out: Record<string, string> = {};
  let o = 10;
  while (o + 10 <= end) {
    const id = dec.decode(audio.subarray(o, o + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = unsynchsafe(audio, o + 4);
    const body = audio.subarray(o + 10, o + 10 + size);
    if (id === 'TXXX' && body.length > 1 && body[0] === 0x03) {
      const zero = body.indexOf(0x00, 1);
      if (zero > 0) out[dec.decode(body.subarray(1, zero))] = dec.decode(body.subarray(zero + 1));
    }
    o += 10 + size;
  }
  return Object.keys(out).length ? out : null;
}

// ── Registry export ──────────────────────────────────────────────────────────

export interface RegistryRow {
  feature_key: string;
  label: string;
  categories: AiCategory[];
  emotion_basis: EmotionBasis | null;
  modality: FeatureModality;
  provider: string;
  surface: string;
  enabled: boolean;
  allowed: boolean;
  notice_ok: boolean;
  requires_notice: boolean;
  notice_version_ack: number | null;
  notice_ack_at: string | null;
  legal_review_status: LegalReviewStatus;
  legal_reviewed_at: string | null;
  enforcement: Enforcement;
  shipped: boolean;
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  // Neutralise spreadsheet formula injection, then apply RFC 4180 quoting.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function registryToCsv(rows: readonly RegistryRow[]): string {
  const cols: Array<[string, (r: RegistryRow) => unknown]> = [
    ['feature_key', (r) => r.feature_key],
    ['label', (r) => r.label],
    ['categories', (r) => r.categories],
    ['emotion_basis', (r) => r.emotion_basis],
    ['modality', (r) => r.modality],
    ['provider', (r) => r.provider],
    ['surface', (r) => r.surface],
    ['enabled', (r) => r.enabled],
    ['allowed_to_run', (r) => r.allowed],
    ['notice_required', (r) => r.requires_notice],
    ['notice_acknowledged', (r) => r.notice_ok],
    ['notice_version_ack', (r) => r.notice_version_ack],
    ['notice_ack_at', (r) => r.notice_ack_at],
    ['legal_review_status', (r) => r.legal_review_status],
    ['legal_reviewed_at', (r) => r.legal_reviewed_at],
    ['enforcement', (r) => r.enforcement],
    ['shipped', (r) => r.shipped],
  ];
  const head = cols.map(([h]) => h).join(',');
  const lines = rows.map((r) => cols.map(([, f]) => csvCell(f(r))).join(','));
  return [head, ...lines].join('\r\n');
}

export function summarizeRegistry(rows: readonly RegistryRow[]) {
  const active = rows.filter((r) => r.allowed);
  return {
    total: rows.length,
    active: active.length,
    voiceEmotionActive: active.filter((r) => r.emotion_basis === 'voice_audio').length,
    awaitingLegalReview: active.filter((r) => r.legal_review_status !== 'reviewed').length,
    noticePending: rows.filter((r) => r.requires_notice && r.enabled && !r.notice_ok).length,
  };
}
