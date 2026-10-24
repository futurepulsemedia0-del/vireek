// supabase/functions/_shared/compliance-rules/engine.ts
//
// Regulation-as-code evaluation engine. Pure and deterministic: same rules +
// same context + same instant => same result. No I/O, no Deno/npm imports, so
// the dashboard simulator, Vitest and the edge functions all run THIS file.
//
// NOT LEGAL ADVICE. The engine only applies rule versions a human reviewer has
// approved (status = "approved"); it never ships its own legal conclusions.

import { isValidTimezone, parseHHMM, zonedParts, zonedToUtc } from "../messaging/quietHoursCore.ts";
import { normalizeState, stateOfJurisdiction, US_STATES } from "./jurisdiction.ts";
import type {
  ActionType,
  ConsentType,
  EvalContext,
  EvaluationResult,
  Finding,
  FindingStatus,
  MatchOn,
  Outcome,
  RequiredAction,
  RuleKind,
  RuleVersion,
  SaleLocation,
  Severity,
  SkippedRule,
  Surface,
} from "./types.ts";
import { RULE_KINDS, SURFACES } from "./types.ts";

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

export const KIND_SURFACES: Record<RuleKind, readonly Surface[]> = {
  recording_consent: ["call"],
  ai_disclosure: ["call", "sms", "email"],
  quiet_hours: ["call", "sms"],
  consent_required: ["call", "sms", "email"],
  license_display: ["quote", "contract"],
  rescission: ["quote", "contract"],
  required_notice: ["call", "sms", "email", "quote", "contract"],
  price_cap: ["quote", "contract"],
};

/** Which party's state a rule is matched against unless params.matchOn overrides it. */
const DEFAULT_MATCH_ON: Record<RuleKind, MatchOn> = {
  recording_consent: "either",
  ai_disclosure: "either",
  quiet_hours: "either",
  consent_required: "either",
  license_display: "counterparty", // where the work is performed
  rescission: "counterparty",
  required_notice: "either",
  price_cap: "counterparty",
};

const CONSENT_TYPES: readonly ConsentType[] = [
  "call_recording", "marketing_sms", "marketing_email", "data_processing", "marketing_call", "ai_voice",
];
const SALE_LOCATIONS: readonly SaleLocation[] = ["customer_home", "business_premises", "phone", "online", "other"];
const DEFAULT_TZ = "America/New_York";
const SEVERITY_RANK: Record<Severity, number> = { block: 0, require: 1, warn: 2, info: 3 };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const strArr = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
const money = (cents: number): string => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// ---------------------------------------------------------------------------
// Parameter + version validation (shared by the staff editor and tests)
// ---------------------------------------------------------------------------

interface Window { days: number[]; start: number; end: number }

function parseWindows(raw: unknown): Window[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Window[] = [];
  for (const w of raw) {
    if (!isObj(w) || !Array.isArray(w.days) || w.days.length === 0) return null;
    if (!w.days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) return null;
    const start = typeof w.start === "string" ? parseHHMM(w.start) : NaN;
    const end = typeof w.end === "string" ? parseHHMM(w.end) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;
    out.push({ days: w.days as number[], start, end });
  }
  return out;
}

