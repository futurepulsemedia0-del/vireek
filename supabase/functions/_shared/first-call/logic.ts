// supabase/functions/_shared/first-call/logic.ts
// Pure rules for the "Call Sarah now" first-call flow. Shared by the edge function and the browser
// (src/lib/firstCall.ts re-exports it), so what the UI promises and what the server enforces cannot drift.
// No imports, no I/O.

export type SessionStatus = 'created' | 'waiting_for_number' | 'ringing' | 'in_call' | 'completed' | 'no_answer' | 'voicemail' | 'failed' | 'canceled';
export type FailureCode =
  | 'not_configured' | 'number_pending' | 'invalid_number' | 'unsupported_destination' | 'rate_limited'
  | 'carrier_error' | 'no_answer' | 'voicemail' | 'busy' | 'canceled' | 'provider_error';

export interface FirstCallSession {
  id: string;
  channel: 'phone' | 'browser';
  status: SessionStatus;
  failure_code: FailureCode | null;
  phone_calling_code: string | null;
  phone_last4: string | null;
  notify_when_ready: boolean;
  signup_at: string | null;
  requested_at: string;
  ringing_at: string | null;
  answered_at: string | null;
  first_transcript_at: string | null;
  booking_at: string | null;
  completed_at: string | null;
  call_id: string | null;
  job_id: string | null;
}

export const TERMINAL: readonly SessionStatus[] = ['completed', 'no_answer', 'voicemail', 'failed', 'canceled'];
export const isTerminal = (s: SessionStatus) => TERMINAL.includes(s);

// ---------------------------------------------------------------- destination numbers

/** Calling codes Vireek will ring by default. Extend with FIRST_CALL_ALLOWED_CODES (comma list) on the server. */
export const DEFAULT_ALLOWED_CODES: readonly string[] = [
  '1', '27', '31', '32', '33', '34', '39', '41', '43', '44', '45', '46', '47', '49', '52', '55',
  '61', '64', '65', '81', '82', '91', '351', '353', '358', '852', '966', '971', '972',
];
/** Premium-rate / toll-fraud prefixes that are never rung, whatever the allow-list says. */
export const BLOCKED_PREFIXES: readonly string[] = ['+1900', '+1976', '+449', '+3389', '+31900', '+49900', '+49137', '+49180'];

export type Destination =
  | { ok: true; e164: string; callingCode: string; last4: string; international: boolean }
  | { ok: false; code: 'invalid_number' | 'unsupported_destination'; hint: string };

/** `+` numbers are international. Without `+`, a 10-digit (or 1+10-digit) number is read as North American. */
export function parseDestination(raw: string, allowed: readonly string[] = DEFAULT_ALLOWED_CODES): Destination {
  const t = (raw ?? '').trim();
  if (t.length === 0 || t.length > 32) return { ok: false, code: 'invalid_number', hint: 'Enter your mobile number, including the country code if it is outside the US or Canada.' };
  if (/[^\d\s()+\-.]/.test(t) || (t.includes('+') && !t.startsWith('+')) || (t.match(/\+/g)?.length ?? 0) > 1) {
    return { ok: false, code: 'invalid_number', hint: 'Use digits only, with an optional leading +.' };
  }
  const d = t.replace(/\D/g, '');
  let e164: string | null = null;
  if (t.startsWith('+')) e164 = /^[1-9][0-9]{7,14}$/.test(d) ? `+${d}` : null;
  else if (/^[2-9][0-9]{9}$/.test(d)) e164 = `+1${d}`;
  else if (/^1[2-9][0-9]{9}$/.test(d)) e164 = `+${d}`;
  if (!e164) return { ok: false, code: 'invalid_number', hint: 'That does not look like a full phone number. Outside the US or Canada, start with + and the country code.' };

  if (BLOCKED_PREFIXES.some((p) => e164!.startsWith(p))) {
    return { ok: false, code: 'unsupported_destination', hint: 'We cannot ring premium-rate numbers. Enter your own mobile number, or use your browser instead.' };
  }
  const digits = e164.slice(1);
  const code = [...allowed].sort((a, b) => b.length - a.length).find((c) => digits.startsWith(c));
  if (!code) return { ok: false, code: 'unsupported_destination', hint: 'We cannot ring numbers in that country yet. Use your browser to talk to Sarah instead.' };
  return { ok: true, e164, callingCode: `+${code}`, last4: digits.slice(-4), international: code !== '1' };
}

// ---------------------------------------------------------------- abuse limits

export const LIMITS = { perHour: 3, perDay: 8 } as const;
export function rateDecision(startedLastHour: number, startedLastDay: number): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  if (startedLastHour >= LIMITS.perHour) return { allowed: false, retryAfterSeconds: 3600 };
  if (startedLastDay >= LIMITS.perDay) return { allowed: false, retryAfterSeconds: 6 * 3600 };
  return { allowed: true };
}

// ---------------------------------------------------------------- provider outcome

