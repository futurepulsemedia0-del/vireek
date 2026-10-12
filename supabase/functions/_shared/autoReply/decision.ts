// supabase/functions/_shared/autoReply/decision.ts
//
// Vireek — Inbound AI auto-reply: PURE decision logic.
//
// Zero runtime imports and zero Deno/Node globals on purpose, so the exact
// code that runs in the edge functions is unit-tested by vitest
// (decision.test.ts). Everything that touches the network or the database
// lives in runtime.ts; the orchestration lives in engine.ts.

export type Channel = "sms" | "email";
export type ReplyMode = "approval" | "auto";
export type ReplyIntent = "faq" | "pricing" | "booking" | "smalltalk" | "other";
export type EpistemicTier = "confident" | "weak_match" | "no_coverage";

export interface ModelOutput {
  reply: string;
  confidence: number;
  intent: ReplyIntent;
  needsHuman: boolean;
  reason: string;
}

export type Decision =
  | { action: "escalate"; reason: string }
  | { action: "queue"; reason: string }
  | { action: "send"; reason: string };

// ---------------------------------------------------------------------------
// Text normalisation + escalation keywords
// ---------------------------------------------------------------------------

/** Built-in safety / legal / frustration triggers. Owners can add their own. */
export const DEFAULT_ESCALATION_KEYWORDS: readonly string[] = [
  // safety
  "gas leak", "smell gas", "smells like gas", "carbon monoxide", "fire", "smoke", "flood", "flooding",
  "burst pipe", "sparks", "electrocuted", "electric shock", "injured", "injury", "emergency", "unsafe", "danger",
  // legal / money disputes
  "lawyer", "attorney", "sue", "lawsuit", "legal action", "chargeback", "dispute the charge", "refund",
  "insurance claim", "better business bureau", "bbb", "police",
  // service failure / frustration
  "complaint", "manager", "supervisor", "owner", "unacceptable", "furious", "scam", "ripped off", "damaged", "damage",
  // explicit request for a person
  "human", "real person", "speak to someone", "talk to someone", "speak to a person", "call me", "representative",
  // Spanish
  "emergencia", "fuga de gas", "abogado", "reembolso", "queja", "gerente", "hablar con una persona",
  // Persian
  "اورژانس", "نشت گاز", "آتش", "وکیل", "شکایت", "بازپرداخت", "مدیر",
];

const CARRIER_KEYWORDS = new Set([
  "STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "START", "UNSTOP", "YES", "HELP", "INFO",
]);

export function normalizeText(input: string): string {
  return String(input ?? "")
    .normalize("NFKC")
    .replace(/[\u200b\u200d\ufeff]/g, "")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Trim, de-dupe (case-insensitive), cap length and count. Safe for user-supplied input. */
export function sanitizeKeywords(list: readonly string[] | null | undefined, max = 100): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list ?? []) {
    const kw = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const key = normalizeText(kw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Whole-word / whole-phrase match (Unicode-aware, so "fire" never matches
 * "fireplace" and Persian/Spanish keywords work). Custom keywords are checked
 * first so the reported match is the owner's own wording when both hit.
 */
export function findEscalationKeyword(
  text: string,
  custom: readonly string[] = [],
  useDefaults = true,
): string | null {
  const haystack = normalizeText(text);
  if (!haystack) return null;
  const candidates = [...sanitizeKeywords(custom), ...(useDefaults ? DEFAULT_ESCALATION_KEYWORDS : [])];
  for (const kw of candidates) {
    const needle = normalizeText(kw);
    if (!needle) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "u");
    if (re.test(haystack)) return kw;
  }
  return null;
}

/** Messages the carrier / compliance layer owns (STOP, HELP, START…). Never auto-answer these. */
export function isCarrierKeyword(text: string): boolean {
  const t = String(text ?? "").trim().replace(/[.!\s]+$/g, "").toUpperCase();
  return CARRIER_KEYWORDS.has(t);
}

const AUTOMATED_LOCAL_PART =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|alerts?|automated?|daemon)([-_+.]|$)/i;
const AUTOMATED_SUBJECT =
  /^\s*(auto(matic)?[\s-]?repl(y|ies)|out of office|undeliverable|delivery status notification|mail delivery)/i;

