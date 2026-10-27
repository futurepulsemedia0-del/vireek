// supabase/functions/_shared/browser-extension/logic.ts
// Pure decisions for the Chrome extension API: NO imports, NO I/O.
// Shared by the `browser-extension` edge function and unit-tested in logic.test.ts.

const E164 = /^\+[1-9]\d{7,14}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;

export const MAX_BODY_BYTES = 16 * 1024;
export const TERMINAL_STATUSES = ['completed', 'busy', 'no_answer', 'failed', 'canceled'] as const;

export const isValidE164 = (v: unknown): v is string => typeof v === 'string' && E164.test(v);
export const isValidRequestId = (v: unknown): v is string => typeof v === 'string' && REQUEST_ID.test(v);
export const isTerminalStatus = (s: string): boolean => (TERMINAL_STATUSES as readonly string[]).includes(s);

/** "+15551234567", "(555) 123-4567", "1-555-123-4567", "0044 20 7946 0958" -> E.164, else null. */
export function toE164(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.length > 40) return null;
  const digits = t.replace(/\D/g, '');
  if (t.startsWith('+')) return E164.test(`+${digits}`) ? `+${digits}` : null;
  if (digits.startsWith('00')) return E164.test(`+${digits.slice(2)}`) ? `+${digits.slice(2)}` : null;
  if (digits.length === 10) return E164.test(`+1${digits}`) ? `+1${digits}` : null;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export function maskPhone(e164: string | null | undefined): string {
  if (!e164 || e164.length < 6) return '';
  return `${e164.slice(0, 2)}\u2022\u2022\u2022\u2022${e164.slice(-3)}`;
}

/** Destinations we never dial from a browser click: premium-rate, N11 service codes, invalid NANP. */
export function blockedDestination(e164: string): string | null {
  if (!isValidE164(e164)) return 'invalid_number';
  if (e164.startsWith('+1')) {
    const area = e164.slice(2, 5);
    const exch = e164.slice(5, 8);
    if (e164.length !== 12) return 'invalid_number';
    if (/^[01]/.test(area) || /^[01]/.test(exch)) return 'invalid_number';
    if (/^\d11$/.test(area)) return 'service_code';
    if (area === '900' || area === '976') return 'premium_rate';
    return null;
  }
  if (/^\+(44(9|70)|339|49(137|900)|8190|61(190|19)|882|883|979)/.test(e164)) return 'premium_rate';
  return null;
}

export function countryAllowed(e164: string, allowedPrefixes: unknown): boolean {
  const list = Array.isArray(allowedPrefixes) && allowedPrefixes.length ? allowedPrefixes : ['+1'];
  return list.some((p) => typeof p === 'string' && p.startsWith('+') && e164.startsWith(p));
}

export function pickCallerId(candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) if (isValidE164(c)) return c;
  return null;
}

export function rateLimitDecision(a: {
  minuteCount: number; dayCount: number; perMinute: number; perDay: number;
}): { ok: true } | { ok: false; scope: 'minute' | 'day'; retryAfterSeconds: number } {
  if (a.minuteCount >= a.perMinute) return { ok: false, scope: 'minute', retryAfterSeconds: 60 };
  if (a.dayCount >= a.perDay) return { ok: false, scope: 'day', retryAfterSeconds: 3600 };
  return { ok: true };
}

const xml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string));

/** Agent's phone rings first; when answered, Twilio dials the customer showing the business number. */
export function buildBridgeTwiml(a: { customerE164: string; callerId: string; whisper: string }): string {
  if (!isValidE164(a.customerE164) || !isValidE164(a.callerId)) throw new Error('invalid_numbers');
  const whisper = a.whisper.replace(/[^\p{L}\p{N} .,'-]/gu, ' ').slice(0, 80).trim();
  return (
    `<Response>${whisper ? `<Say>${xml(whisper)}</Say>` : ''}` +
    `<Dial callerId="${xml(a.callerId)}" answerOnBridge="true" timeout="30">` +
    `<Number>${xml(a.customerE164)}</Number></Dial></Response>`
  );
}

export function mapTwilioError(message: string): { code: string; status: number; message: string } {
  const m = /Twilio (\d{3}): (.*)/s.exec(message);
  let twilioCode = 0;
  try { twilioCode = Number(JSON.parse(m?.[2] ?? '{}').code) || 0; } catch { /* truncated body */ }
  if ([21210, 21212, 21213, 21214, 21606, 21608].includes(twilioCode)) {
    return { code: 'caller_id_not_verified', status: 409, message: 'The business caller ID is not verified for calling. Check Phone Numbers in Vireek.' };
  }
  if ([21215, 21216, 21217, 21219, 21220].includes(twilioCode)) {
    return { code: 'destination_not_permitted', status: 403, message: 'Calling that destination is not enabled on your phone account.' };
  }
  if ([20003, 20404].includes(twilioCode) || m?.[1] === '401') {
    return { code: 'calling_not_configured', status: 503, message: 'Calling is not configured correctly for this account.' };
  }
  if (m?.[1] === '429') return { code: 'provider_busy', status: 503, message: 'The phone provider is busy. Try again in a moment.' };
  return { code: 'provider_error', status: 502, message: 'The call could not be placed. Please try again.' };
}

export function mapProviderStatus(s: string): string {
  const map: Record<string, string> = {
    queued: 'ringing', initiated: 'ringing', ringing: 'ringing', 'in-progress': 'answered',
    completed: 'completed', busy: 'busy', 'no-answer': 'no_answer', failed: 'failed', canceled: 'canceled',
  };
  return map[s] ?? 'ringing';
}

// ----------------------------------------------------------------- lead capture
export interface LeadInput {
  requestId: string; name: string; phone: string | null; email: string | null; company: string | null;
  service: string | null; note: string | null; pageUrl: string | null; pageTitle: string | null; pageHost: string | null;
}
type Obj = Record<string, unknown>;
const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/** Keeps origin + path only: query strings and fragments routinely carry tokens. */
export function safePageUrl(raw: unknown): { url: string; host: string } | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return { url: `${u.origin}${u.pathname}`.slice(0, 300), host: u.hostname.slice(0, 253) };
  } catch { return null; }
}

