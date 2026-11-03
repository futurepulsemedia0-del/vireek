// supabase/functions/_shared/voice/callSafety.ts
//
// Pure, dependency-free safety + parsing helpers for "Call your Vireek" (no Deno / npm imports, so Vitest runs it).
//
// Trust model (see VOICE_RUNBOOK.md):
//   level 0  nobody verified          -> nothing is read, call ends
//   level 1  caller-ID match + PIN    -> counts, schedule, on-call. Money is masked, customer names shortened.
//   level 2  + one-time SMS code      -> dollar figures, full names, and the "send a text" action.
// Caller ID is spoofable, so it is never trusted alone. Speech never carries secrets: PIN and SMS code are DTMF only.

export type AuthLevel = 0 | 1 | 2;

export const PIN_LENGTH = 6;
export const MAX_PIN_ATTEMPTS = 3;
export const LOCK_MINUTES = 30;
export const OTP_TTL_MINUTES = 10;
export const STEP_UP_TTL_MINUTES = 15;
export const MAX_UTTERANCE_CHARS = 400;
export const MAX_SMS_CHARS = 320;
export const NO_DATA = "I don't have data on that.";

// ------------------------------------------------------------------ crypto
const enc = new TextEncoder();
const toHex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

export async function sha256Hex(s: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

export function newSaltHex(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function hashSecret(secret: string, saltHex: string, iterations = 150_000): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations }, key, 256);
  return toHex(new Uint8Array(bits));
}

/** Same as constantTimeEqual; named for header/secret checks (length difference short-circuits, lengths are not secret). */
export function constantTimeEqualSafe(a: string, b: string): boolean {
  return constantTimeEqual(a, b);
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifySecret(secret: string, saltHex: string, expectedHex: string, iterations = 150_000): Promise<boolean> {
  return constantTimeEqual(await hashSecret(secret, saltHex, iterations), expectedHex);
}

/** Uniform random 6-digit code (rejection sampling: no modulo bias). */
export function generateOtp(len = 6): string {
  let out = "";
  const buf = new Uint8Array(1);
  while (out.length < len) {
    crypto.getRandomValues(buf);
    if (buf[0] < 250) out += String(buf[0] % 10);
  }
  return out;
}

export function isValidPinFormat(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

/** Rejects 000000, 111111, 123456, 654321, 121212 and the last digits of the caller's own number. */
export function isWeakPin(pin: string, phoneE164?: string | null): boolean {
  if (!isValidPinFormat(pin)) return true;
  if (/^(\d)\1+$/.test(pin)) return true;
  const d = pin.split("").map(Number);
  const steps = d.slice(1).map((x, i) => x - d[i]);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return true;
  if (/^(\d\d)\1+$/.test(pin) || /^(\d\d\d)\1$/.test(pin)) return true;
  if (phoneE164 && phoneE164.replace(/\D/g, "").endsWith(pin)) return true;
  return false;
}

// ------------------------------------------------------------------ lockout
export interface LockInfo { locked: boolean; retryAfterMs: number }
export function lockState(lockedUntilIso: string | null | undefined, nowMs: number): LockInfo {
  const until = lockedUntilIso ? Date.parse(lockedUntilIso) : 0;
  return until > nowMs ? { locked: true, retryAfterMs: until - nowMs } : { locked: false, retryAfterMs: 0 };
}
/** After a failed PIN: new counter + lock timestamp (null while attempts remain). */
export function afterFailedPin(failedBefore: number, nowMs: number): { failed: number; lockedUntil: string | null } {
  const failed = failedBefore + 1;
  return failed >= MAX_PIN_ATTEMPTS
    ? { failed: 0, lockedUntil: new Date(nowMs + LOCK_MINUTES * 60_000).toISOString() }
    : { failed, lockedUntil: null };
}

// ------------------------------------------------------------------ phone numbers
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return /^\+[1-9]\d{7,14}$/.test(`+${digits}`) ? `+${digits}` : null;
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1") && /^[2-9]/.test(digits[1])) return `+${digits}`;
  return null;
}
export function maskPhone(e164: string): string {
  const d = e164.replace(/\D/g, "");
  return d.length < 6 ? "•••" : `+${d.slice(0, d.length > 10 ? d.length - 10 : 1)}•••••${d.slice(-4)}`;
}

// ------------------------------------------------------------------ text hygiene
/** Escape for TwiML <Say>/<Play> text. Customer-written strings must never become markup. */
export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c] as string));
}
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
export function cleanText(s: string, max = MAX_UTTERANCE_CHARS): string {
  return s.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
/** What goes in the audit log: long digit runs, emails and card-like numbers are masked. Never log PINs or codes. */
export function redactForLog(s: string): string {
  return cleanText(s, 1000)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\d[\d\s().-]{6,}\d/g, (m) => `${"•".repeat(Math.max(0, m.replace(/\D/g, "").length - 2))}${m.replace(/\D/g, "").slice(-2)}`);
}

