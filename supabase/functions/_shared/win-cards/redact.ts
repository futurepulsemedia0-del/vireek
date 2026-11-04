// supabase/functions/_shared/win-cards/redact.ts
//
// Privacy core. Everything public is built here from FIXED templates + rounded values, then every
// string is scanned for PII before it can be frozen. Pure; runs in Deno and Node.

import type { PrivateFacts, PublicFields, Selection, ValueBasis } from "./types.ts";

// ---------------------------------------------------------------- money

/** Step used to round DOWN a value so a card can never overstate it. */
function stepFor(cents: number): number {
  const dollars = cents / 100;
  if (dollars < 1_000) return 100;
  if (dollars < 10_000) return 500;
  if (dollars < 100_000) return 1_000;
  return 10_000;
}

const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

export interface RoundedValue {
  text: string;
  isEstimate: boolean;
}

/**
 * Rounds DOWN, never up.
 *  - collected / invoiced  → "Over $4,000"
 *  - estimate              → "Estimated $4,000–$4,500" (range whose upper edge is one step above the floor)
 * Returns null when the value is missing/zero/non-finite (the card then shows no number at all).
 */
export function roundValue(cents: number | undefined | null, basis: ValueBasis | undefined): RoundedValue | null {
  if (typeof cents !== "number" || !Number.isFinite(cents) || cents <= 0) return null;
  const step = stepFor(cents);
  const dollars = cents / 100;
  const floor = Math.floor(dollars / step) * step;
  if (floor <= 0) return null; // under the smallest step: say nothing rather than inflate
  if (basis === "estimate") return { text: `Estimated ${usd(floor)}–${usd(floor + step)}`, isEstimate: true };
  return { text: `Over ${usd(floor)}`, isEstimate: false };
}

// ---------------------------------------------------------------- time

export type TimeBucket = "overnight" | "early morning" | "evening" | "weekend" | "business hours";

export function zonedParts(iso: string, timeZone: string): { hour: number; weekday: number; year: number; month: number } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error("invalid date");
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "numeric", hourCycle: "h23", weekday: "short", year: "numeric", month: "numeric",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday));
  return { hour: Number(parts.hour) % 24, weekday: wd, year: Number(parts.year), month: Number(parts.month) };
}

export function timeBucket(iso: string, tz: string, hoursStart: number, hoursEnd: number): TimeBucket {
  const { hour, weekday } = zonedParts(iso, tz);
  if (weekday === 0 || weekday === 6) return "weekend";
  if (hour >= hoursStart && hour < hoursEnd) return "business hours";
  if (hour >= 22 || hour < 5) return "overnight";
  if (hour < hoursStart) return "early morning";
  return "evening";
}

export const isAfterHours = (iso: string, tz: string, s: number, e: number) => timeBucket(iso, tz, s, e) !== "business hours";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function monthText(iso: string, tz: string): string {
  const { year, month } = zonedParts(iso, tz);
  return `${MONTHS[month - 1]} ${year}`;
}

/** Speed shown as a ceiling band, never the exact figure: "under 30 seconds", "under 2 minutes". */
export function speedBand(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = ms / 1000;
  if (s <= 10) return "under 10 seconds";
  if (s <= 30) return "under 30 seconds";
  if (s <= 60) return "under a minute";
  if (s <= 120) return "under 2 minutes";
  if (s <= 300) return "under 5 minutes";
  return null; // not a brag-worthy number; no card text for it
}

// ---------------------------------------------------------------- PII scanning

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\s().-]?){7,}/;                       // 7+ digits with optional separators
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;
const STREET_RE = /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,3}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|way|pl|place|pkwy|parkway|hwy|highway)\b\.?/i;
const EXACT_TIME_RE = /\b\d{1,2}:\d{2}\s?(?:[ap]\.?m\.?)?\b|\b\d{1,2}\s?(?:[ap]\.?m\.?)\b/i;
const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;
const IP_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;

export type PiiFinding = { kind: string; sample: string };

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

