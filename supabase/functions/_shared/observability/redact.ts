// supabase/functions/_shared/observability/redact.ts
//
// PII scrubbing for everything that leaves the database/edge runtime as telemetry
// (logs, spans, stored timeline attributes). Deny-by-default for free text:
// transcripts, summaries, names, addresses and URLs with credentials never pass.
// Pure; no I/O.

const REDACTED = "[redacted]";
const MAX_STRING = 200;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;
const MAX_KEYS = 60;

/** Keys whose VALUE is dropped entirely (matched on lowercase alphanumerics). */
const DROP_KEYS = new Set([
  "transcript", "transcripts", "text", "content", "message", "messages", "summary", "utterance", "prompt", "completion",
  "recordingurl", "stereorecordingurl", "audio", "audiourl", "address", "street", "callername", "customername", "name",
  "firstname", "lastname", "email", "phone", "phonenumber", "callerphone", "customernumber", "number", "ssn", "dob",
  "password", "secret", "token", "authorization", "apikey", "cookie", "cardnumber", "cvv", "cvc", "pan", "notes", "body",
]);
const DROP_SUFFIX = ["token", "secret", "password", "apikey", "authorization", "transcript", "phone", "email"];

function normKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  const k = normKey(key);
  return DROP_KEYS.has(k) || DROP_SUFFIX.some((s) => k.endsWith(s));
}

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Scrub PII/secrets out of a free-form string. Order matters: secrets, URLs, cards, SSN, email, phone. */
export function scrubString(input: string, max = MAX_STRING): string {
  let s = String(input);
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
  s = s.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[jwt]");
  s = s.replace(/\b(?:sk|pk|rk|whsec)_(?:live|test)?_?[A-Za-z0-9]{8,}\b/g, "[key]");
  // Signed URLs: keep origin + path, drop query/fragment (signatures live there) and userinfo.
  s = s.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}${u.pathname}${u.search || u.hash ? "?[redacted]" : ""}`;
    } catch { return "[url]"; }
  });
  s = s.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
    const d = m.replace(/\D/g, "");
    return d.length >= 13 && d.length <= 19 && luhn(d) ? "[card]" : m;
  });
  s = s.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]");
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  s = s.replace(/(?<![\w.])\+?\d[\d\s().-]{6,}\d(?![\w])/g, (m) => {
    const d = m.replace(/\D/g, "");
    return d.length >= 7 && d.length <= 15 ? "[phone]" : m;
  });
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export type Scrubbed = string | number | boolean | null | Scrubbed[] | { [k: string]: Scrubbed };

/** Deep scrub of an arbitrary value. Never throws, bounded in depth/size, drops sensitive keys. */
export function scrubValue(value: unknown, depth = 0): Scrubbed {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number(value);
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => scrubValue(v, depth + 1));
  if (typeof value === "object") {
    const out: { [k: string]: Scrubbed } = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= MAX_KEYS) break;
      out[k] = isSensitiveKey(k) ? REDACTED : scrubValue(v, depth + 1);
    }
    return out;
  }
  return null;
}

export type AttrValue = string | number | boolean;

/** Flatten to scalar telemetry attributes (OTLP-safe). Objects are dotted; arrays become their length. */
export function toSafeAttributes(record: Record<string, unknown>, prefix = ""): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  const walk = (v: unknown, key: string, depth: number) => {
    if (Object.keys(out).length >= MAX_KEYS) return;
    if (isSensitiveKey(key.split(".").pop() ?? key)) { out[key] = REDACTED; return; }
    if (v === null || v === undefined) return;
    if (typeof v === "string") out[key] = scrubString(v);
    else if (typeof v === "number") { if (Number.isFinite(v)) out[key] = v; }
    else if (typeof v === "boolean") out[key] = v;
    else if (Array.isArray(v)) out[`${key}.count`] = v.length;
    else if (typeof v === "object" && depth < 3) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${key}.${k}`, depth + 1);
    }
  };
  for (const [k, v] of Object.entries(record)) walk(v, prefix ? `${prefix}.${k}` : k, 0);
  return out;
}
