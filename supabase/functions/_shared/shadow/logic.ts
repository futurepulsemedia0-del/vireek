// supabase/functions/_shared/shadow/logic.ts
//
// Shadow Mode — pure rules. No I/O, no clock, no randomness: every function
// here is deterministic so the replay pipeline can be tested and re-run.
//
// SAFETY MODEL: Sarah NEVER speaks to a caller or triggers a side effect in
// Shadow Mode. Structurally this module only knows ONE port (`analyze`, a
// read-only text→JSON call). It has no SMS / booking / transfer / dial port, so
// a shadow run cannot act even by mistake. Every "would-be action" it emits is
// stamped `executed: false` and `assertShadowSafe()` rejects anything else.
//
// NOT LEGAL ADVICE: consent rules are conservative defaults. See
// docs/SHADOW_MODE.md → "Legal / telephony decisions needed".

import { allPartyStateForNumber } from "../compliance/recordingConsent.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const SHADOW_TRIAL_DAYS = 7;
export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 90;
export const PIPELINE_VERSION = "shadow-v1";
export const DIGEST_DAYS = [1, 3, 7] as const;
/** Fewer reviewed cards than this => readiness is "insufficient_data", never a number. */
export const MIN_REVIEWED_FOR_READINESS = 10;
/** A call answered by staff slower than this counts as a slow answer in the diff. */
export const SLOW_ANSWER_SECONDS = 30;
export const ESTIMATE_LABEL = "Estimate — not realized revenue";
export const DEFAULT_CLOSE_RATE = 0.25; // matches valueScoreboard default (25%)
export const MAX_CLOSE_RATE = 0.5;
/** Range band applied around the point estimate. */
export const CLOSE_RATE_BAND = { low: 0.6, high: 1.4 } as const;
export const TICKET_BAND = { low: 0.8, high: 1.2 } as const;
/** Hard cap: no single call may ever contribute more than this multiple of the avg ticket. */
export const PER_CALL_CAP_MULTIPLE = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type ShadowSource = "pbx_call" | "voicemail" | "call_row";
export type ShadowMode = "replay" | "live_listen";

export type Intent =
  | "emergency" | "booking" | "quote" | "reschedule" | "existing_customer_issue"
  | "wrong_number" | "spam" | "vendor" | "other";

export type ActualOutcome =
  | "answered_fast" | "answered_slow" | "missed" | "voicemail" | "abandoned" | "unknown";

export interface ShadowAnalysis {
  intent: Intent;
  emergency: boolean;
  emergency_reason: string | null;
  greeting: string;
  triage_summary: string;
  would_book: boolean;
  slot_label: string | null; // human label only, e.g. "Tomorrow morning" — never a real booking
  service: string | null;
  crm_entry: { name: string | null; phone_present: boolean; service: string | null; notes: string };
  follow_up_sms: string | null;
  confidence: number; // 0..1
}

export interface WouldBeAction {
  kind: "greet" | "triage" | "flag_emergency" | "book_slot" | "create_crm_entry" | "send_follow_up_sms";
  description: string;
  executed: false; // literal — shadow actions are NEVER executed
}

export interface ShadowCallInput {
  accountId: string;
  source: ShadowSource;
  sourceId: string;
  callerPhone: string | null;
  startedAt: string; // ISO
  answeredAt: string | null;
  status: string; // pbx status or calls.status
  durationSeconds: number | null;
  transcript: string | null;
  isAfterHours: boolean;
}

export interface Diff {
  outcome: ActualOutcome;
  answerSeconds: number | null;
  afterHours: boolean;
  sarahWouldHaveCaptured: boolean;
  note: string;
}

export interface EstimateInput {
  avgTicketCents: number | null;
  closeRate: number | null;
  cards: Array<{ wouldBook: boolean; capturable: boolean }>;
}

export interface Estimate {
  isEstimate: true;
  label: string;
  avgTicketCents: number | null;
  closeRate: number;
  capturableCalls: number;
  expectedBookings: number;
  pointCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  formula: string;
  reason: "ok" | "no_avg_ticket" | "no_capturable_calls";
}