/** Returns every reason `text` is unsafe to publish. Empty array = clean. */
export function findPii(text: string, privateTerms: readonly string[] = []): PiiFinding[] {
  const out: PiiFinding[] = [];
  const push = (kind: string, m: RegExpExecArray | null) => m && out.push({ kind, sample: m[0].slice(0, 24) });
  push("email", EMAIL_RE.exec(text));
  push("phone", PHONE_RE.exec(text));
  push("url", URL_RE.exec(text));
  push("street_address", STREET_RE.exec(text));
  push("exact_time", EXACT_TIME_RE.exec(text));
  push("zip", ZIP_RE.exec(text));
  push("ip", IP_RE.exec(text));

  const haystack = ` ${norm(text)} `;
  const digitsOnly = text.replace(/\D/g, "");
  for (const raw of privateTerms) {
    if (!raw) continue;
    const term = norm(raw);
    if (term.length >= 3 && haystack.includes(` ${term} `)) out.push({ kind: "private_term", sample: "[redacted]" });
    // Every individual word of a multi-word private term (first name / last name / street name).
    for (const w of term.split(" ")) if (w.length >= 3 && haystack.includes(` ${w} `)) out.push({ kind: "private_term_word", sample: "[redacted]" });
    const d = raw.replace(/\D/g, "");
    if (d.length >= 7 && digitsOnly.includes(d)) out.push({ kind: "private_number", sample: "[redacted]" });
  }
  return out;
}

/** Walks a value and returns every PII finding in any string anywhere inside it. */
export function scanDeep(value: unknown, privateTerms: readonly string[]): PiiFinding[] {
  if (typeof value === "string") return findPii(value, privateTerms);
  if (Array.isArray(value)) return value.flatMap((v) => scanDeep(v, privateTerms));
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap((v) => scanDeep(v, privateTerms));
  return [];
}

/** Public strings legitimately contain a rounded dollar figure and a month, so those are allow-listed here. */
function scanPublicString(s: string, terms: readonly string[]): PiiFinding[] {
  return findPii(s, terms).filter((f) => !(f.kind === "zip" && /^\$|^Over \$|^Estimated \$/.test(s)));
}

/** The raw figure must not appear anywhere unless it IS the rounded floor (e.g. exactly $4,000). */
export function leaksRawValue(pub: PublicFields, facts: PrivateFacts): boolean {
  if (!facts.valueCents || facts.valueCents <= 0) return false;
  const raw = facts.valueCents / 100;
  const rounded = roundValue(facts.valueCents, facts.valueBasis);
  const shown = JSON.stringify(pub);
  const exactForms = [usd(raw), String(Math.round(raw)), raw.toFixed(2)];
  for (const f of exactForms) {
    if (!shown.includes(f)) continue;
    if (rounded && rounded.text.includes(f)) continue; // the rounded figure legitimately equals the raw one
    return true;
  }
  return false;
}

export class RedactionError extends Error {
  findings: PiiFinding[];
  constructor(findings: PiiFinding[], message = "REDACTION_FAILED") {
    super(message);
    this.findings = findings;
  }
}

/** Throws RedactionError if ANY public string leaks PII, an exact time, or the unrounded value. */
export function assertPublicSafe(pub: PublicFields, facts: PrivateFacts): void {
  const findings: PiiFinding[] = [];
  for (const [k, v] of Object.entries(pub)) {
    if (typeof v === "string") findings.push(...scanPublicString(v, facts.pii));
    else if (k !== "v") findings.push(...scanDeep(v, facts.pii));
  }
  if (leaksRawValue(pub, facts)) findings.push({ kind: "raw_value", sample: "[redacted]" });
  if (findings.length) throw new RedactionError(findings);
}

// ---------------------------------------------------------------- text sanitising