export function validateRuleParams(kind: RuleKind, params: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(params)) return ["params must be an object"];
  const p = params;
  if (p.matchOn !== undefined && !["either", "counterparty", "business"].includes(String(p.matchOn))) {
    errs.push("matchOn must be either | counterparty | business");
  }
  switch (kind) {
    case "recording_consent":
      if (p.mode !== "all_party" && p.mode !== "one_party") errs.push("mode must be all_party or one_party");
      if (p.mode === "all_party" && !str(p.script)) errs.push("script is required for all_party");
      break;
    case "ai_disclosure":
      if (!str(p.script)) errs.push("script is required");
      break;
    case "quiet_hours":
      if (!parseWindows(p.windows)) errs.push("windows must be a non-empty list of {days:[0-6], start:'HH:MM', end:'HH:MM'} with start < end");
      if (p.purposes !== undefined && !(strArr(p.purposes) ?? ["?"]).every((x) => ["marketing", "service", "emergency"].includes(x))) {
        errs.push("purposes must be a list of marketing | service | emergency");
      }
      break;
    case "consent_required":
      if (!CONSENT_TYPES.includes(p.consentType as ConsentType)) errs.push(`consentType must be one of ${CONSENT_TYPES.join(", ")}`);
      break;
    case "license_display":
      if (!str(p.licenseLabel)) errs.push("licenseLabel is required");
      break;
    case "rescission": {
      const d = int(p.days);
      if (d === null || d < 1 || d > 30) errs.push("days must be an integer 1-30");
      const m = int(p.minAmountCents);
      if (m === null || m < 0) errs.push("minAmountCents must be an integer >= 0");
      const locs = strArr(p.saleLocations);
      if (!locs || locs.length === 0 || !locs.every((l) => SALE_LOCATIONS.includes(l as SaleLocation))) {
        errs.push(`saleLocations must be a non-empty list of ${SALE_LOCATIONS.join(" | ")}`);
      }
      if (p.excludedWeekdays !== undefined && !(Array.isArray(p.excludedWeekdays) && p.excludedWeekdays.every((x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 6))) {
        errs.push("excludedWeekdays must be a list of 0-6");
      }
      break;
    }
    case "required_notice":
      if (!str(p.noticeId) || !/^[a-z0-9_-]{2,60}$/.test(String(p.noticeId))) errs.push("noticeId must match [a-z0-9_-]{2,60}");
      if (!str(p.text)) errs.push("text is required");
      break;
    case "price_cap": {
      if (p.condition !== "emergency_declared") errs.push("condition must be emergency_declared");
      const pct = p.maxIncreasePercent;
      if (typeof pct !== "number" || !(pct > 0 && pct <= 100)) errs.push("maxIncreasePercent must be a number > 0 and <= 100");
      break;
    }
  }
  return errs;
}

export interface VersionDraft {
  jurisdiction: string;
  kind: string;
  severity: string;
  appliesTo: string[];
  title: string;
  ownerExplanation: string;
  params: unknown;
  sourceRefs: Array<{ citation?: string }>;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Everything that must hold before a version can be submitted for review. */
export function validateVersionDraft(v: VersionDraft): string[] {
  const errs: string[] = [];
  if (!/^US(-[A-Z]{2})?$/.test(v.jurisdiction) || (v.jurisdiction !== "US" && !US_STATES.has(v.jurisdiction.slice(3)))) {
    errs.push("jurisdiction must be US or US-<state code>");
  }
  if (!(RULE_KINDS as readonly string[]).includes(v.kind)) {
    errs.push("unknown rule kind");
    return errs;
  }
  const kind = v.kind as RuleKind;
  if (!["block", "require", "warn", "info"].includes(v.severity)) errs.push("severity must be block | require | warn | info");
  if (!v.title.trim()) errs.push("title is required");
  if (v.ownerExplanation.trim().length < 20) errs.push("owner explanation must be at least 20 characters");
  if (v.appliesTo.length === 0) errs.push("choose at least one surface");
  for (const s of v.appliesTo) {
    if (!(SURFACES as readonly string[]).includes(s)) errs.push(`unknown surface ${s}`);
    else if (!KIND_SURFACES[kind].includes(s as Surface)) errs.push(`${kind} cannot apply to ${s}`);
  }
  if (kind === "license_display" && v.jurisdiction === "US") errs.push("license_display needs a state jurisdiction");
  if (v.sourceRefs.length === 0 || v.sourceRefs.some((r) => !r.citation?.trim())) errs.push("at least one source reference with a citation is required");
  if (!isDateKey(v.effectiveFrom)) errs.push("effective-from must be a valid YYYY-MM-DD date");
  if (v.effectiveTo !== null && (!isDateKey(v.effectiveTo) || (isDateKey(v.effectiveFrom) && v.effectiveTo < v.effectiveFrom))) {
    errs.push("effective-to must be a valid date on or after effective-from");
  }
  errs.push(...validateRuleParams(kind, v.params));
  return errs;
}

// ---------------------------------------------------------------------------
// Effective-date resolution
// ---------------------------------------------------------------------------

/** Active versions on `dateKey`: approved, effective, newest version per (jurisdiction, rule). */
export function selectEffective(versions: readonly RuleVersion[], dateKey: string): RuleVersion[] {
  const best = new Map<string, RuleVersion>();
  for (const v of versions) {
    if (v.status !== "approved") continue;
    if (v.effectiveFrom > dateKey) continue;
    if (v.effectiveTo !== null && v.effectiveTo <= dateKey) continue;
    const key = `${v.jurisdiction}|${v.ruleKey}`;
    const cur = best.get(key);
    if (!cur || v.version > cur.version) best.set(key, v);
  }
  return [...best.values()].sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction) || a.ruleKey.localeCompare(b.ruleKey));
}

