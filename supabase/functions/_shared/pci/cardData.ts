// supabase/functions/_shared/pci/cardData.ts
//
// Card-data detection + redaction. Pure TypeScript: no Deno/Node APIs, so the
// same module runs in edge functions and in vitest.
//
// This is a SAFETY NET, not the primary control. The primary control is
// structural: card digits are keyed on the phone keypad into Twilio <Pay>,
// tokenized by the payment provider, and never reach Vireek's AI, STT,
// transcripts, logs or database. This module makes sure that if card data
// ever shows up anyway (a caller reads the number aloud, a provider payload
// changes, a developer logs a raw body) it is removed before it is stored,
// and that the incident is visible.
//
// Findings NEVER carry the matched digits — only kind, offsets and length.

export type CardFindingKind = "pan" | "cvv" | "expiry";

export interface CardFinding {
  kind: CardFindingKind;
  start: number;
  end: number;
  /** Number of digits matched (never the digits themselves). */
  digits: number;
}

export interface DetectOptions {
  /**
   * strict = also treat Luhn-INVALID 13-19 digit runs as card numbers. Use for
   * transcripts and logs (speech-to-text mishears digits, so a real card number
   * often fails Luhn). Non-strict = Luhn-valid only, for places where a false
   * positive would corrupt legitimate data.
   */
  strict?: boolean;
}

export const REDACTED_PAN = "[REDACTED-CARD]";
export const REDACTED_CVV = "[REDACTED-CVV]";
export const REDACTED_EXPIRY = "[REDACTED-EXPIRY]";
export const REDACTED_VALUE = "[REDACTED]";

const MIN_PAN = 13;
const MAX_PAN = 19;

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// Spoken digits ("four one one one", "double four", "oh")
// ---------------------------------------------------------------------------

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", one: "1", two: "2", to: "2", too: "2", three: "3", four: "4", for: "4",
  five: "5", six: "6", seven: "7", eight: "8", ate: "8", nine: "9",
};
// Ambiguous homophones only count as digits when they are INSIDE a run of
// unambiguous digit tokens (so "I want to pay for it" is never touched).
const AMBIGUOUS = new Set(["o", "oh", "to", "too", "for", "ate"]);
const MULTIPLIERS: Record<string, number> = { double: 2, triple: 3 };

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  const re = /[A-Za-z]+|\d+|[^\sA-Za-z\d]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

interface DigitSpan {
  start: number;
  end: number;
  digits: string;
}

