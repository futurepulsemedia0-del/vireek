// supabase/functions/_shared/business-brain/util.ts
//
// Small, dependency-free helpers shared by the Business Brain modules.
// Everything here is pure and unit-testable.

import type { LineItem } from "./types.ts";

// ---------------------------------------------------------------------
// Numbers / text
// ---------------------------------------------------------------------

export function round(n: number, decimals = 0): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export function sum(values: number[]): number {
  let t = 0;
  for (const v of values) t += v;
  return t;
}

export function mean(values: number[]): number | null {
  return values.length ? sum(values) / values.length : null;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function pct(part: number, whole: number, decimals = 1): number | null {
  return whole > 0 ? round((part / whole) * 100, decimals) : null;
}

/** Persian (U+06F0..F9) and Arabic-Indic (U+0660..69) digits -> ASCII. */
export function normalizeDigits(input: string): string {
  return input
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/**
 * Strips control characters, backticks and newlines and truncates. Used on
 * every free-text value (customer names, notes) that ends up inside the
 * LLM prompt, so stored text can never break the prompt structure.
 */
export function safeText(value: unknown, max = 60): string {
  const s = String(value ?? "")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function usd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

// ---------------------------------------------------------------------
// Dates — all "which day is this?" logic goes through the business
// time zone, never the server's.
// ---------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function validTimeZone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** 'YYYY-MM-DD' of an instant in the given time zone. */
export function dayKey(input: Date | string, timeZone: string): string {
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return "";
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f.format(d);
}

function keyToDate(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

export function addDays(key: string, n: number): string {
  const d = keyToDate(key);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(key: string): number {
  return keyToDate(key).getUTCDay(); // 0 = Sunday
}

export function mondayOf(key: string): string {
  const wd = weekdayOf(key);
  return addDays(key, -((wd + 6) % 7));
}

export function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((keyToDate(toKey).getTime() - keyToDate(fromKey).getTime()) / 86400000);
}

export function prevMonthStart(key: string): string {
  const d = keyToDate(key);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

export function monthEnd(startKey: string): string {
  const d = keyToDate(startKey);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** 'Oct 2' — deliberately not digit-run shaped (see PII redaction note in the edge function). */
export function prettyDay(key: string): string {
  const d = keyToDate(key);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function ageDays(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : (now.getTime() - t) / 86400000;
}

// ---------------------------------------------------------------------
// Money in quotes / invoices
// ---------------------------------------------------------------------

export function lineItemsTotalDollars(items: LineItem[] | null, taxPercent: number | null): number {
  if (!Array.isArray(items)) return 0;
  let cents = 0;
  for (const li of items) {
    const q = Number(li?.quantity ?? 1);
    const p = Number(li?.unit_price_cents ?? 0);
    if (Number.isFinite(q) && Number.isFinite(p)) cents += q * p;
  }
  const tax = Number(taxPercent ?? 0);
  return (cents * (1 + (Number.isFinite(tax) ? tax : 0) / 100)) / 100;
}

// ---------------------------------------------------------------------
// Trade classification (service_type is free text in Vireek)
// ---------------------------------------------------------------------

const TRADE_KEYWORDS: Record<string, RegExp> = {
  hvac: /hvac|heat(ing)?\b|furnace|\bac\b|a\/c|air.?con|cooling|heat ?pump|boiler|duct|thermostat|refrigerant|compressor|condenser/i,
  plumbing: /plumb|leak|drain|pipe|water ?heater|toilet|faucet|sewer|clog|sump|garbage ?disposal/i,
  electrical: /electric|wiring|outlet|breaker|panel|circuit|lighting|generator|ev ?charger/i,
  roofing: /roof|shingle|gutter|flashing/i,
  cleaning: /clean|maid|janitor|carpet|pressure ?wash|window ?wash/i,
  landscaping: /landscap|lawn|tree|irrigation|sprinkler|mow/i,
};

export function tradeOf(text: string | null | undefined): string {
  const s = text ?? "";
  for (const [trade, re] of Object.entries(TRADE_KEYWORDS)) if (re.test(s)) return trade;
  return "other";
}

export function isKnownTrade(t: string | null): t is string {
  return !!t && t in TRADE_KEYWORDS;
}