export type Timeline = "active" | "upcoming" | "expired" | "inactive";

export function timelineOf(v: Pick<RuleVersion, "status" | "effectiveFrom" | "effectiveTo">, dateKey: string): Timeline {
  if (v.status !== "approved" && v.status !== "retired") return "inactive";
  if (v.effectiveFrom > dateKey) return "upcoming";
  if (v.effectiveTo !== null && v.effectiveTo <= dateKey) return "expired";
  return v.status === "approved" ? "active" : "expired";
}

// ---------------------------------------------------------------------------
// Rescission: business days (FTC 16 CFR 429 style: every day except Sunday and legal holidays)
// ---------------------------------------------------------------------------

function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}
function lastMonday(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - ((last.getUTCDay() - 1 + 7) % 7);
}

/**
 * Legal public holidays (5 U.S.C. 6103), including the observed day when the
 * holiday falls on a weekend. Deliberately a superset: counting an extra
 * holiday only EXTENDS the customer's window, which is the safe direction.
 */
export function legalHolidayKeys(year: number): Set<string> {
  const keys = new Set<string>();
  const key = (y: number, m: number, d: number) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.toISOString().slice(0, 10);
  };
  const fixed = (m: number, d: number) => {
    keys.add(key(year, m, d));
    const wd = new Date(Date.UTC(year, m - 1, d)).getUTCDay();
    if (wd === 6) keys.add(key(year, m, d - 1));
    if (wd === 0) keys.add(key(year, m, d + 1));
  };
  fixed(1, 1); fixed(6, 19); fixed(7, 4); fixed(11, 11); fixed(12, 25);
  keys.add(key(year, 1, nthWeekday(year, 1, 1, 3))); // MLK Day
  keys.add(key(year, 2, nthWeekday(year, 2, 1, 3))); // Washington's Birthday
  keys.add(key(year, 5, lastMonday(year, 5))); // Memorial Day
  keys.add(key(year, 9, nthWeekday(year, 9, 1, 1))); // Labor Day
  keys.add(key(year, 10, nthWeekday(year, 10, 1, 2))); // Columbus Day
  keys.add(key(year, 11, nthWeekday(year, 11, 4, 4))); // Thanksgiving
  return keys;
}

/** The Nth business day AFTER `fromKey` (YYYY-MM-DD). */
export function nthBusinessDayAfter(fromKey: string, n: number, excludedWeekdays: readonly number[] = [0]): string {
  const [y, m, d] = fromKey.split("-").map(Number);
  let cursor = Date.UTC(y, m - 1, d);
  let counted = 0;
  const holidayCache = new Map<number, Set<string>>();
  for (let guard = 0; guard < 120 && counted < n; guard++) {
    cursor += 86_400_000;
    const t = new Date(cursor);
    const year = t.getUTCFullYear();
    if (!holidayCache.has(year)) holidayCache.set(year, legalHolidayKeys(year));
    const k = t.toISOString().slice(0, 10);
    if (excludedWeekdays.includes(t.getUTCDay()) || holidayCache.get(year)!.has(k)) continue;
    counted++;
  }
  return new Date(cursor).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Quiet-hours windows
// ---------------------------------------------------------------------------

function inAnyWindow(at: Date, tz: string, windows: Window[]): boolean {
  const p = zonedParts(at, tz);
  const mins = p.hour * 60 + p.minute;
  return windows.some((w) => w.days.includes(p.weekday) && mins >= w.start && mins < w.end);
}

/** First instant strictly after `at` at which any allowed window opens. */
function nextWindowOpen(at: Date, tz: string, windows: Window[]): Date | null {
  const p = zonedParts(at, tz);
  let best: Date | null = null;
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    const weekday = (p.weekday + i) % 7;
    for (const w of windows) {
      if (!w.days.includes(weekday)) continue;
      const open = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(w.start / 60), w.start % 60, tz);
      if (open.getTime() > at.getTime() && (!best || open < best)) best = open;
    }
  }
  return best;
}

