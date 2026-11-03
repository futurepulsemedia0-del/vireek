// supabase/functions/_shared/consumer-agent/sanitize.ts
//
// Pure (no I/O) hardening for free text that arrives from an UNTRUSTED homeowner agent.
//
// Threat model: whatever an outside agent writes into a request field must be treated as data, never as
// instructions. It can later be shown to the owner, read by a human, or (worst case) summarised by an
// internal AI feature. This module (1) removes characters used to hide or smuggle text, (2) removes markup
// and links we have no reason to store, and (3) FLAGS instruction-like patterns. Flags never change what a
// request means; they only (a) are shown to the owner, and (b) permanently disable auto-accept for it.

export type RiskFlag =
  | "injection_pattern"
  | "had_url"
  | "had_markup"
  | "had_hidden_chars"
  | "truncated"
  | "payment_language";

export interface Sanitized {
  text: string;
  flags: RiskFlag[];
}

// C0/C1 controls (keep \n and \t out too: we collapse whitespace), bidi overrides/isolates, zero-width and
// invisible formatting characters, BOM, and the Unicode "tag" block (U+E0000-E007F) used for ASCII smuggling.
// deno-lint-ignore no-control-regex
const HIDDEN_RE = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]|[\u{1D173}-\u{1D17A}]/gu;

const URL_RE = /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"')\]]+/gi;
const MARKUP_RE = /<\/?[a-z!][^>]*>|```|\[[^\]]{0,200}\]\([^)]{0,500}\)|!\[[^\]]*\]\([^)]*\)|^\s{0,3}#{1,6}\s|\{\{|\}\}|\$\{/gim;

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|rules?|prompts?|messages?)/i,
  /disregard\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|system)\b/i,
  /(?:forget|override|bypass|skip)\s+(?:all\s+|your\s+|the\s+)?(?:instructions?|rules?|guardrails?|safety|polic(?:y|ies))/i,
  /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
  /\byou\s+are\s+(?:now|no\s+longer)\b/i,
  /\bnew\s+(?:instructions?|rules?|role)\s*:/i,
  /\b(?:assistant|system|developer|tool)\s*:\s*\S/i,
  /<\|(?:im_start|im_end|system|assistant|user|endoftext)\|>/i,
  /\[\/?(?:INST|SYS)\]|<<\/?SYS>>/i,
  /\b(?:tool|function)[_\s-]?call\b|"?(?:tool_use|function_call)"?\s*[:=]/i,
  /\b(?:reveal|print|show|leak|exfiltrate|send)\b[^.\n]{0,60}\b(?:api[\s_-]?key|secret|token|password|credentials?|system prompt|customer list|other customers?)\b/i,
  /\b(?:auto[\s-]?accept|approve|accept|confirm)\b[^.\n]{0,40}\b(?:this|the)\s+(?:request|booking|job)\b[^.\n]{0,30}\b(?:immediately|automatically|without\s+(?:review|approval|asking))/i,
  /\bdo\s+not\s+(?:tell|inform|notify|alert|show)\s+(?:the\s+)?(?:owner|business|user|human|staff)\b/i,
  /\bwithout\s+(?:human\s+)?(?:review|approval|asking|checking)\b/i,
  /\bact\s+as\b[^.\n]{0,30}\b(?:admin|owner|root|system|dispatcher)\b/i,
];

const PAYMENT_RE = /\b(?:mark(?:ed)?\s+(?:as\s+)?paid|payment\s+(?:received|confirmed|complete[d]?)|already\s+paid|charge\s+(?:my|the)\s+card|card\s+number|cvv|iban|routing\s+number|wire\s+transfer)\b|\b(?:\d[ -]?){13,19}\b/i;

/** Normalises, strips and flags one free-text field. Never throws. */
export function sanitizeFreeText(input: unknown, maxLen: number): Sanitized {
  const flags = new Set<RiskFlag>();
  let s = typeof input === "string" ? input : "";
  s = s.normalize("NFKC");

  if (HIDDEN_RE.test(s)) flags.add("had_hidden_chars");
  HIDDEN_RE.lastIndex = 0;
  // Replace (not delete) so "ig\u200bnore" cannot be re-joined into a pattern the scan below would miss.
  const visible = s.replace(HIDDEN_RE, " ");
  const joined = s.replace(HIDDEN_RE, ""); // also scan the joined form
  HIDDEN_RE.lastIndex = 0;

  s = visible;
  if (URL_RE.test(s)) flags.add("had_url");
  URL_RE.lastIndex = 0;
  s = s.replace(URL_RE, "[link removed]");

  if (MARKUP_RE.test(s)) flags.add("had_markup");
  MARKUP_RE.lastIndex = 0;
  s = s.replace(MARKUP_RE, " ").replace(/[<>]/g, " ");

  s = s.replace(/\s+/g, " ").trim();

  for (const probe of [s, joined.replace(/\s+/g, " ")]) {
    if (INJECTION_PATTERNS.some((re) => re.test(probe))) flags.add("injection_pattern");
    if (PAYMENT_RE.test(probe)) flags.add("payment_language");
  }

  if (s.length > maxLen) {
    s = s.slice(0, maxLen).trimEnd();
    flags.add("truncated");
  }
  return { text: s, flags: [...flags] };
}

/** Short single-line identifiers (names, service labels): same hardening, no markup allowed at all. */
export function sanitizeLabel(input: unknown, maxLen: number): Sanitized {
  const r = sanitizeFreeText(input, maxLen);
  return { text: r.text.replace(/[\[\]{}|\\`]/g, "").trim(), flags: r.flags };
}

export function mergeFlags(...lists: RiskFlag[][]): RiskFlag[] {
  return [...new Set(lists.flat())];
}

/** Flags that must keep a request in the human review queue no matter what auto-accept rules say. */
export const BLOCKS_AUTO_ACCEPT: ReadonlySet<RiskFlag> = new Set<RiskFlag>([
  "injection_pattern", "had_url", "had_markup", "had_hidden_chars", "payment_language",
]);

export const blocksAutoAccept = (flags: readonly RiskFlag[]): boolean => flags.some((f) => BLOCKS_AUTO_ACCEPT.has(f));

// ---- contact normalisation (PII minimisation: only what the owner needs to call back) ----

export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const plus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return (plus ? "+" : "") + digits;
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) && !e.includes("..") ? e : null;
}

export const POSTAL_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{1,8}[A-Za-z0-9]$/;