// ---------------------------------------------------------------------------
// Trial clock
// ---------------------------------------------------------------------------
const DAY_MS = 86_400_000;

/** 1-based trial day (1..7). 0 before start. 8 = past the window. Pure: caller passes `now`. */
export function trialDay(startedAtIso: string, nowIso: string): number {
  const s = Date.parse(startedAtIso);
  const n = Date.parse(nowIso);
  if (!Number.isFinite(s) || !Number.isFinite(n)) return 0;
  if (n < s) return 0;
  return Math.min(SHADOW_TRIAL_DAYS + 1, Math.floor((n - s) / DAY_MS) + 1);
}

export function isTrialExpired(startedAtIso: string, nowIso: string): boolean {
  return trialDay(startedAtIso, nowIso) > SHADOW_TRIAL_DAYS;
}

/** Which digest (1, 3 or 7) is due and not yet sent. Returns null if none. */
export function digestDue(startedAtIso: string, nowIso: string, sentDays: number[]): number | null {
  const day = Math.min(trialDay(startedAtIso, nowIso), SHADOW_TRIAL_DAYS);
  for (const d of [...DIGEST_DAYS].reverse()) {
    if (day >= d && !sentDays.includes(d)) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Consent gating
// ---------------------------------------------------------------------------
export interface ConsentConfig {
  /** Owner attests recording + AI analysis of these calls is lawful and disclosed. */
  replayAttested: boolean;
  /** Owner confirms callers hear a recording/AI-analysis disclosure on every call. */
  callerDisclosureConfigured: boolean;
  /** Staff have been told their calls are analysed. */
  staffNotified: boolean;
  /** Does the telephony provider on this line support a one-way audio fork? */
  telephonySupportsFork: boolean;
  /** Jurisdictions (US state codes) the owner explicitly marked as cleared by counsel. */
  counselClearedStates: string[];
}

export interface ConsentDecision {
  allowed: boolean;
  reason:
    | "ok"
    | "replay_not_attested"
    | "disclosure_missing"
    | "staff_not_notified"
    | "fork_unsupported"
    | "all_party_state_not_cleared"
    | "jurisdiction_unknown";
  state: string | null;
  needsLegalReview: boolean;
}

/**
 * Replay needs owner attestation + disclosure. Live-listen is stricter:
 * fork support, caller disclosure, staff notice, and — for all-party-consent
 * states OR unknown jurisdiction — explicit counsel clearance. Unknown is
 * treated as all-party (fail closed).
 */
export function evaluateConsent(mode: ShadowMode, callerPhone: string | null, cfg: ConsentConfig): ConsentDecision {
  const state = allPartyStateForNumber(callerPhone);
  const base = { state, needsLegalReview: state !== null };
  if (!cfg.replayAttested) return { ...base, allowed: false, reason: "replay_not_attested" };
  if (!cfg.callerDisclosureConfigured) return { ...base, allowed: false, reason: "disclosure_missing" };
  if (!cfg.staffNotified) return { ...base, allowed: false, reason: "staff_not_notified" };
  if (mode === "replay") return { ...base, allowed: true, reason: "ok" };

  if (!cfg.telephonySupportsFork) return { ...base, allowed: false, reason: "fork_unsupported" };
  const digits = (callerPhone ?? "").replace(/\D/g, "");
  const isNanp = digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
  if (!isNanp) return { state, needsLegalReview: true, allowed: false, reason: "jurisdiction_unknown" };
  if (state !== null && !cfg.counselClearedStates.includes(state)) {
    return { ...base, allowed: false, reason: "all_party_state_not_cleared" };
  }
  return { ...base, allowed: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// PII redaction (stored artifacts only; best-effort — names are NOT removed)
// ---------------------------------------------------------------------------
function luhn(d: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redactPii(text: string | null | undefined): string {
  if (!text) return "";
  let out = String(text);
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]");
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]");
  // card-like digit runs (13–19 digits, optional spaces/dashes) — only if Luhn-valid
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const d = m.replace(/\D/g, "");
    return d.length >= 13 && d.length <= 19 && luhn(d) ? "[CARD]" : m;
  });
  out = out.replace(/(?:\+?1[ .-]?)?\(?\b\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, "[PHONE]");
  out = out.replace(
    /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s){1,4}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|way|pl|place)\b\.?/gi,
    "[ADDRESS]",
  );
  return out;
}