const hhmm = (mins: number): string => `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

interface Outcome1 {
  status: FindingStatus;
  message: string;
  actions?: Array<{ type: ActionType; text: string }>;
}

interface QuietCheck { v: RuleVersion; windows: Window[]; purposes: string[] }

export function evaluate(ctx: EvalContext, versions: readonly RuleVersion[]): EvaluationResult {
  const at = ctx.at ?? new Date();
  const purpose = ctx.purpose ?? "service";
  const business = normalizeState(ctx.businessState);
  const counterparty = normalizeState(ctx.counterpartyState);
  const assumptions: string[] = [];

  const bizTz = isValidTimezone(ctx.businessTimezone) ? ctx.businessTimezone : null;
  const cpTz = isValidTimezone(ctx.counterpartyTimezone) ? ctx.counterpartyTimezone : null;
  const localTz = cpTz ?? bizTz ?? DEFAULT_TZ;
  const dateTz = bizTz ?? cpTz ?? "UTC";
  const effectiveDate = zonedParts(at, dateTz).dateKey;

  if (ctx.surface === "call" || ctx.surface === "sms") {
    if (!cpTz) assumptions.push(`Recipient timezone unknown — used ${bizTz ?? DEFAULT_TZ}.`);
  }
  if (counterparty === null) {
    assumptions.push("Customer state unknown — state-specific rules for the customer's location could not be matched (recording consent defaults to the strictest rule).");
  } else if (ctx.counterpartyStateBasis === "phone") {
    assumptions.push(`Customer state (${counterparty}) was inferred from the phone area code and may be wrong — confirm the service address.`);
  }
  if (business === null) assumptions.push("Business state not set — set it in Compliance → Business profile so your home-state rules apply.");

  const active = selectEffective(versions, effectiveDate);
  const findings: Finding[] = [];
  const actions: RequiredAction[] = [];
  const skipped: SkippedRule[] = [];
  const applied: string[] = [];
  const quietChecks: QuietCheck[] = [];
  let rescissionDeadline: string | null = null;
  let strictRecordingUsed = false;

  const skip = (v: RuleVersion, reason: SkippedRule["reason"]) => skipped.push({ versionId: v.id, ruleKey: v.ruleKey, reason });

  // With an unknown customer state, apply exactly one all-party recording rule (the strictest assumption).
  const strictRecording =
    counterparty === null && ctx.surface === "call"
      ? active.find((v) => v.kind === "recording_consent" && stateOfJurisdiction(v.jurisdiction) !== null && isObj(v.params) && v.params.mode === "all_party" && v.appliesTo.includes("call"))
      : undefined;

  for (const v of active) {
    if (!v.appliesTo.includes(ctx.surface)) { skip(v, "surface"); continue; }
    if (validateRuleParams(v.kind, v.params).length > 0) {
      skip(v, "invalid_params");
      assumptions.push(`Rule "${v.title}" (${v.jurisdiction}) has invalid parameters and was not applied — tell the compliance team.`);
      continue;
    }
    const p = v.params;
    const matchOn = (str(p.matchOn) as MatchOn | null) ?? DEFAULT_MATCH_ON[v.kind];
    const st = stateOfJurisdiction(v.jurisdiction);
    let matches = st === null || (matchOn === "counterparty" ? counterparty === st : matchOn === "business" ? business === st : counterparty === st || business === st);
    if (!matches && strictRecording && v.id === strictRecording.id) {
      matches = true;
      strictRecordingUsed = true;
    }
    if (!matches) { skip(v, "jurisdiction"); continue; }

    let r: Outcome1 | null = null;
    switch (v.kind) {
      case "recording_consent": r = evalRecording(p, ctx, strictRecordingUsed && strictRecording?.id === v.id); break;
      case "ai_disclosure": r = evalDisclosure(p, ctx); break;
      case "consent_required": r = evalConsent(p, ctx, purpose); break;
      case "quiet_hours": {
        const purposes = strArr(p.purposes) ?? ["marketing"];
        if (!purposes.includes(purpose) || (purpose === "emergency" && p.emergencyExempt !== false)) { r = null; break; }
        const windows = parseWindows(p.windows)!;
        quietChecks.push({ v, windows, purposes });
        r = evalQuiet(windows, at, localTz);
        break;
      }
      case "license_display": r = evalLicense(v, p, ctx, effectiveDate); break;
      case "rescission": {
        const res = evalRescission(p, ctx, localTz, assumptions);
        r = res.outcome;
        if (res.deadline && (!rescissionDeadline || res.deadline > rescissionDeadline)) rescissionDeadline = res.deadline;
        break;
      }
      case "required_notice": r = evalNotice(p, ctx); break;
      case "price_cap": r = evalPriceCap(p, ctx); break;
    }
    if (!r) { skip(v, v.kind === "quiet_hours" ? "purpose" : "condition"); continue; }

    applied.push(v.id);
    findings.push({
      versionId: v.id, ruleKey: v.ruleKey, packSlug: v.packSlug, jurisdiction: v.jurisdiction, kind: v.kind,
      severity: v.severity, status: r.status, title: v.title, message: r.message, explanation: v.ownerExplanation,
      sourceRefs: v.sourceRefs, version: v.version, effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo,
    });
    for (const a of r.actions ?? []) {
      if (!actions.some((x) => x.type === a.type && x.text === a.text)) actions.push({ ...a, versionId: v.id, ruleKey: v.ruleKey });
    }
  }

  // Earliest instant at which EVERY applicable quiet-hours rule is open.
  let nextAllowedAt: string | null = null;
  const failingQuiet = findings.filter((f) => f.kind === "quiet_hours" && f.status === "fail");
  if (failingQuiet.length > 0) {
    let cursor = at;
    for (let i = 0; i < 12; i++) {
      const closed = quietChecks.filter((c) => !inAnyWindow(cursor, localTz, c.windows));
      if (closed.length === 0) break;
      const opens = closed.map((c) => nextWindowOpen(cursor, localTz, c.windows)).filter((d): d is Date => d !== null);
      if (opens.length === 0) break;
      cursor = new Date(Math.max(...opens.map((d) => d.getTime())));
      nextAllowedAt = cursor.toISOString();
    }
    if (nextAllowedAt) {
      const when = nextAllowedAt;
      actions.push({ type: "wait_until", text: `Hold until ${when} (recipient local window opens).`, versionId: failingQuiet[0].versionId, ruleKey: failingQuiet[0].ruleKey });
    }
  }

  findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      Number(a.status === "pass" || a.status === "info") - Number(b.status === "pass" || b.status === "info") ||
      a.jurisdiction.localeCompare(b.jurisdiction),
  );

  let outcome: Outcome = "allow";
  for (const f of findings) {
    if (f.status === "pass" || f.status === "info") continue;
    if (f.severity === "block") { outcome = "block"; break; }
    if (f.severity === "require") outcome = "allow_with_actions";
  }

  let recording: EvaluationResult["recording"] = null;
  const recFindings = findings.filter((f) => f.kind === "recording_consent");
  if (ctx.surface === "call" && recFindings.length > 0) {
    const failing = recFindings.some((f) => f.status === "fail");
    const needs = recFindings.find((f) => f.status === "action");
    const script = actions.find((a) => a.type === "say_script")?.text ?? null;
    recording = { permitted: failing ? "no" : needs ? "after_consent" : "yes", script: failing ? null : script };
  }

  return {
    outcome, findings, actions, skipped, assumptions: [...new Set(assumptions)],
    evaluatedAt: at.toISOString(), effectiveDate,
    jurisdictions: { business, counterparty },
    appliedVersionIds: applied, nextAllowedAt, recording, rescissionDeadline,
  };
}

// ---------------------------------------------------------------------------
// Per-kind evaluators
// ---------------------------------------------------------------------------

function evalRecording(p: Record<string, unknown>, ctx: EvalContext, assumedStrict: boolean): Outcome1 {
  const note = assumedStrict ? " (customer state unknown — strictest rule assumed)" : "";
  if (p.mode === "one_party") {
    return { status: "pass", message: `One-party consent: recording is permitted when the business is a party to the call${note}.` };
  }
  const state = ctx.consent?.call_recording ?? "none";
  const script = str(p.script)!;
  if (state === "granted") return { status: "pass", message: `All-party consent state: recording consent is on file${note}.` };
  if (state === "revoked") return { status: "fail", message: `The customer revoked recording consent — do not record this call${note}.` };
  return {
    status: "action",
    message: `All-party consent state: obtain clear consent before recording${note}.`,
    actions: [{ type: "say_script", text: script }],
  };
}

function evalDisclosure(p: Record<string, unknown>, ctx: EvalContext): Outcome1 | null {
  if (!ctx.aiVoice && !ctx.aiGenerated) return null;
  if (ctx.disclosureGiven) return { status: "pass", message: "The AI disclosure was given." };
  return { status: "action", message: "Disclose that the customer is interacting with AI.", actions: [{ type: "disclose", text: str(p.script)! }] };
}

function evalConsent(p: Record<string, unknown>, ctx: EvalContext, purpose: string): Outcome1 | null {
  const purposes = strArr(p.purposes) ?? ["marketing"];
  if (ctx.outbound === false || !purposes.includes(purpose)) return null;
  if (p.requiresAiVoice === true && !ctx.aiVoice) return null;
  const type = p.consentType as ConsentType;
  const state = ctx.consent?.[type] ?? "none";
  if (state === "granted") return { status: "pass", message: `Consent (${type}) is on file.` };
  const evidence = str(p.evidence);
  return {
    status: "fail",
    message: state === "revoked" ? `The customer revoked ${type} consent — do not contact.` : `No ${type} consent on file${evidence ? ` (${evidence} required)` : ""}.`,
    actions: [{ type: "obtain_consent", text: `Obtain and record ${type} consent${evidence ? ` (${evidence})` : ""} before contacting.` }],
  };
}

function evalQuiet(windows: Window[], at: Date, tz: string): Outcome1 {
  const p = zonedParts(at, tz);
  const local = `${hhmm(p.hour * 60 + p.minute)} ${tz}`;
  if (inAnyWindow(at, tz, windows)) return { status: "pass", message: `Inside the permitted contact window (${local}).` };
  const today = windows.filter((w) => w.days.includes(p.weekday)).map((w) => `${hhmm(w.start)}–${hhmm(w.end)}`);
  return {
    status: "fail",
    message: `Outside the permitted contact window (${local}); today's window is ${today.length ? today.join(", ") : "closed all day"}.`,
  };
}