const MONEY = /(?:(?:USD|US\$|\$)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|K|m|M|thousand|million)\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars?|bucks|USD)\b)/g;
export const MASKED_MONEY = "an amount I can read after you verify";
/** Defence in depth: at level < 2 no dollar figure may be spoken, whatever produced the sentence. */
export function maskFinancials(text: string): string {
  return text.replace(MONEY, MASKED_MONEY);
}
export function containsMoney(text: string): boolean {
  return new RegExp(MONEY.source).test(text);
}
/** "Jordan Smith" -> "Jordan S." ; one word is kept ; emails/phones are never spoken at level 1. */
export function shortName(name: string | null | undefined): string {
  const parts = cleanText(name ?? "", 80).split(" ").filter(Boolean);
  if (parts.length === 0) return "a customer";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}
export function lastFour(phone: string | null | undefined): string {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 4 ? `ending ${d.slice(-4).split("").join(" ")}` : "on file";
}

// ------------------------------------------------------------------ prompt-injection screen
const INJECTION: RegExp[] = [
  /\bignore\b.{0,30}\b(previous|prior|above|earlier|all)\b.{0,30}\b(instruction|rule|prompt|polic)/i,
  /\b(disregard|forget|override|bypass)\b.{0,30}\b(instruction|rule|polic|safeguard|verification|pin|security)/i,
  /\b(system|developer|hidden)\s+(prompt|message|instruction)/i,
  /\byou are now\b|\bpretend (to be|you)\b|\bact as\b|\bjailbreak\b|\bdeveloper mode\b|\bdan mode\b/i,
  /\b(reveal|read out|tell me|say)\b.{0,25}\b(pin|passcode|verification code|otp|password|api key|secret|token)\b/i,
  /\b(skip|without|no need for)\b.{0,20}\b(confirm|confirmation|verification|verify|code)\b/i,
  /\bas (the )?(admin|administrator|owner|developer|vireek staff)\b.{0,20}\b(i|you)\b.{0,20}\b(authorize|allow|permit|command)/i,
];
export function screenUtterance(raw: string): { ok: true; text: string } | { ok: false; reason: "injection" | "empty" | "too_long" } {
  if (raw.length > MAX_UTTERANCE_CHARS * 3) return { ok: false, reason: "too_long" };
  const text = cleanText(raw);
  if (!text) return { ok: false, reason: "empty" };
  if (INJECTION.some((rx) => rx.test(text))) return { ok: false, reason: "injection" };
  return { ok: true, text };
}

// ------------------------------------------------------------------ intents (deterministic: the LLM never picks actions)
export type Intent =
  | "yesterday" | "missed_emergencies" | "on_call" | "schedule" | "brief" | "send_text" | "verify"
  | "repeat" | "goodbye" | "help" | "ask_brain";

export interface ParsedIntent { intent: Intent; customerQuery?: string; messageBody?: string }