export function clampRetentionDays(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, v));
}

export function purgeAfter(createdAtIso: string, retentionDays: number): string {
  return new Date(Date.parse(createdAtIso) + clampRetentionDays(retentionDays) * DAY_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Emergency floor — deterministic keyword net. The model can ADD emergencies,
// it can never remove one these rules caught.
// ---------------------------------------------------------------------------
const EMERGENCY_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(smell(s|ing)? (of )?gas|gas leak|gas smell)\b/i, reason: "Possible gas leak" },
  { re: /\b(carbon monoxide|co alarm|co detector)\b/i, reason: "Possible carbon monoxide" },
  { re: /\b(burst pipe|pipe burst|flooding|flooded|water everywhere|sewage (backup|overflow))\b/i, reason: "Active water damage" },
  { re: /\b(sparks?|sparking|burning smell|smoke from|electrical fire|outlet (is )?hot)\b/i, reason: "Electrical / fire hazard" },
  { re: /\b(no (heat|heating|ac|air conditioning)\b.*\b(baby|infant|elderly|newborn|oxygen)|\b(baby|infant|elderly|newborn|oxygen)\b.*\bno (heat|heating|ac|air conditioning))\b/i, reason: "No heating/cooling with vulnerable occupant" },
  { re: /\b(huele a gas|fuga de gas|tuber[ií]a rota|inundaci[oó]n)\b/i, reason: "Emergencia (gas/agua)" },
  { re: /(بوی گاز|نشت گاز|لوله ترکیده|آب گرفتگی)/, reason: "اضطراری (گاز/آب)" },
];

export function detectEmergencyFloor(transcript: string | null | undefined): { emergency: boolean; reason: string | null } {
  const t = transcript ?? "";
  for (const p of EMERGENCY_PATTERNS) if (p.re.test(t)) return { emergency: true, reason: p.reason };
  return { emergency: false, reason: null };
}

// ---------------------------------------------------------------------------
// Diff vs. what actually happened
// ---------------------------------------------------------------------------
export function diffAgainstActual(input: ShadowCallInput, analysis: ShadowAnalysis): Diff {
  const startedMs = Date.parse(input.startedAt);
  const answeredMs = input.answeredAt ? Date.parse(input.answeredAt) : NaN;
  const answerSeconds = Number.isFinite(answeredMs) && Number.isFinite(startedMs) && answeredMs >= startedMs
    ? Math.round((answeredMs - startedMs) / 1000)
    : null;

  let outcome: ActualOutcome = "unknown";
  const s = input.status;
  if (s === "voicemail") outcome = "voicemail";
  else if (s === "missed" || s === "failed") outcome = "missed";
  else if (s === "abandoned") outcome = "abandoned";
  else if (answerSeconds !== null) outcome = answerSeconds > SLOW_ANSWER_SECONDS ? "answered_slow" : "answered_fast";
  else if (s === "completed" || s === "in_progress" || s === "ai_handled") outcome = "answered_fast";

  const unansweredOrSlow = outcome === "missed" || outcome === "voicemail" || outcome === "abandoned" || outcome === "answered_slow";
  const leadIntent = analysis.intent === "booking" || analysis.intent === "quote" || analysis.intent === "emergency" || analysis.emergency;
  const sarahWouldHaveCaptured = leadIntent && (unansweredOrSlow || input.isAfterHours);

  const note =
    outcome === "answered_fast" ? "Staff answered promptly."
    : outcome === "answered_slow" ? `Staff answered after ${answerSeconds}s.`
    : outcome === "voicemail" ? "Went to voicemail."
    : outcome === "abandoned" ? "Caller hung up before an answer."
    : outcome === "missed" ? "Nobody answered."
    : "Outcome unknown.";

  return { outcome, answerSeconds, afterHours: input.isAfterHours, sarahWouldHaveCaptured, note };
}