function evalLicense(v: RuleVersion, p: Record<string, unknown>, ctx: EvalContext, dateKey: string): Outcome1 {
  const st = stateOfJurisdiction(v.jurisdiction)!;
  const label = str(p.licenseLabel)!;
  const trades = strArr(p.trades);
  const lic = (ctx.licenses ?? []).find(
    (l) => normalizeState(l.state) === st && l.number.trim() && (!trades || (l.trade && trades.includes(l.trade))),
  );
  if (!lic) {
    return {
      status: "fail",
      message: `No ${st} ${label} on file for this business.`,
      actions: [{ type: "add_license_to_profile", text: `Add your ${st} ${label} in Compliance → Business profile.` }],
    };
  }
  if (lic.expiresOn && lic.expiresOn < dateKey) {
    return { status: "fail", message: `The ${st} ${label} on file expired on ${lic.expiresOn}.`, actions: [{ type: "add_license_to_profile", text: `Renew and update your ${st} ${label}.` }] };
  }
  if (ctx.document?.licenseNumberShown === true) return { status: "pass", message: `${label} ${lic.number} is displayed.` };
  const placement = str(p.placement);
  return {
    status: "action",
    message: `${label} must be displayed on this ${ctx.surface}.`,
    actions: [{ type: "display_license", text: `Display ${label} ${lic.number}${placement ? ` ${placement}` : ""}.` }],
  };
}

