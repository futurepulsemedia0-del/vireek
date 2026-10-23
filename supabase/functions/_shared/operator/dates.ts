// supabase/functions/_shared/operator/dates.ts
//
// Pure, timezone-correct date helpers. All "day" logic runs in the BUSINESS
// timezone (never the server's), and a job keeps its local wall-clock time
// when it moves to another day (DST-safe).

import { WEEKDAYS, type DateSpec } from "./types.ts";

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = ISO_DATE_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function isHHMM(v: unknown): v is string {
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

interface Parts { y: number; m: number; d: number; h: number; mi: number }

function zonedParts(ms: number, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const get: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") get[p.type] = Number(p.value);
  return { y: get.year, m: get.month, d: get.day, h: get.hour % 24, mi: get.minute };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The business-local calendar date ("YYYY-MM-DD") of an instant. */
export function localDate(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** The business-local time of day ("HH:MM") of an instant. */
export function localTime(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function daysBetween(from: string, to: string): number {
  const [a, b] = [from, to].map((s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  });
  return Math.round((b - a) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday */
export function weekdayIndex(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function offsetMs(ms: number, tz: string): number {
  const base = Math.floor(ms / 60_000) * 60_000;
  const p = zonedParts(base, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - base;
}

/** UTC instant for a local wall-clock time in `tz` (handles DST; a skipped hour rolls forward). */
export function zonedToUtcMs(date: string, hhmm: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const o1 = offsetMs(guess, tz);
  let t = guess - o1;
  const o2 = offsetMs(t, tz);
  if (o2 !== o1) t = guess - o2;
  return t;
}

/** [start, end) of a local calendar day, as UTC ms. */
export function dayBoundsUtc(date: string, tz: string): { startMs: number; endMs: number } {
  return { startMs: zonedToUtcMs(date, "00:00", tz), endMs: zonedToUtcMs(addDays(date, 1), "00:00", tz) };
}

export type ResolvedDate = { ok: true; date: string } | { ok: false; error: string };

/**
 * Resolve a DateSpec to a concrete local date.
 *  - without `anchor`: weekday = nearest such day on/after today ("this"/omitted); "next" = that + 7 days
 *  - with `anchor` (used for a destination): weekday = first such day STRICTLY after the anchor
 * The preview always shows the concrete date, so the owner confirms it before anything runs.
 */
export function resolveDateSpec(spec: DateSpec, today: string, anchor?: string): ResolvedDate {
  if (typeof spec === "string") {
    if (spec === "today") return { ok: true, date: today };
    if (spec === "tomorrow") return { ok: true, date: addDays(today, 1) };
    if (isIsoDate(spec)) return { ok: true, date: spec };
    return { ok: false, error: "Unrecognised date." };
  }
  const idx = WEEKDAYS.indexOf(spec.weekday);
  if (idx < 0) return { ok: false, error: "Unrecognised weekday." };
  if (anchor) {
    const delta = ((idx - weekdayIndex(anchor) + 6) % 7) + 1; // 1..7, strictly after
    return { ok: true, date: addDays(anchor, delta) };
  }
  const delta = (idx - weekdayIndex(today) + 7) % 7; // 0..6, on/after today
  return { ok: true, date: addDays(today, delta + (spec.when === "next" ? 7 : 0)) };
}

/** Move an instant to another local day, keeping the local time of day (or using `toTime`). */
export function shiftToDate(iso: string, toDate: string, tz: string, toTime?: string | null): string {
  const ms = Date.parse(iso);
  const time = toTime && isHHMM(toTime) ? toTime : localTime(ms, tz);
  return new Date(zonedToUtcMs(toDate, time, tz)).toISOString();
}

/** "Wed, Oct 28" in the business timezone (English; used in previews and SMS). */
export function formatDay(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(new Date(ms));
}

/** "9:00 AM" in the business timezone. */
export function formatClock(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}