// ---------------------------------------------------------------------------
// Estimate math — transparent and capped
// ---------------------------------------------------------------------------
export function clampCloseRate(r: number | null | undefined): number {
  if (typeof r !== "number" || !Number.isFinite(r) || r <= 0) return DEFAULT_CLOSE_RATE;
  return Math.min(MAX_CLOSE_RATE, r);
}

/**
 * expected bookings = capturable-and-would-book calls × close rate
 * point   = bookings × avg ticket
 * low/high = same with close-rate band (0.6x / 1.4x, still ≤ MAX_CLOSE_RATE)
 *            and ticket band (0.8x / 1.2x)
 * cap     = never more than (capturable calls × PER_CALL_CAP_MULTIPLE × avg ticket)
 */
export function computeEstimate(input: EstimateInput): Estimate {
  const closeRate = clampCloseRate(input.closeRate);
  const capturable = input.cards.filter((c) => c.capturable && c.wouldBook).length;
  const ticket = input.avgTicketCents && input.avgTicketCents > 0 ? Math.round(input.avgTicketCents) : null;
  const formula =
    "estimated bookings = calls Sarah would have captured × close rate; " +
    "estimated value = bookings × average ticket; range uses close rate ×0.6–×1.4 and ticket ×0.8–×1.2; " +
    "capped at captured calls × average ticket.";
  const base = { isEstimate: true as const, label: ESTIMATE_LABEL, avgTicketCents: ticket, closeRate, capturableCalls: capturable, formula };

  if (ticket === null) return { ...base, expectedBookings: 0, pointCents: null, lowCents: null, highCents: null, reason: "no_avg_ticket" };
  if (capturable === 0) return { ...base, expectedBookings: 0, pointCents: 0, lowCents: 0, highCents: 0, reason: "no_capturable_calls" };

  const cap = capturable * PER_CALL_CAP_MULTIPLE * ticket;
  const calc = (rateMul: number, ticketMul: number) =>
    Math.min(cap, Math.round(capturable * Math.min(MAX_CLOSE_RATE, closeRate * rateMul) * ticket * ticketMul));
  const point = Math.min(cap, Math.round(capturable * closeRate * ticket));
  return {
    ...base,
    expectedBookings: Math.round(capturable * closeRate * 100) / 100,
    pointCents: point,
    lowCents: Math.min(point, calc(CLOSE_RATE_BAND.low, TICKET_BAND.low)),
    highCents: Math.max(point, calc(CLOSE_RATE_BAND.high, TICKET_BAND.high)),
    reason: "ok",
  };
}

// ---------------------------------------------------------------------------
// LLM output validation (model output is untrusted input)
// ---------------------------------------------------------------------------
const INTENTS: Intent[] = ["emergency", "booking", "quote", "reschedule", "existing_customer_issue", "wrong_number", "spam", "vendor", "other"];
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strOrNull = (v: unknown, max: number): string | null => { const s = str(v, max); return s ? s : null; };

export function normalizeAnalysis(raw: unknown): ShadowAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const intent = INTENTS.includes(r.intent as Intent) ? (r.intent as Intent) : "other";
  const crm = (r.crm_entry && typeof r.crm_entry === "object" ? r.crm_entry : {}) as Record<string, unknown>;
  const conf = typeof r.confidence === "number" && Number.isFinite(r.confidence) ? Math.min(1, Math.max(0, r.confidence)) : 0;
  return {
    intent,
    emergency: r.emergency === true,
    emergency_reason: strOrNull(r.emergency_reason, 160),
    greeting: str(r.greeting, 400),
    triage_summary: str(r.triage_summary, 600),
    would_book: r.would_book === true,
    slot_label: strOrNull(r.slot_label, 80),
    service: strOrNull(r.service, 120),
    crm_entry: {
      name: strOrNull(crm.name, 120),
      phone_present: crm.phone_present === true,
      service: strOrNull(crm.service, 120),
      notes: str(crm.notes, 500),
    },
    follow_up_sms: strOrNull(r.follow_up_sms, 320),
    confidence: conf,
  };
}

