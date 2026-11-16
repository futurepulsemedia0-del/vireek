// src/lib/sentryScrub.ts
// Pure PII scrubber for browser Sentry events (phone numbers, emails, card numbers, transcripts, tokens).
// Mirrors the intent of supabase/functions/_shared/observability/redact.ts (which only covers the edge runtime).
// Deny-by-default for known sensitive KEYS; pattern-scrub for free-text values.

const DROP_KEY = /^(transcript|transcripts|summary|utterance|prompt|recordingurl|audiourl|address|street|callername|customername|firstname|lastname|email|phone|phonenumber|callerphone|customernumber|ssn|dob|password|secret|token|authorization|apikey|cookie|cardnumber|cvv|cvc|body|notes|message)$/i;
const DROP_SUFFIX = /(token|secret|password|apikey|authorization|transcript|phone|email)$/i;

const luhn = (d: string): boolean => {
  let sum = 0, dbl = false;
  for (let i = d.length - 1; i >= 0; i--) { let n = d.charCodeAt(i) - 48; if (dbl) { n *= 2; if (n > 9) n -= 9; } sum += n; dbl = !dbl; }
  return sum % 10 === 0;
};

export function scrubText(input: string, max = 500): string {
  let s = String(input);
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[jwt]');
  s = s.replace(/\b(?:sk|pk|rk|whsec)_(?:live|test)?_?[A-Za-z0-9]{8,}\b/g, '[key]');
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  s = s.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d) ? '[card]' : m; });
  s = s.replace(/(?:\+|\b)\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3}[\s.-]?\d{3,4}\b/g, '[phone]');
  s = s.replace(/([?&](?:token|key|signature|sig|code|access_token)=)[^&\s]+/gi, '$1[redacted]');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function scrubValue(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return scrubText(v);
  if (v === null || typeof v !== 'object') return v;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrubValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 60)) {
    out[k] = DROP_KEY.test(k) || DROP_SUFFIX.test(k) ? '[redacted]' : scrubValue(val, depth + 1);
  }
  return out;
}

/** Use as Sentry `beforeSend` / `beforeSendTransaction`. Never throws; on any error the event is dropped (fail closed). */
export function scrubSentryEvent<T extends Record<string, any>>(event: T): T | null {
  try {
    const e: Record<string, any> = { ...event };
    if (e.request) {
      const { url, method } = e.request;
      e.request = { url: typeof url === 'string' ? scrubText(url.split('#')[0], 300) : undefined, method };
    }
    if (e.user) e.user = e.user.id ? { id: e.user.id } : undefined;
    if (typeof e.message === 'string') e.message = scrubText(e.message);
    if (e.exception?.values) e.exception = { ...e.exception, values: e.exception.values.map((x: any) => ({ ...x, value: typeof x.value === 'string' ? scrubText(x.value) : x.value })) };
    if (e.breadcrumbs) e.breadcrumbs = (Array.isArray(e.breadcrumbs) ? e.breadcrumbs : e.breadcrumbs.values ?? []).map((b: any) => ({ ...b, message: typeof b.message === 'string' ? scrubText(b.message) : b.message, data: b.data ? scrubValue(b.data) : b.data }));
    if (e.extra) e.extra = scrubValue(e.extra);
    if (e.contexts) e.contexts = scrubValue(e.contexts);
    if (e.tags) e.tags = scrubValue(e.tags);
    return e as T;
  } catch {
    return null;
  }
}

export function scrubBreadcrumb<T extends Record<string, any>>(b: T): T | null {
  if (b.category === 'console') return null; // console output may contain anything
  return { ...b, message: typeof b.message === 'string' ? scrubText(b.message) : b.message, data: b.data ? scrubValue(b.data) : b.data };
}