const rx = {
  yesterday: /\b(how did we do|how('?s| is| was) (it|business|yesterday)|yesterday('?s)?( results| numbers| summary)?|how (was|were) (we|things))\b/i,
  emergencies: /\b(missed|any|unanswered|unhandled)\b.{0,25}\bemergenc/i,
  emergencies3: /\bmiss(ed)?\b.{0,20}\bemergenc/i,
  emergencies2: /\bemergenc\w*\b.{0,25}\b(missed|miss|unanswered|unhandled|last night|overnight)/i,
  onCall: /\bwho('?s| is)?\b.{0,12}\bon[- ]?call\b|\bon[- ]?call\b.{0,12}\b(today|tonight|now|who)\b/i,
  schedule: /\b(read|tell|give)\b.{0,15}\b(today'?s |my |the )?(schedule|jobs|appointments|calendar)\b|\b(today'?s|my) (schedule|jobs|appointments)\b|\bwhat('?s| is) (on )?(the |my )?(schedule|calendar)\b/i,
  brief: /\b(morning )?(brief|briefing|summary)\b/i,
  verify: /^(please )?(verify|verification|send( me)? (a )?code|text me (a )?code|step[- ]?up)\b/i,
  repeat: /^(repeat|say (that )?again|come again|pardon|what was that)\b/i,
  goodbye: /^(bye|goodbye|that'?s all|that is all|i'?m done|hang up|thanks?,? (bye|that'?s all))\b/i,
  help: /^(help|what can (you|i) (do|ask)|options)\b/i,
  textDirect: /^(?:please\s+)?text\s+(?!to\b)(.+)/i,
  sendText: /\b(?:send|text|message|sms)\b(?:\s+(?:a|an))?\s*(?:text|message|sms)?\s*(?:to)\s+(.+)/i,
};

export function classifyIntent(utterance: string): ParsedIntent {
  const u = cleanText(utterance);
  if (rx.goodbye.test(u)) return { intent: "goodbye" };
  if (rx.repeat.test(u)) return { intent: "repeat" };
  if (rx.help.test(u)) return { intent: "help" };
  if (rx.verify.test(u)) return { intent: "verify" };
  const st = rx.sendText.exec(u) ?? rx.textDirect.exec(u);
  if (st) {
    const rest = st[1].trim();
    // "Jordan Smith saying we're running late" | "Jordan Smith: ..." | "Jordan Smith that we'll arrive at 3"
    const m = /^(.{2,60}?)(?:\s*[:,]\s+|\s+(?:saying|says|say|that|and tell (?:him|her|them)|telling (?:him|her|them))\s+)(.{3,})$/i.exec(rest);
    const name = (m ? m[1] : rest).replace(/[.?!]+$/, "").trim();
    return { intent: "send_text", customerQuery: name, messageBody: m ? m[2].trim() : undefined };
  }
  if (rx.emergencies.test(u) || rx.emergencies2.test(u) || rx.emergencies3.test(u)) return { intent: "missed_emergencies" };
  if (rx.onCall.test(u)) return { intent: "on_call" };
  if (rx.schedule.test(u)) return { intent: "schedule" };
  if (rx.yesterday.test(u)) return { intent: "yesterday" };
  if (rx.brief.test(u)) return { intent: "brief" };
  return { intent: "ask_brain" };
}

/** Strict: a confirmation must be short and unambiguous. Anything else is "unclear" and NEVER counts as yes. */
export function parseConfirmation(utterance: string, digits?: string): "yes" | "no" | "unclear" {
  if (digits === "1") return "yes";
  if (digits === "2") return "no";
  const u = cleanText(utterance, 80).toLowerCase().replace(/[.,!?]/g, "");
  if (!u || u.split(" ").length > 4) return "unclear";
  const yes = /^(yes|yeah|yep|yup|confirm|confirmed|correct|send it|do it|go ahead|affirmative)( please)?$/.test(u);
  const no = /^(no|nope|nah|cancel|stop|don'?t|do not|never ?mind|negative|wait)( please)?$/.test(u);
  return yes && !no ? "yes" : no && !yes ? "no" : "unclear";
}

// ------------------------------------------------------------------ permissions per intent / topic
/** Brain topics that contain money or customer PII. */
const L2_TOPICS = new Set(["profit_drivers", "money_leaks", "hiring_whatif", "capacity_whatif", "customer_outreach", "recommendations", "overview"]);
export function requiredLevelForTopics(topics: readonly string[]): AuthLevel {
  return topics.some((t) => L2_TOPICS.has(t)) ? 2 : 1;
}
export function requiredLevelForIntent(intent: Intent, topics: readonly string[] = []): AuthLevel {
  switch (intent) {
    case "send_text": return 2;                       // writes + customer PII
    case "ask_brain": return requiredLevelForTopics(topics);
    case "verify": case "help": case "goodbye": case "repeat": return 1;
    default: return 1;                                // yesterday/schedule/on_call/brief/missed_emergencies: counts only at L1
  }
}
export function stepUpStillValid(stepUpAtIso: string | null | undefined, nowMs: number): boolean {
  const t = stepUpAtIso ? Date.parse(stepUpAtIso) : 0;
  return t > 0 && nowMs - t < STEP_UP_TTL_MINUTES * 60_000;
}

// ------------------------------------------------------------------ customer lookup for "send a text to ..."
export interface CustomerLite { id: string; name: string; phone: string | null }
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
/** Ranked matches. Exact full name beats prefix beats token overlap. Customers without a phone are dropped. */
export function matchCustomers(query: string, customers: readonly CustomerLite[], limit = 3): CustomerLite[] {
  const q = norm(query);
  if (q.length < 2) return [];
  const qt = q.split(" ");
  const scored = customers
    .filter((c) => !!c.phone)
    .map((c) => {
      const n = norm(c.name);
      const nt = n.split(" ");
      let score = 0;
      if (n === q) score = 100;
      else if (n.startsWith(q)) score = 80;
      else if (qt.every((t) => nt.some((x) => x === t))) score = 70;
      else if (qt.every((t) => nt.some((x) => x.startsWith(t)))) score = 50;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
  if (scored.length > 1 && scored[0].score === 100 && scored[1].score < 100) return [scored[0].c]; // unambiguous exact
  return scored.slice(0, limit).map((x) => x.c);
}

export function cleanSmsBody(raw: string): { ok: true; body: string } | { ok: false; reason: "empty" | "too_long" } {
  const body = cleanText(raw, MAX_SMS_CHARS + 1);
  if (body.length < 3) return { ok: false, reason: "empty" };
  if (body.length > MAX_SMS_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true, body };
}

// ------------------------------------------------------------------ spoken answers
export interface SpokenSource {
  headline?: string; answer?: string; data_gaps?: string[]; confidence?: { level: "low" | "medium" | "high" };
}
/** <= ~70 spoken words, cut on a sentence boundary, masked below level 2, "no data" when empty. */
export function speakAnswer(a: SpokenSource, level: AuthLevel, maxWords = 70): string {
  const raw = [a.headline, a.answer].map((x) => cleanText(x ?? "", 1200)).filter(Boolean).join(". ").replace(/\.\./g, ".");
  if (!raw) return NO_DATA;
  const sentences = raw.match(/[^.!?]+[.!?]*/g) ?? [raw];
  const out: string[] = [];
  let words = 0;
  for (const s of sentences) {
    const w = s.trim().split(/\s+/).length;
    if (out.length > 0 && words + w > maxWords) break;
    out.push(s.trim());
    words += w;
  }
  let text = out.join(" ");
  if (level < 2) text = maskFinancials(text);
  if (a.confidence?.level === "low" && (a.data_gaps?.length ?? 0) > 0) text += " I don't have complete data for that.";
  return text;
}
