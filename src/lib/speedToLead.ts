/**
 * Speed-to-lead voice callback: types and pure helpers for the dashboard.
 * All server decisions (consent, DNC, quiet hours, window) live in
 * supabase/functions/_shared/speed-to-lead/core.ts; nothing here decides whether a call is allowed.
 */

export type RequestStatus =
  | 'queued' | 'dialing' | 'booked' | 'handoff' | 'not_interested' | 'unreachable'
  | 'suppressed' | 'expired' | 'cancelled' | 'needs_review';

export type SourceKind = 'web_form' | 'landing_page' | 'meta_lead_ads' | 'google_lead_form' | 'zapier_or_api';

export interface SpeedToLeadSettings {
  enabled: boolean;
  sla_seconds: number;
  max_attempts: number;
  retry_delays_minutes: number[];
  call_window_start: string; // HH:MM
  call_window_end: string;
  lead_ttl_hours: number;
  qualification_notes: string | null;
  notify_on_handoff: boolean;
}

export const DEFAULT_SETTINGS: SpeedToLeadSettings = {
  enabled: false,
  sla_seconds: 60,
  max_attempts: 3,
  retry_delays_minutes: [5, 60],
  call_window_start: '09:00',
  call_window_end: '20:00',
  lead_ttl_hours: 48,
  qualification_notes: null,
  notify_on_handoff: true,
};

export interface SpeedToLeadSource {
  id: string;
  name: string;
  kind: SourceKind;
  token_hint: string;
  disclosure_text: string;
  disclosure_version: number;
  enabled: boolean;
  last_lead_at: string | null;
  created_at: string;
}

export interface SpeedToLeadRequest {
  id: string;
  full_name: string | null;
  phone_e164: string;
  service: string | null;
  received_at: string;
  status: RequestStatus;
  final_reason: string | null;
  attempt_count: number;
  needs_human: boolean;
  human_reason: string | null;
  handled_at: string | null;
  first_dial_at: string | null;
  time_to_first_dial_ms: number | null;
  sla_met: boolean | null;
  next_attempt_at: string | null;
}

export interface SpeedToLeadMetrics {
  total: number;
  dialed: number;
  within_sla: number;
  median_ms: number | null;
  p90_ms: number | null;
  booked: number;
  handoff: number;
  open_handoffs: number;
  suppressed: number;
}

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  web_form: 'Website form',
  landing_page: 'Landing page',
  meta_lead_ads: 'Meta lead ads',
  google_lead_form: 'Google lead form',
  zapier_or_api: 'Zapier / API',
};

export const STATUS_LABELS: Record<RequestStatus, string> = {
  queued: 'Queued',
  dialing: 'Calling',
  booked: 'Booked',
  handoff: 'Handed to team',
  not_interested: 'Not interested',
  unreachable: 'Unreachable',
  suppressed: 'Suppressed',
  expired: 'Expired',
  cancelled: 'Cancelled',
  needs_review: 'Needs review',
};

const HUMAN_REASONS: Record<string, string> = {
  caller_requested_human: 'Asked to speak with a person',
  qualified_lead: 'Qualified and ready for a human',
  no_clear_outcome: 'Spoke with the AI; review and follow up',
  no_contact_after_attempts: 'Not reached after all attempts',
  lead_ttl_exceeded: 'Went stale before we could call',
  ai_call_not_permitted: 'No AI-call consent; call manually',
  stale_disclosure: 'Outdated consent form; review before calling',
  stale_submission: 'Old submission; review before calling',
  voice_not_configured: 'Voice assistant is not configured',
  dial_failed: 'The call was rejected',
  dial_state_unknown: 'May have been called; check before dialing again',
  no_call_report: 'Called but no result came back',
  feature_disabled: 'Arrived while speed-to-lead was off',
};