function evalRescission(
  p: Record<string, unknown>, ctx: EvalContext, tz: string, assumptions: string[],
): { outcome: Outcome1 | null; deadline: string | null } {
  const doc = ctx.document ?? {};
  const locations = strArr(p.saleLocations)!;
  if (doc.saleLocation === undefined) assumptions.push("Sale location not provided — assumed the right of rescission applies.");
  else if (!locations.includes(doc.saleLocation)) return { outcome: null, deadline: null };
  const min = int(p.minAmountCents)!;
  if (doc.totalCents === undefined) assumptions.push("Contract total not provided — assumed it meets the rescission threshold.");
  else if (doc.totalCents < min) return { outcome: null, deadline: null };

  const days = int(p.days)!;
  if (doc.isEmergencyRepair && p.emergencyWaiverAllowed !== false && doc.emergencyWaiverSigned) {
    return { outcome: { status: "info", message: "Emergency-repair exemption: the customer signed the required waiver, so the right of rescission is waived." }, deadline: null };
  }
  const signed = zonedParts(doc.signedAt ?? ctx.at ?? new Date(), tz).dateKey;
  const deadline = nthBusinessDayAfter(signed, days, Array.isArray(p.excludedWeekdays) ? (p.excludedWeekdays as number[]) : [0]);
  const acts: Array<{ type: ActionType; text: string }> = [];
  if (!doc.cancellationNoticePresent) {
    acts.push({ type: "add_notice", text: str(p.noticeText) ?? `Include the written notice of the ${days}-day right to cancel and two copies of the cancellation form.` });
  }
  if (p.holdWork === true) acts.push({ type: "hold_work", text: `Do not begin work before the cancellation window ends (${deadline}).` });
  return {
    outcome: {
      status: acts.length ? "action" : "info",
      message: `The customer may cancel without penalty until the end of ${deadline} (${days} business days after signing).`,
      actions: acts.length ? acts : undefined,
    },
    deadline,
  };
}

