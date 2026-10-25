/**
 * AI Disclosure Proof Ledger — pure helpers (no network, no React).
 * DB side: supabase/migrations/20271112000000_ai_disclosure_proof_ledger.sql
 * Network side: src/lib/aiDisclosureLedgerApi.ts
 */

export type LedgerStatus = 'delivered' | 'late' | 'partial' | 'missing' | 'no_transcript' | 'not_applicable' | 'pending';
export type DriftStatus = 'in_sync' | 'drift' | 'no_first_message' | 'unreachable' | 'not_configured';

export interface LedgerRow {
  id: string;
  vapi_call_id: string;
  call_id: string | null;
  version_id: string | null;
  language: string;
  selection_reason: 'caller_language_match' | 'caller_language_translation' | 'default_fallback';
  disclosure_text: string;
  disclosure_sha256: string;
  status: LedgerStatus;
  matched_via: 'planned' | 'alternate_version' | null;
  delivered_at: string | null;
  offset_seconds: number | null;
  transcript_char_offset: number | null;
  matched_turn_index: number | null;
  match_score: number | null;
  evidence_excerpt: string | null;
  transcript_sha256: string | null;
  detected_language: string | null;
  language_mismatch: boolean;
  call_started_at: string | null;
  call_duration_seconds: number | null;
  alerted_at: string | null;
  created_at: string;
  calls?: { caller_name: string | null; caller_phone: string | null; call_datetime: string | null } | null;
}

export interface VersionRow {
  id: string;
  language: string;
  version: number;
  disclosure_text: string;
  text_sha256: string;
  source: 'business_profile' | 'builtin_translation' | 'owner_override';
  is_current: boolean;
  created_at: string;
  activated_at: string;
  superseded_at: string | null;
}

export interface DriftCheck {
  id: string;
  checked_at: string;
  trigger_source: 'scheduled' | 'manual';
  vapi_assistant_id: string | null;
  status: DriftStatus;
  reason: string | null;
  expected_text: string | null;
  live_first_message: string | null;
  similarity: number | null;
}

export interface LedgerSummary {
  total: number;
  delivered: number;
  late: number;
  partial: number;
  missing: number;
  no_transcript: number;
  not_applicable: number;
  pending: number;
  language_mismatch: number;
}

export const EMPTY_SUMMARY: LedgerSummary = {
  total: 0, delivered: 0, late: 0, partial: 0, missing: 0, no_transcript: 0, not_applicable: 0, pending: 0, language_mismatch: 0,
};

export const STATUSES: LedgerStatus[] = ['delivered', 'late', 'partial', 'missing', 'no_transcript', 'not_applicable', 'pending'];

export const STATUS_META: Record<LedgerStatus, { label: string; hint: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  delivered: { label: 'Delivered', hint: 'The disclosure is in the transcript, in the opening of the call.', tone: 'good' },
  late: { label: 'Late', hint: 'Spoken, but not in the opening of the call.', tone: 'warn' },
  partial: { label: 'Partial', hint: 'Only part of it was spoken (for example the caller interrupted).', tone: 'bad' },
  missing: { label: 'Missing', hint: 'The assistant spoke but the disclosure is not in the transcript.', tone: 'bad' },
  no_transcript: { label: 'No transcript', hint: 'No transcript came back, so this call could not be verified.', tone: 'warn' },
  not_applicable: { label: 'Not applicable', hint: 'The call ended before the assistant could speak.', tone: 'neutral' },
  pending: { label: 'In progress', hint: 'The call has not finished yet.', tone: 'neutral' },
};

export const DRIFT_META: Record<DriftStatus, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral'; help: string }> = {
  in_sync: { label: 'In sync', tone: 'good', help: 'Your live assistant opens with your disclosure.' },
  drift: { label: 'Out of sync', tone: 'bad', help: "Your live assistant's first message no longer opens with your disclosure." },
  no_first_message: { label: 'No fixed first message', tone: 'bad', help: 'The assistant has no fixed first message, so the disclosure cannot be guaranteed.' },
  unreachable: { label: "Couldn't check", tone: 'warn', help: "We couldn't read your assistant from Vapi. This does not mean anything is wrong." },
  not_configured: { label: 'No assistant linked', tone: 'neutral', help: 'Link your Vapi assistant to enable automatic checks.' },
};

export const DRIFT_REASONS: Record<string, string> = {
  exact_match: 'The first message opens with your disclosure.',
  uses_dynamic_variable: 'The first message uses {{ai_disclosure}}, which always inserts the right wording and language.',
  disclosure_missing: "The live first message doesn't contain your disclosure.",
  wording_differs: 'The live first message has a different wording than your disclosure.',
  disclosure_not_at_start: 'Your disclosure is in the first message, but not at the start.',
  live_first_message_empty: 'The assistant has no first message set.',
  assistant_not_found: 'Vapi could not find the linked assistant. Check the assistant ID.',
  vapi_auth_failed: 'Vapi rejected our API key.',
  vapi_key_missing: 'Automatic checks are not configured on the server yet.',
  vapi_unreachable: 'Vapi did not answer in time.',
  no_vapi_assistant_linked: 'No Vapi assistant is linked to this account.',
};

export function driftReasonText(reason: string | null): string {
  if (!reason) return '';
  if (DRIFT_REASONS[reason]) return DRIFT_REASONS[reason];
  if (reason.startsWith('first_message_mode_')) return 'The assistant waits for the caller or generates its own first message.';
  if (reason.startsWith('vapi_http_')) return 'Vapi returned an unexpected error.';
  return reason;
}