/** Maps Vapi's endedReason to a session outcome (same substring approach as outbound-dialer; the SQL trigger mirrors it). */
export function classifyEnded(endedReason: string | null | undefined, answered: boolean): { status: SessionStatus; failure: FailureCode | null } {
  const r = (endedReason ?? '').toLowerCase();
  if (r.includes('voicemail')) return { status: 'voicemail', failure: 'voicemail' };
  if (r.includes('did-not-answer') || r.includes('no-answer')) return { status: 'no_answer', failure: 'no_answer' };
  if (r.includes('busy')) return { status: 'failed', failure: 'busy' };
  if (answered) return { status: 'completed', failure: null };
  if (/(twilio|carrier|sip|failed-to-connect)/.test(r)) return { status: 'failed', failure: 'carrier_error' };
  return { status: 'failed', failure: 'provider_error' };
}

// ---------------------------------------------------------------- progress (real timestamps only, never a fake percentage)

export type StageId = 'requested' | 'ringing' | 'answered' | 'transcribing' | 'booked';
export interface Stage { id: StageId; label: string; at: string | null; done: boolean; active: boolean }

export function stagesOf(s: Pick<FirstCallSession, 'channel' | 'requested_at' | 'ringing_at' | 'answered_at' | 'first_transcript_at' | 'booking_at' | 'status'>): Stage[] {
  const ringLabel = s.channel === 'phone' ? 'Your phone is ringing' : 'Connecting your browser';
  const base: [StageId, string, string | null][] = [
    ['requested', 'Starting the call', s.requested_at],
    ['ringing', ringLabel, s.ringing_at],
    ['answered', 'Sarah picked up', s.answered_at],
    ['transcribing', 'Live transcript', s.first_transcript_at],
    ['booked', 'Booking captured', s.booking_at],
  ];
  const firstOpen = base.findIndex(([, , at]) => at === null);
  return base.map(([id, label, at], i) => ({ id, label, at, done: at !== null, active: !isTerminal(s.status) && i === firstOpen }));
}

// ---------------------------------------------------------------- KPI + recovery advice

/** Whole seconds from signup to the owner hearing Sarah. null if either end is missing or out of order. */
export function secondsBetween(fromIso: string | null | undefined, toIso: string | null | undefined): number | null {
  const a = fromIso ? Date.parse(fromIso) : NaN;
  const b = toIso ? Date.parse(toIso) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 1000) : null;
}
/** Coarse bucket for the consent-gated GA event, so no precise per-user timing leaves the product. */
export function ttfcBucket(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  return seconds < 60 ? '<60s' : seconds < 90 ? '60-90s' : seconds < 180 ? '90-180s' : seconds < 600 ? '3-10m' : '10m+';
}

export const RING_PATIENCE_MS = 40_000;
export type Advice = 'none' | 'offer_browser';
/** When to start offering the in-browser call: ringing too long, or any outcome where the phone path did not work. */
export function adviceFor(s: Pick<FirstCallSession, 'channel' | 'status' | 'requested_at' | 'answered_at'>, nowMs: number): Advice {
  if (s.channel === 'browser') return 'none';
  if (['no_answer', 'voicemail', 'failed', 'waiting_for_number'].includes(s.status)) return 'offer_browser';
  if (s.status === 'ringing' || s.status === 'created') return !s.answered_at && nowMs - Date.parse(s.requested_at) > RING_PATIENCE_MS ? 'offer_browser' : 'none';
  return 'none';
}

export interface Copy { title: string; body: string }
export function failureCopy(code: FailureCode | null): Copy {
  switch (code) {
    case 'voicemail': return { title: 'Your voicemail picked up', body: 'Sarah can’t talk to a voicemail box. Try again and answer the call yourself, or talk to her in your browser.' };
    case 'no_answer': return { title: 'Your phone didn’t pick up', body: 'It rang but nobody answered. Check you have signal, then try again, or talk to Sarah in your browser.' };
    case 'busy': return { title: 'Your line was busy', body: 'Finish your other call and try again, or talk to Sarah in your browser.' };
    case 'carrier_error': return { title: 'Your carrier blocked the call', body: 'Some carriers block unknown numbers. Try again in a minute, or talk to Sarah in your browser instead.' };
    case 'rate_limited': return { title: 'That’s enough tries for now', body: 'You can try again a little later, or talk to Sarah in your browser, which has no limit.' };
    case 'invalid_number': return { title: 'Check that number', body: 'That doesn’t look like a full phone number.' };
    case 'unsupported_destination': return { title: 'We can’t ring that number', body: 'Use your browser to talk to Sarah instead.' };
    case 'number_pending': return { title: 'Your Sarah number is being set up', body: 'Phone numbers can take a little while to activate. We’ll text you the moment it’s ready. Until then you can talk to her in your browser.' };
    case 'not_configured': return { title: 'Phone calling isn’t switched on yet', body: 'You can still talk to Sarah in your browser right now.' };
    case 'canceled': return { title: 'Call cancelled', body: 'No problem. Start again whenever you like.' };
    default: return { title: 'Something went wrong on our side', body: 'Please try again, or talk to Sarah in your browser.' };
  }
}