function evalNotice(p: Record<string, unknown>, ctx: EvalContext): Outcome1 {
  const id = str(p.noticeId)!;
  if (ctx.document?.noticesPresent?.includes(id)) return { status: "pass", message: `Required notice "${id}" is included.` };
  return { status: "action", message: `Required notice "${id}" is missing.`, actions: [{ type: "add_notice", text: str(p.text)! }] };
}

function evalPriceCap(p: Record<string, unknown>, ctx: EvalContext): Outcome1 | null {
  const doc = ctx.document ?? {};
  if (!doc.emergencyDeclared) return null;
  const pct = p.maxIncreasePercent as number;
  if (doc.baselinePriceCents === undefined || doc.totalCents === undefined) {
    return {
      status: "action",
      message: `A declared emergency caps price increases at ${pct}%, but the baseline or total price is missing.`,
      actions: [{ type: "provide_baseline", text: "Enter the price charged before the emergency declaration so the cap can be checked." }],
    };
  }
  const max = Math.floor(doc.baselinePriceCents * (1 + pct / 100));
  if (doc.totalCents > max) {
    return {
      status: "fail",
      message: `${money(doc.totalCents)} exceeds the ${pct}% emergency price cap (maximum ${money(max)} over a ${money(doc.baselinePriceCents)} baseline).`,
      actions: [{ type: "reduce_price", text: `Reduce the total to ${money(max)} or less.` }],
    };
  }
  return { status: "pass", message: `${money(doc.totalCents)} is within the ${pct}% emergency price cap (maximum ${money(max)}).` };
}