export const LANGUAGE_OPTIONS = [
  { code: 'en', label: 'English' }, { code: 'es', label: 'Español' }, { code: 'zh', label: '简体中文' },
  { code: 'hi', label: 'हिन्दी' }, { code: 'fr', label: 'Français' }, { code: 'de', label: 'Deutsch' },
  { code: 'ar', label: 'العربية' }, { code: 'fa', label: 'فارسی' }, { code: 'ja', label: '日本語' },
] as const;

export function languageLabel(code: string | null | undefined): string {
  return LANGUAGE_OPTIONS.find((l) => l.code === code)?.label ?? (code ? code.toUpperCase() : '—');
}

export const REASON_LABEL: Record<LedgerRow['selection_reason'], string> = {
  caller_language_match: "Caller's language",
  caller_language_translation: 'Translated for caller',
  default_fallback: 'Default (caller language unknown)',
};

export type RangeKey = '7d' | '30d' | '90d';
export const RANGES: { key: RangeKey; label: string; days: number }[] = [
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
];

export function rangeBounds(key: RangeKey, now: Date = new Date()): { from: string; to: string } {
  const days = RANGES.find((r) => r.key === key)?.days ?? 30;
  return { from: new Date(now.getTime() - days * 86_400_000).toISOString(), to: new Date(now.getTime() + 60_000).toISOString() };
}

/** Share of verifiable calls that carried the disclosure (null when nothing to verify). */
export function deliveryRate(s: LedgerSummary): number | null {
  const verifiable = s.delivered + s.late + s.partial + s.missing;
  return verifiable === 0 ? null : s.delivered / verifiable;
}

export function needsAttention(s: LedgerSummary): number {
  return s.missing + s.partial + s.late;
}

export function formatOffset(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const rest = (seconds - m * 60).toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2, '0')}:${rest}`;
}

export function shortHash(hash: string | null): string {
  return hash ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : '—';
}

export function normalizeSummary(raw: unknown): LedgerSummary {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (k: keyof LedgerSummary) => (typeof r[k] === 'number' && Number.isFinite(r[k] as number) ? (r[k] as number) : 0);
  return {
    total: n('total'), delivered: n('delivered'), late: n('late'), partial: n('partial'), missing: n('missing'),
    no_transcript: n('no_transcript'), not_applicable: n('not_applicable'), pending: n('pending'), language_mismatch: n('language_mismatch'),
  };
}

// ---------------------------------------------------------------------------
// Audit export
// ---------------------------------------------------------------------------

/** Neutralises spreadsheet formula injection and quotes per RFC 4180. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS: { header: string; get: (r: LedgerRow) => unknown }[] = [
  { header: 'call_started_at_utc', get: (r) => r.call_started_at ?? r.calls?.call_datetime ?? r.created_at },
  { header: 'vapi_call_id', get: (r) => r.vapi_call_id },
  { header: 'call_id', get: (r) => r.call_id },
  { header: 'status', get: (r) => r.status },
  { header: 'language', get: (r) => r.language },
  { header: 'language_selection', get: (r) => r.selection_reason },
  { header: 'caller_detected_language', get: (r) => r.detected_language },
  { header: 'language_mismatch', get: (r) => r.language_mismatch },
  { header: 'disclosure_text', get: (r) => r.disclosure_text },
  { header: 'disclosure_sha256', get: (r) => r.disclosure_sha256 },
  { header: 'delivered_at_utc', get: (r) => r.delivered_at },
  { header: 'offset_seconds', get: (r) => r.offset_seconds },
  { header: 'transcript_char_offset', get: (r) => r.transcript_char_offset },
  { header: 'match_score', get: (r) => r.match_score },
  { header: 'evidence_excerpt', get: (r) => r.evidence_excerpt },
  { header: 'transcript_sha256', get: (r) => r.transcript_sha256 },
  { header: 'call_duration_seconds', get: (r) => r.call_duration_seconds },
  { header: 'alert_sent_at_utc', get: (r) => r.alerted_at },
];

/** UTF-8 BOM first so Excel opens non-Latin disclosure text correctly. */
export function buildCsv(rows: LedgerRow[]): string {
  const head = CSV_COLUMNS.map((c) => csvCell(c.header)).join(',');
  const body = rows.map((r) => CSV_COLUMNS.map((c) => csvCell(c.get(r))).join(','));
  return `﻿${[head, ...body].join('\r\n')}\r\n`;
}

export interface AuditBundle {
  report: 'vireek.ai_disclosure_audit';
  schema_version: 1;
  generated_at: string;
  range: { from: string; to: string };
  summary: LedgerSummary;
  delivery_rate: number | null;
  versions: VersionRow[];
  drift_checks: DriftCheck[];
  calls: LedgerRow[];
  /** SHA-256 of JSON.stringify(calls): lets a reader detect later edits to the export. */
  calls_sha256: string | null;
}

export async function sha256Hex(text: string): Promise<string | null> {
  try {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export async function buildAuditBundle(input: {
  range: { from: string; to: string };
  summary: LedgerSummary;
  versions: VersionRow[];
  drift: DriftCheck[];
  rows: LedgerRow[];
  now?: Date;
}): Promise<AuditBundle> {
  return {
    report: 'vireek.ai_disclosure_audit',
    schema_version: 1,
    generated_at: (input.now ?? new Date()).toISOString(),
    range: input.range,
    summary: input.summary,
    delivery_rate: deliveryRate(input.summary),
    versions: input.versions,
    drift_checks: input.drift,
    calls: input.rows,
    calls_sha256: await sha256Hex(JSON.stringify(input.rows)),
  };
}

export function exportFileName(kind: 'csv' | 'json', range: RangeKey, now: Date = new Date()): string {
  return `vireek-ai-disclosure-audit-${range}-${now.toISOString().slice(0, 10)}.${kind}`;
}
