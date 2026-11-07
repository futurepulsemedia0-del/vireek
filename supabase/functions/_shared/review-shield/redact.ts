// supabase/functions/_shared/review-shield/redact.ts
//
// PII redaction for anything that leaves the tenant boundary (evidence pack, exports shared
// with a platform). Pattern-based redaction is best-effort: the pack builder ALSO passes
// the known customer names/phones/emails from the matched ledger so they are removed by value.
// The UI must tell the owner to read the pack before sending it.

export interface RedactOptions {
  /** Exact strings to remove wherever they appear (customer names, phones, emails, addresses). */
  knownValues?: string[];
  /** Keep e-mail addresses / phone numbers (used only for the owner-only full export for authorities). */
  keepContactDetails?: boolean;
}

export interface RedactResult {
  text: string;
  counts: { email: number; phone: number; address: number; url: number; number: number; known: number };
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// 7+ digits with optional separators / country code; deliberately greedy — over-redaction is the safe failure.
const PHONE = /(?<![\w])(?:\+?\d[\d\s().-]{6,}\d)(?![\w])/g;
const STREET = /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s){1,4}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|way|pl|place|pkwy|parkway|cir|circle|ter|terrace)\b\.?/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;
const LONG_NUMBER = /\b\d{9,}\b/g; // card / account / SSN-like runs without separators

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function redactText(input: string | null | undefined, opts: RedactOptions = {}): RedactResult {
  let text = String(input ?? "");
  const counts: RedactResult["counts"] = { email: 0, phone: 0, address: 0, url: 0, number: 0, known: 0 };
  const sub = (re: RegExp, label: string, key: keyof RedactResult["counts"]) => {
    text = text.replace(re, () => {
      counts[key]++;
      return label;
    });
  };

  // Known values first (longest first so "John Smith" goes before "John").
  const known = [...new Set((opts.knownValues ?? []).map((v) => v.trim()).filter((v) => v.length >= 3))].sort((a, b) => b.length - a.length);
  for (const v of known) sub(new RegExp(escapeRe(v), "gi"), "[redacted]", "known");

  sub(URL_RE, "[link]", "url");
  if (!opts.keepContactDetails) {
    sub(EMAIL, "[email]", "email");
    sub(STREET, "[address]", "address");
    sub(PHONE, "[phone]", "phone");
    sub(LONG_NUMBER, "[number]", "number");
  }
  return { text, counts };
}

export function totalRedactions(c: RedactResult["counts"]): number {
  return c.email + c.phone + c.address + c.url + c.number + c.known;
}
