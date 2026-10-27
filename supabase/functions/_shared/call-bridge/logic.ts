// supabase/functions/_shared/call-bridge/logic.ts
// Pure helpers shared by call-bridge-voice, proxy-call-bridge and dialer-call. No imports on purpose:
// this file is unit-tested with vitest and runs unchanged in Deno.

const E164 = /^\+[1-9][0-9]{7,14}$/;

/** Mirrors public.normalize_phone_e164() in the database. */
export function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  const d = t.replace(/\D/g, '');
  if (t.startsWith('+')) return /^[1-9][0-9]{7,14}$/.test(d) ? `+${d}` : null;
  if (/^[2-9][0-9]{9}$/.test(d)) return `+1${d}`;
  if (/^1[2-9][0-9]{9}$/.test(d)) return `+${d}`;
  return null;
}

export const isE164 = (v: string | null | undefined): v is string => !!v && E164.test(v);

/** "+15551234567" -> "4567" (used for logs, never the full number). */
export function last4(phone: string | null | undefined): string {
  const d = (phone ?? '').replace(/\D/g, '');
  return d.slice(-4);
}

export function xmlEscape(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string));
}

export type DialStatus = 'completed' | 'busy' | 'no_answer' | 'failed' | 'canceled';

/** Twilio DialCallStatus / CallStatus -> our status vocabulary. */
export function mapTwilioStatus(raw: string | null | undefined): DialStatus | 'in_progress' | 'ringing' | 'initiated' {
  switch ((raw ?? '').toLowerCase()) {
    case 'completed': return 'completed';
    case 'busy': return 'busy';
    case 'no-answer': return 'no_answer';
    case 'canceled': return 'canceled';
    case 'in-progress': case 'answered': return 'in_progress';
    case 'ringing': return 'ringing';
    case 'queued': case 'initiated': return 'initiated';
    default: return 'failed';
  }
}

export function parseDuration(raw: string | null | undefined): number | null {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 && n <= 86_400 ? n : null;
}

export interface DialArgs {
  callerId: string;
  number: string;
  /** Absolute URL Twilio calls when the <Dial> ends (DialCallStatus / DialCallDuration). */
  action: string;
  timeout?: number;
}

/** TwiML that connects the caller to `number`, showing `callerId`. Throws on invalid numbers. */
export function dialTwiml({ callerId, number, action, timeout = 30 }: DialArgs): string {
  if (!isE164(callerId) || !isE164(number)) throw new Error('dialTwiml: numbers must be E.164');
  const t = Math.min(Math.max(Math.trunc(timeout), 5), 60);
  return `<Dial callerId="${xmlEscape(callerId)}" answerOnBridge="true" timeout="${t}" action="${xmlEscape(action)}" method="POST"><Number>${xmlEscape(number)}</Number></Dial>`;
}

export function sayHangup(message: string): string {
  return `<Say>${xmlEscape(message)}</Say><Hangup/>`;
}

/** Builds `${base}?action=..&k=v` (the same string Twilio signs). */
export function callbackUrl(base: string, action: string, params: Record<string, string> = {}): string {
  return `${base}?${new URLSearchParams({ action, ...params }).toString()}`;
}