/** Email loop / bulk guard: never auto-reply to robots, bounces, newsletters or other auto-responders. */
export function isAutomatedSender(
  address: string,
  headers?: Record<string, string> | null,
  subject?: string | null,
): boolean {
  const local = String(address ?? "").toLowerCase().split("@")[0] ?? "";
  if (AUTOMATED_LOCAL_PART.test(local)) return true;
  if (subject && AUTOMATED_SUBJECT.test(subject)) return true;
  if (headers) {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v ?? "").toLowerCase();
    const autoSubmitted = h["auto-submitted"];
    if (autoSubmitted && autoSubmitted !== "no") return true;
    if (["bulk", "junk", "list", "auto_reply"].includes(h["precedence"] ?? "")) return true;
    if ("x-autoreply" in h || "x-autorespond" in h || "list-unsubscribe" in h) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Business hours (timezone-aware; the voice stack still evaluates in UTC)
// ---------------------------------------------------------------------------

export interface DayHours {
  open?: string;
  close?: string;
  closed?: boolean;
}
export type BusinessHoursMap = Partial<Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", DayHours>>;
export interface HolidayEntry {
  date?: string;
  label?: string;
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function toMinutes(hhmm: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

function localParts(now: Date, timeZone: string): { dateStr: string; day: (typeof DAY_KEYS)[number]; minutes: number } {
  const build = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(now);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = build(timeZone || "UTC");
  } catch {
    parts = build("UTC");
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = get("weekday").slice(0, 3).toLowerCase() as (typeof DAY_KEYS)[number];
  return {
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
    day: DAY_KEYS.includes(day) ? day : "sun",
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

/** true = open, false = closed (incl. holidays), null = no hours configured (unknown). */
export function isBusinessOpen(
  hours: BusinessHoursMap | null | undefined,
  holidays: HolidayEntry[] | null | undefined,
  now: Date,
  timeZone: string,
): boolean | null {
  if (!hours || Object.keys(hours).length === 0) return null;
  const { dateStr, day, minutes } = localParts(now, timeZone);
  if (holidays?.some((h) => h.date === dateStr)) return false;
  const d = hours[day];
  if (!d || d.closed) return false;
  const open = toMinutes(d.open);
  const close = toMinutes(d.close);
  if (open === null || close === null) return false;
  return open < close ? minutes >= open && minutes < close : minutes >= open || minutes < close; // overnight
}

export function summarizeHours(hours: BusinessHoursMap | null | undefined): string | null {
  if (!hours || Object.keys(hours).length === 0) return null;
  const names: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
  return (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const)
    .map((k) => {
      const d = hours[k];
      return !d || d.closed || !d.open || !d.close ? `${names[k]} closed` : `${names[k]} ${d.open}-${d.close}`;
    })
    .join("; ");
}

// ---------------------------------------------------------------------------
// Model output parsing + confidence
// ---------------------------------------------------------------------------

const INTENTS: readonly ReplyIntent[] = ["faq", "pricing", "booking", "smalltalk", "other"];

/** Tolerant JSON extraction (fences, leading prose). Returns null if the contract isn't met. */
export function parseModelOutput(raw: string): ModelOutput | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  const reply = typeof obj.reply === "string" ? obj.reply.trim() : "";
  const needsHuman = obj.needs_human === true;
  if (!reply && !needsHuman) return null;
  const conf = typeof obj.confidence === "number" ? obj.confidence : Number(obj.confidence);
  const intent = INTENTS.includes(obj.intent as ReplyIntent) ? (obj.intent as ReplyIntent) : "other";
  return {
    reply: reply.slice(0, 2000),
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0,
    intent,
    needsHuman,
    reason: typeof obj.reason === "string" ? obj.reason.trim().slice(0, 200) : "",
  };
}

/**
 * Final confidence = the LOWER of the model's self-rating and what retrieval
 * can actually vouch for. A fluent model on top of a weak knowledge-base match
 * must never clear the owner's threshold.
 */
export function combineConfidence(input: {
  intent: ReplyIntent;
  modelConfidence: number;
  tier: EpistemicTier;
}): number {
  const model = Number.isFinite(input.modelConfidence) ? Math.min(1, Math.max(0, input.modelConfidence)) : 0;
  let cap: number;
  if (input.intent === "smalltalk" || input.intent === "booking") cap = 0.95; // not knowledge-bound
  else if (input.tier === "no_coverage") cap = 0;
  else if (input.tier === "weak_match") cap = 0.55;
  else cap = 0.99;
  return Math.round(Math.min(model, cap) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Reply safety checks (deterministic, run on EVERY draft)
// ---------------------------------------------------------------------------

const URL_RE = /(?:https?:\/\/[^\s)<>"]+|www\.[^\s)<>"]+)/gi;
const MONEY_RE = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|dollars?|eur|euros?)\b)/gi;
const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;
const COMMITMENT_RE =
  /\b(you(?:'re| are) (?:all )?(?:booked|scheduled|confirmed|set)|(?:i|we)(?:'ve| have) (?:booked|scheduled|reserved|confirmed)|(?:your )?(?:appointment|booking) (?:is|has been) (?:confirmed|booked|scheduled)|(?:we|our (?:tech|technician|team))(?: will|'ll) (?:be there|arrive|come) (?:at|by|on|between))\b/i;
const HUMAN_CLAIM_RE = /\b(?:i am|i'm) (?:a )?(?:human|real person)\b/i;

function toNumber(token: string): number {
  return parseFloat(token.replace(/[^0-9.]/g, ""));
}

function normalizeUrl(u: string): string {
  return u.replace(/[.,;:!?]+$/g, "").replace(/\/+$/g, "").toLowerCase();
}

/** Returns machine codes; empty array = clean. Any code forces human review, even in full-auto mode. */
export function findReplyViolations(
  reply: string,
  ctx: { groundingText: string; allowedUrls: readonly string[] },
): string[] {
  const out: string[] = [];
  const allowed = new Set(ctx.allowedUrls.map(normalizeUrl));

  for (const url of reply.match(URL_RE) ?? []) {
    if (!allowed.has(normalizeUrl(url))) {
      out.push("url_not_allowed");
      break;
    }
  }

  const known = new Set((ctx.groundingText.match(NUMBER_RE) ?? []).map(toNumber));
  for (const amount of reply.match(MONEY_RE) ?? []) {
    if (!known.has(toNumber(amount))) {
      out.push("ungrounded_amount");
      break;
    }
  }

  if (COMMITMENT_RE.test(reply)) out.push("unauthorised_commitment");
  if (HUMAN_CLAIM_RE.test(reply)) out.push("claims_to_be_human");
  return out;
}

// ---------------------------------------------------------------------------
// Final formatting
// ---------------------------------------------------------------------------

export const SMS_MAX_CHARS = 320;
export const EMAIL_MAX_CHARS = 4000;

export function truncateAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("؟ "));
  if (sentence >= max * 0.5) return cut.slice(0, sentence + 1).trim();
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.5 ? cut.slice(0, space) : cut).trim();
}

export function finalizeReply(
  reply: string,
  opts: { channel: Channel; signature?: string | null; includeSignature?: boolean },
): string {
  let body = String(reply ?? "")
    .replace(/\*\*|__|`|^#+\s*/gm, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const sig = opts.includeSignature ? (opts.signature ?? "").trim() : "";

  if (opts.channel === "sms") {
    body = body.replace(/\s*\n\s*/g, " ");
    const room = sig ? SMS_MAX_CHARS - sig.length - 1 : SMS_MAX_CHARS;
    body = truncateAtBoundary(body, Math.max(60, room));
    return sig ? `${body} ${sig}` : body;
  }
  body = truncateAtBoundary(body, EMAIL_MAX_CHARS);
  return sig ? `${body}\n\n${sig}` : body;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export function decideAction(input: {
  mode: ReplyMode;
  threshold: number;
  confidence: number;
  modelNeedsHuman: boolean;
  violations: readonly string[];
}): Decision {
  if (input.modelNeedsHuman) return { action: "escalate", reason: "model_requested_human" };
  if (input.violations.length > 0) return { action: "queue", reason: `guard_${input.violations[0]}` };
  if (input.confidence < input.threshold) return { action: "queue", reason: "below_threshold" };
  if (input.mode === "approval") return { action: "queue", reason: "approval_mode" };
  return { action: "send", reason: "auto_sent" };
}

export const DEFAULT_ESCALATION_ACK =
  "Thanks for reaching out — a member of our team will personally follow up with you shortly. " +
  "If this is an emergency or anyone is in danger, please call your local emergency number right away.";