/** Collapses whitespace, strips control/zero-width/bidi characters and HTML-ish brackets. */
export function cleanText(s: string, max: number): string {
  return s
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const HYPE_RE = /(?:!{2,}|\b(?:best ever|game[- ]?chang\w*|revolution\w*|insane|crush(?:ed|ing)?|10x|unbelievable|guaranteed|never miss)\b)/i;
export const isHype = (s: string) => HYPE_RE.test(s);

// ---------------------------------------------------------------- headline templates (fixed, no free text)

export interface HeadlineInput {
  facts: PrivateFacts;
  bucket: TimeBucket | null;
}

export function headlineFor(facts: PrivateFacts): { headline: string; detail: string | null } {
  switch (facts.trigger) {
    case "after_hours_booking":
      return { headline: "A call after hours became a booked job.", detail: "The call was answered and scheduled without anyone being on the clock." };
    case "emergency_handled":
      return { headline: "An emergency call was handled and booked.", detail: "The caller reached a response right away instead of voicemail." };
    case "recovered_large_job":
      return { headline: "A missed call turned into a larger job.", detail: "The caller was followed up with and the work was won back." };
    case "milestone_calls": {
      const n = facts.milestone ?? 0;
      return { headline: `${n.toLocaleString("en-US")} calls answered.`, detail: "A milestone for the team and the customers who called." };
    }
    case "speed_to_lead_record": {
      const band = speedBand(facts.responseMs ?? Number.NaN);
      return { headline: "A new personal best for response time.", detail: band ? `A new lead was reached in ${band}.` : null };
    }
    case "five_star_ai_job":
      return { headline: "A 5-star review from a job booked by phone assistant.", detail: "The customer's first contact was an answered call." };
  }
}

export const ESTIMATE_DISCLAIMER = "Figures are rounded down. Anything marked “Estimated” is an estimate, not a guarantee.";

// ---------------------------------------------------------------- the single entry point

export interface BuildInput {
  facts: PrivateFacts;
  selection: Selection;
  settings: { timezone: string; businessHoursStart: number; businessHoursEnd: number };
  businessName: string | null; // from profiles.company_name; only used when selection.showBusinessName
}

/**
 * Builds the ONLY object that may ever be public. Deny-by-default: every optional field is off unless the
 * owner turned it on, and every string is PII-scanned before returning.
 */
export function buildPublicFields(inp: BuildInput): PublicFields {
  const { facts, selection, settings } = inp;
  const { headline, detail } = headlineFor(facts);

  let valueText: string | null = null;
  let valueIsEstimate = false;
  if (selection.showValue) {
    const r = roundValue(facts.valueCents, facts.valueBasis);
    if (r) { valueText = r.text; valueIsEstimate = r.isEstimate; }
  }

  let timeBucketText: string | null = null;
  if (selection.showTimeBucket) {
    const b = timeBucket(facts.occurredAt, settings.timezone, settings.businessHoursStart, settings.businessHoursEnd);
    timeBucketText = b === "business hours" ? null : b === "weekend" ? "On a weekend" : `${b[0].toUpperCase()}${b.slice(1)}`;
  }

  const serviceText = selection.serviceLabel ? cleanText(selection.serviceLabel, 40) || null : null;
  const caption = selection.caption ? cleanText(selection.caption, 280) || null : null;

  const pub: PublicFields = {
    v: 1,
    trigger: facts.trigger,
    headline,
    detail,
    valueText,
    valueIsEstimate,
    timeBucketText,
    serviceText,
    monthText: selection.showMonth ? monthText(facts.occurredAt, settings.timezone) : null,
    businessName: selection.showBusinessName && inp.businessName ? cleanText(inp.businessName, 80) : null,
    showCta: selection.showCta,
    disclaimer: valueText ? ESTIMATE_DISCLAIMER : null,
    caption,
  };

  // Owner-typed free text must pass the hype and PII gates.
  if (pub.caption && isHype(pub.caption)) throw new RedactionError([{ kind: "hype", sample: "caption" }], "HYPE_REJECTED");
  // businessName is the owner's own public brand: exempt it from the deny-list but never from format checks.
  const facts2: PrivateFacts = { ...facts, pii: facts.pii.filter((t) => norm(t) !== norm(inp.businessName ?? "")) };
  assertPublicSafe({ ...pub, businessName: null }, facts2);
  if (pub.businessName && (EMAIL_RE.test(pub.businessName) || PHONE_RE.test(pub.businessName) || URL_RE.test(pub.businessName))) {
    throw new RedactionError([{ kind: "business_name_contact", sample: "[redacted]" }]);
  }
  return pub;
}