export function normalizeLeadInput(raw: unknown): { ok: true; value: LeadInput } | { ok: false; field: string; error: string } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Obj;
  if (!isValidRequestId(o.request_id)) return { ok: false, field: 'request_id', error: 'A valid request_id is required.' };
  const phoneRaw = clean(o.phone, 40);
  const phone = phoneRaw ? toE164(phoneRaw) : null;
  if (phoneRaw && !phone) return { ok: false, field: 'phone', error: 'That phone number is not valid.' };
  const emailRaw = clean(o.email, 254);
  const email = emailRaw && EMAIL.test(emailRaw) ? emailRaw.toLowerCase() : null;
  if (emailRaw && !email) return { ok: false, field: 'email', error: 'That email address is not valid.' };
  const company = clean(o.company, 120);
  const name = clean(o.name, 120) ?? company ?? (phone ? `Lead ${phone.slice(-4)}` : email ? email.split('@')[0].slice(0, 120) : null);
  if (!phone && !email && !clean(o.name, 120)) return { ok: false, field: 'name', error: 'Add a name, phone number or email.' };
  const page = safePageUrl(o.page_url);
  return {
    ok: true,
    value: {
      requestId: o.request_id as string, name: name as string, phone, email, company,
      service: clean(o.service, 200), note: clean(o.note, 2000),
      pageUrl: page?.url ?? null, pageTitle: clean(o.page_title, 200), pageHost: page?.host ?? null,
    },
  };
}

export function buildLeadNotes(l: LeadInput, agentName: string | null, isoNow: string): string {
  const lines: string[] = [];
  if (l.note) lines.push(l.note);
  if (l.company) lines.push(`Company: ${l.company}`);
  const src = [l.pageTitle, l.pageUrl].filter(Boolean).join(' - ');
  lines.push(`Captured with the Chrome extension${agentName ? ` by ${agentName}` : ''} on ${isoNow.slice(0, 10)}${src ? ` from: ${src}` : ''}`);
  return lines.join('\n').slice(0, 4000);
}

export function phoneVariants(e164: string): string[] {
  const set = new Set<string>([e164, e164.slice(1)]);
  if (e164.startsWith('+1') && e164.length === 12) {
    const d = e164.slice(2);
    const [a, b, c] = [d.slice(0, 3), d.slice(3, 6), d.slice(6)];
    [d, `(${a}) ${b}-${c}`, `${a}-${b}-${c}`, `${a}.${b}.${c}`, `${a} ${b} ${c}`, `1${d}`].forEach((v) => set.add(v));
  }
  return [...set];
}

/** PostgREST `or=` expression matching a lead by phone variants or case-insensitive email. */
export function leadMatchFilter(phone: string | null, email: string | null): string | null {
  const q = (v: string) => `"${v.replace(/["\\]/g, '')}"`;
  const parts: string[] = [];
  if (phone) for (const v of phoneVariants(phone)) parts.push(`phone.eq.${q(v)}`);
  if (email) parts.push(`email.ilike.${q(email.replace(/[%_*]/g, ''))}`);
  return parts.length ? parts.join(',') : null;
}

// ------------------------------------------------------------------- auth / MFA
export function jwtClaims(authHeader: string | null): Record<string, unknown> | null {
  const t = (authHeader ?? '').replace(/^Bearer\s+/i, '');
  const p = t.split('.')[1];
  if (!p) return null;
  try {
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(p.length / 4) * 4, '=');
    return JSON.parse(atob(b64));
  } catch { return null; }
}

/** MFA is satisfied unless the account has a verified factor and this session is only aal1. */
export function mfaState(claims: Record<string, unknown> | null, factors: unknown): { required: boolean; satisfied: boolean } {
  const verified = Array.isArray(factors) && factors.some((f) => (f as Obj)?.status === 'verified');
  return { required: verified, satisfied: !verified || claims?.aal === 'aal2' };
}