// ---------------------------------------------------------------------------
// Replay pipeline
// ---------------------------------------------------------------------------
/** The ONLY capability the pipeline receives: a read-only analysis call. */
export interface ShadowPorts {
  analyze(redactedTranscript: string, ctx: { afterHours: boolean }): Promise<unknown>;
}

export interface ShadowCard {
  idempotencyKey: string;
  pipelineVersion: string;
  accountId: string;
  source: ShadowSource;
  sourceId: string;
  startedAt: string;
  transcriptRedacted: string;
  analysis: ShadowAnalysis;
  actions: WouldBeAction[];
  diff: Diff;
  capturable: boolean;
  status: "ready" | "no_transcript" | "analysis_failed" | "blocked_consent";
  blockReason: string | null;
}

export function idempotencyKey(accountId: string, source: ShadowSource, sourceId: string): string {
  return `${accountId}:${source}:${sourceId}:${PIPELINE_VERSION}`;
}

export function assertShadowSafe(actions: WouldBeAction[]): void {
  for (const a of actions) {
    if ((a as { executed: unknown }).executed !== false) {
      throw new Error("SHADOW_SAFETY_VIOLATION: a would-be action was marked executed");
    }
  }
}

function buildActions(a: ShadowAnalysis): WouldBeAction[] {
  const acts: WouldBeAction[] = [];
  if (a.greeting) acts.push({ kind: "greet", description: a.greeting, executed: false });
  if (a.triage_summary) acts.push({ kind: "triage", description: a.triage_summary, executed: false });
  if (a.emergency) acts.push({ kind: "flag_emergency", description: a.emergency_reason ?? "Emergency flagged", executed: false });
  if (a.would_book) acts.push({ kind: "book_slot", description: `Would offer: ${a.slot_label ?? "next available slot"}${a.service ? ` for ${a.service}` : ""}`, executed: false });
  if (a.intent !== "spam" && a.intent !== "wrong_number" && a.intent !== "vendor") {
    acts.push({ kind: "create_crm_entry", description: a.crm_entry.notes || "Would create a lead record", executed: false });
  }
  if (a.follow_up_sms) acts.push({ kind: "send_follow_up_sms", description: a.follow_up_sms, executed: false });
  return acts;
}

export async function buildShadowCard(
  input: ShadowCallInput,
  ports: ShadowPorts,
  opts?: { blocked?: string },
): Promise<ShadowCard> {
  const key = idempotencyKey(input.accountId, input.source, input.sourceId);
  const redacted = opts?.blocked ? "" : redactPii(input.transcript);
  const empty: ShadowAnalysis = {
    intent: "other", emergency: false, emergency_reason: null, greeting: "", triage_summary: "",
    would_book: false, slot_label: null, service: null,
    crm_entry: { name: null, phone_present: false, service: null, notes: "" }, follow_up_sms: null, confidence: 0,
  };
  const mk = (status: ShadowCard["status"], analysis: ShadowAnalysis, blockReason: string | null = null): ShadowCard => {
    // only a successfully analysed call produces would-be actions; blocked / empty / failed cards produce none
    const actions = status === "ready" ? buildActions(analysis) : [];
    assertShadowSafe(actions);
    const diff = diffAgainstActual(input, analysis);
    return {
      idempotencyKey: key, pipelineVersion: PIPELINE_VERSION, accountId: input.accountId, source: input.source,
      sourceId: input.sourceId, startedAt: input.startedAt, transcriptRedacted: redacted, analysis, actions, diff,
      capturable: diff.sarahWouldHaveCaptured && analysis.would_book, status, blockReason,
    };
  };
  if (opts?.blocked) return mk("blocked_consent", empty, opts.blocked);

  if (!redacted.trim()) return mk("no_transcript", empty);

  let normalized: ShadowAnalysis | null = null;
  try {
    normalized = normalizeAnalysis(await ports.analyze(redacted, { afterHours: input.isAfterHours }));
  } catch {
    normalized = null;
  }
  if (!normalized) return mk("analysis_failed", empty);

  // Safety floor: deterministic rules can only ADD an emergency, never remove one.
  const floor = detectEmergencyFloor(redacted);
  if (floor.emergency && !normalized.emergency) {
    normalized = { ...normalized, emergency: true, emergency_reason: floor.reason, intent: "emergency" };
  }
  return mk("ready", normalized);
}