export function humanReasonLabel(reason: string | null): string {
  return reason ? (HUMAN_REASONS[reason] ?? 'Needs follow-up') : '';
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

export function slaPercent(m: Pick<SpeedToLeadMetrics, 'dialed' | 'within_sla'>): number | null {
  return m.dialed > 0 ? Math.round((m.within_sla / m.dialed) * 100) : null;
}

export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** US/Canada number -> E.164, or null. Mirrors the server's NANP rule. */
export function toUsE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  const e164 = `+1${ten}`;
  return ten.length === 10 && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e164) ? e164 : null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const toMin = (v: string): number => {
  const m = /^(\d{1,2}):(\d{2})/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

export function validateSettings(s: SpeedToLeadSettings): string[] {
  const errors: string[] = [];
  const start = toMin(s.call_window_start);
  const end = toMin(s.call_window_end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) errors.push('Enter a valid calling window.');
  else {
    if (start < 8 * 60 || end > 21 * 60) errors.push('The calling window must stay between 8:00 AM and 9:00 PM (recipient local time).');
    if (start >= end) errors.push('The window must start before it ends.');
  }
  if (!Number.isInteger(s.sla_seconds) || s.sla_seconds < 15 || s.sla_seconds > 300) errors.push('Response target must be 15 to 300 seconds.');
  if (!Number.isInteger(s.max_attempts) || s.max_attempts < 1 || s.max_attempts > 3) errors.push('Attempts must be 1 to 3 (state law limits repeated calls).');
  if (s.retry_delays_minutes.length > 2 || s.retry_delays_minutes.some((d) => !Number.isInteger(d) || d < 1 || d > 1440)) {
    errors.push('Retry delays must be up to two whole numbers between 1 and 1440 minutes.');
  }
  if (!Number.isInteger(s.lead_ttl_hours) || s.lead_ttl_hours < 1 || s.lead_ttl_hours > 168) errors.push('Lead freshness must be 1 to 168 hours.');
  if ((s.qualification_notes ?? '').length > 1500) errors.push('Qualification notes are limited to 1500 characters.');
  return errors;
}

export function parseDelays(input: string): number[] {
  return input
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((x) => Number(x));
}

export const DISCLOSURE_CHECKS: { id: string; label: string; test: (t: string) => boolean }[] = [
  { id: 'ai', label: 'Says calls use an AI / artificial voice', test: (t) => /\b(ai|artificial|automated)\b/i.test(t) },
  { id: 'calls', label: 'Names calls to the number provided', test: (t) => /\bcall/i.test(t) },
  { id: 'business', label: 'Names the business', test: (t) => /\b(we|us|our|company|inc|llc)\b/i.test(t) || t.length > 140 },
  { id: 'not_condition', label: 'States consent is not a condition of purchase', test: (t) => /condition of (any )?(purchase|service)|not required to (buy|purchase)/i.test(t) },
  { id: 'revoke', label: 'Explains how to revoke (e.g. say stop / reply STOP)', test: (t) => /\b(stop|revoke|opt[- ]?out|unsubscribe)\b/i.test(t) },
];

export function disclosureGaps(text: string): string[] {
  return DISCLOSURE_CHECKS.filter((c) => !c.test(text)).map((c) => c.label);
}

export function defaultDisclosure(businessName: string): string {
  const who = businessName.trim() || '[Business name]';
  return `By checking this box and submitting this form, I agree that ${who} may contact me at the phone number provided, including by calls that use an artificial or AI-generated voice and automated technology, about my request. Consent is not a condition of any purchase. I can revoke consent at any time by saying "stop" on a call or replying STOP to a message.`;
}

// ---------------------------------------------------------------------------
// Tokens (generated in the browser; only the hash is stored)
// ---------------------------------------------------------------------------

export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function buildCurlSnippet(endpointUrl: string, token: string, disclosureVersion: number): string {
  return [
    `curl -X POST '${endpointUrl}' \\`,
    `  -H 'X-Vireek-Token: ${token}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{`,
    `    "name": "Jane Smith",`,
    `    "phone": "(415) 555-2671",`,
    `    "email": "jane@example.com",`,
    `    "service": "AC repair",`,
    `    "message": "Unit stopped cooling",`,
    `    "consent": true,`,
    `    "disclosure_version": ${disclosureVersion},`,
    `    "submission_id": "<your unique form submission id>",`,
    `    "submitted_at": "<ISO timestamp of the submit>",`,
    `    "page_url": "https://your-site.com/contact",`,
    `    "ip_address": "<visitor IP>",`,
    `    "user_agent": "<visitor user agent>"`,
    `  }'`,
  ].join('\n');
}