/** Finds maximal runs of spoken/numeric digit tokens, e.g. "four one one one 1111 double one". */
function findDigitRuns(input: string): DigitSpan[] {
  const tokens = tokenize(input);
  const runs: DigitSpan[] = [];
  let i = 0;
  while (i < tokens.length) {
    let j = i;
    let digits = "";
    let firm = 0; // count of unambiguous digit tokens
    let lastEnd = -1;
    let firstStart = -1;
    while (j < tokens.length) {
      const t = tokens[j];
      const lower = t.text.toLowerCase();
      let piece: string | null = null;
      let consumed = 1;
      if (/^\d+$/.test(t.text)) {
        piece = t.text;
        firm++;
      } else if (lower in MULTIPLIERS && j + 1 < tokens.length) {
        const next = DIGIT_WORDS[tokens[j + 1].text.toLowerCase()];
        if (next !== undefined) {
          piece = next.repeat(MULTIPLIERS[lower]);
          consumed = 2;
          firm++;
        }
      } else if (lower in DIGIT_WORDS) {
        piece = DIGIT_WORDS[lower];
        if (!AMBIGUOUS.has(lower)) firm++;
      } else if (/^[-.\u2013]+$/.test(t.text) && digits.length > 0) {
        // separator inside a run; only keep going if a digit token follows
        const nxt = tokens[j + 1];
        if (nxt && (/^\d+$/.test(nxt.text) || nxt.text.toLowerCase() in DIGIT_WORDS)) {
          j++;
          continue;
        }
        break;
      }
      if (piece === null) break;
      if (firstStart < 0) firstStart = t.start;
      digits += piece;
      lastEnd = tokens[j + consumed - 1].end;
      j += consumed;
    }
    if (digits.length > 0 && firm > 0) {
      runs.push({ start: firstStart, end: lastEnd, digits });
      i = Math.max(j, i + 1);
    } else {
      i++;
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const CVV_RE =
  /\b(?:cvv2?|cvc2?|cid|csc|security\s*code|verification\s*(?:code|number)|card\s*code)\b[^\d\n]{0,24}((?:\d[\s-]?){3,4})(?!\d)/gi;
const CVV_SPOKEN_RE =
  /\b(?:cvv2?|cvc2?|cid|csc|security\s*code|verification\s*(?:code|number)|card\s*code)\b/gi;
const EXPIRY_RE =
  /\b(?:exp(?:ir(?:y|ation|es))?(?:\s*date)?|valid\s*(?:thru|through|until))\b[^\d\n]{0,16}((?:0?[1-9]|1[0-2])\s*[\/\-.\s]\s*(?:\d{4}|\d{2}))(?!\d)/gi;

function pushUnique(findings: CardFinding[], f: CardFinding): void {
  for (const e of findings) if (f.start < e.end && f.end > e.start) return; // overlaps an earlier finding
  findings.push(f);
}

export function findCardData(input: string, opts: DetectOptions = {}): CardFinding[] {
  if (typeof input !== "string" || input.length < 3) return [];
  const strict = opts.strict === true;
  const findings: CardFinding[] = [];

  // 1) PANs: numeric runs with optional single space/dash/dot separators, and spoken-digit runs.
  for (const run of findDigitRuns(input)) {
    const n = run.digits.length;
    if (n < MIN_PAN || n > MAX_PAN) {
      // A long run that is two cards back to back (or a card + extra digits) — check every 13-19 window.
      if (n > MAX_PAN && (hasLuhnWindow(run.digits) || (strict && plausibleIin(run.digits)))) {
        pushUnique(findings, { kind: "pan", start: run.start, end: run.end, digits: n });
      }
      continue;
    }
    if (plausibleIin(run.digits) && (luhnValid(run.digits) || strict)) {
      pushUnique(findings, { kind: "pan", start: run.start, end: run.end, digits: n });
    }
  }

  // 2) CVV / security code (numeric) and spoken
  for (const m of input.matchAll(CVV_RE)) {
    const whole = m[0];
    const grp = m[1];
    const startOfDigits = (m.index ?? 0) + whole.length - grp.length;
    pushUnique(findings, { kind: "cvv", start: startOfDigits, end: startOfDigits + grp.length, digits: grp.replace(/\D/g, "").length });
  }
  for (const m of input.matchAll(CVV_SPOKEN_RE)) {
    const after = (m.index ?? 0) + m[0].length;
    const rest = input.slice(after, after + 80);
    const lead = rest.match(/^[^A-Za-z\d]*(?:is|was|are|:)?[^A-Za-z\d]*/i)?.[0].length ?? 0;
    for (const run of findDigitRuns(rest.slice(lead))) {
      if (run.start !== 0) break;
      if (run.digits.length >= 3 && run.digits.length <= 4) {
        pushUnique(findings, { kind: "cvv", start: after + lead + run.start, end: after + lead + run.end, digits: run.digits.length });
      }
      break;
    }
  }

  // 3) Expiry next to an "exp"/"valid thru" keyword
  for (const m of input.matchAll(EXPIRY_RE)) {
    const whole = m[0];
    const grp = m[1];
    const s = (m.index ?? 0) + whole.length - grp.length;
    pushUnique(findings, { kind: "expiry", start: s, end: s + grp.length, digits: grp.replace(/\D/g, "").length });
  }

  return findings.sort((a, b) => a.start - b.start);
}

/**
 * Real card numbers start with 2-6 (Mastercard 2-series 2221-2720, Amex/JCB/Diners 3, Visa 4, Mastercard 5,
 * Discover/UnionPay 6). Requiring this keeps epoch-millisecond timestamps, order numbers etc. out of the net.
 */
function plausibleIin(digits: string): boolean {
  const c = digits.charCodeAt(0) - 48;
  if (c < 2 || c > 6) return false;
  if (c === 2) {
    const p2 = Number(digits.slice(0, 2));
    return p2 >= 22 && p2 <= 27;
  }
  return true;
}

function hasLuhnWindow(digits: string): boolean {
  for (let len = MIN_PAN; len <= MAX_PAN; len++) {
    for (let s = 0; s + len <= digits.length; s++) {
      const w = digits.slice(s, s + len);
      if (plausibleIin(w) && luhnValid(w)) return true;
    }
  }
  return false;
}

export function containsCardData(input: string, opts: DetectOptions = {}): boolean {
  return findCardData(input, opts).length > 0;
}

export interface RedactResult {
  text: string;
  findings: CardFinding[];
}

const MARKER: Record<CardFindingKind, string> = { pan: REDACTED_PAN, cvv: REDACTED_CVV, expiry: REDACTED_EXPIRY };

export function redactCardData(input: string, opts: DetectOptions = {}): RedactResult {
  const findings = findCardData(input, opts);
  if (findings.length === 0) return { text: input, findings };
  let out = "";
  let cursor = 0;
  for (const f of findings) {
    out += input.slice(cursor, f.start) + MARKER[f.kind];
    cursor = f.end;
  }
  out += input.slice(cursor);
  return { text: out, findings };
}

// ---------------------------------------------------------------------------
// Deep redaction for objects (log lines, webhook payloads, audit metadata)
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_RE =
  /^(?:card[_-]?(?:number|num|no|data|details)|pan|primary[_-]?account[_-]?number|cvv2?|cvc2?|csc|cid|security[_-]?code|expir(?:y|ation)(?:[_-]?(?:date|month|year))?|exp[_-]?(?:month|year|date)|payment[_-]?card[_-]?number|expiration[_-]?date|bank[_-]?account[_-]?number|routing[_-]?number)$/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

export interface DeepRedactOptions extends DetectOptions {
  maxDepth?: number;
}

export function deepRedact<T>(value: T, opts: DeepRedactOptions = {}): T {
  const maxDepth = opts.maxDepth ?? 8;
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return redactCardData(v, { strict: opts.strict ?? true }).text;
    if (v === null || typeof v !== "object") return v;
    if (depth >= maxDepth) return REDACTED_VALUE;
    if (seen.has(v as object)) return "[Circular]";
    seen.add(v as object);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v instanceof Error) return { name: v.name, message: redactCardData(v.message, { strict: true }).text };
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED_VALUE : walk(val, depth + 1);
    }
    return out;
  };
  return walk(value, 0) as T;
}