// ---------------------------------------------------------------------------
// Readiness score (0–100) — deterministic, gated on sample size
// ---------------------------------------------------------------------------
export interface ReviewStats {
  cardsTotal: number;
  cardsReviewed: number;
  approved: number;
  emergencyCards: number;
  emergencyApproved: number;
  openCriticalMistakes: number;
  setupItemsDone: number; // of 4: forwarding, hours, emergency rules, test call
}

export interface Readiness {
  state: "insufficient_data" | "scored";
  score: number | null;
  band: "not_ready" | "almost" | "ready" | null;
  parts: { accuracy: number; emergencySafety: number; coverage: number; setup: number } | null;
}

export function computeReadiness(s: ReviewStats): Readiness {
  if (s.cardsReviewed < MIN_REVIEWED_FOR_READINESS || s.cardsTotal <= 0) {
    return { state: "insufficient_data", score: null, band: null, parts: null };
  }
  const accuracy = s.approved / s.cardsReviewed;
  const emergencySafety = s.emergencyCards === 0 ? 1 : s.emergencyApproved / s.emergencyCards;
  const coverage = Math.min(1, s.cardsReviewed / s.cardsTotal);
  const setup = Math.min(1, s.setupItemsDone / 4);
  let score = Math.round(100 * (0.5 * accuracy + 0.25 * emergencySafety + 0.1 * coverage + 0.15 * setup));
  if (s.openCriticalMistakes > 0) score = Math.min(score, 69); // an unresolved critical mistake blocks "ready"
  if (emergencySafety < 1 && s.emergencyCards > 0) score = Math.min(score, 79);
  const band = score >= 85 ? "ready" : score >= 70 ? "almost" : "not_ready";
  return { state: "scored", score, band, parts: { accuracy, emergencySafety, coverage, setup } };
}

// ---------------------------------------------------------------------------
// After-hours (timezone-aware). The live path's isAfterHoursAt() in
// vapi-webhook evaluates in UTC; Shadow Mode must judge "after hours" in the
// business's own zone or the Proof-of-Value numbers would be wrong.
// ---------------------------------------------------------------------------
export interface DayHoursLite { open?: string; close?: string; closed?: boolean }
export type BusinessHoursLite = Partial<Record<"sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat", DayHoursLite>>;

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export function isAfterHoursIn(
  hours: BusinessHoursLite | null,
  holidayDates: string[],
  whenIso: string,
  timeZone: string,
): boolean {
  const ms = Date.parse(whenIso);
  if (!Number.isFinite(ms) || !hours) return false; // unknown hours: never claim a call was after-hours
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  if (holidayDates.includes(dateStr)) return true;
  const dayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const d = dayIdx >= 0 ? hours[DAY_KEYS[dayIdx]] : undefined;
  if (!d || d.closed || !d.open || !d.close) return true;
  const now = Number(get("hour")) * 60 + Number(get("minute"));
  const [oh, om] = d.open.split(":").map(Number);
  const [ch, cm] = d.close.split(":").map(Number);
  if (![oh, om, ch, cm].every(Number.isFinite)) return false;
  return now < oh * 60 + om || now >= ch * 60 + cm;
}