// ---------------------------------------------------------------------------
// Fail-closed guard
// ---------------------------------------------------------------------------

export class CardDataLeakError extends Error {
  readonly label: string;
  readonly kinds: CardFindingKind[];
  constructor(label: string, kinds: CardFindingKind[]) {
    // The message never includes the data itself.
    super(`Card data detected in ${label} (${kinds.join(", ")}). Write blocked.`);
    this.name = "CardDataLeakError";
    this.label = label;
    this.kinds = kinds;
  }
}

function collectStrings(value: unknown, out: string[], depth = 0, seen = new WeakSet<object>()): void {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" || typeof value === "bigint") out.push(String(value));
  else if (value && typeof value === "object" && depth < 10 && !seen.has(value as object)) {
    seen.add(value as object);
    if (Array.isArray(value)) value.forEach((x) => collectStrings(x, out, depth + 1, seen));
    else for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      collectStrings(v, out, depth + 1, seen);
    }
  }
}

/** Throws (without echoing the data) if any string/number/key inside `value` looks like card data. */
export function assertNoCardData(value: unknown, label: string): void {
  const strings: string[] = [];
  collectStrings(value, strings);
  const kinds = new Set<CardFindingKind>();
  for (const s of strings) for (const f of findCardData(s, { strict: true })) kinds.add(f.kind);
  if (kinds.size > 0) throw new CardDataLeakError(label, [...kinds]);
}

/** Display-safe card label from provider-masked data: "visa •••• 1111". */
export function maskedCardLabel(brand: string | null | undefined, last4: string | null | undefined): string {
  const b = (brand ?? "card").toString().slice(0, 20).replace(/[^A-Za-z _-]/g, "") || "card";
  const l = typeof last4 === "string" && /^\d{4}$/.test(last4) ? last4 : "????";
  return `${b} •••• ${l}`;
}
