// supabase/functions/_shared/executive-report/period.ts
// Timezone-correct month boundaries + "is this account due" logic.
// Pure functions only (Intl, no network) so they are fully unit-testable.

import type { ReportPeriod } from "./types.ts";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function localParts(instantMs: number, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

function offsetMs(instantMs: number, tz: string): number {
  const p = localParts(instantMs, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instantMs / 1000) * 1000;
}

/** UTC instant (ms) of 00:00 local time on the given calendar date in `tz`. */
export function zonedMidnightUtc(year: number, month: number, day: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function shiftMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12 + 12) % 12 + 1 };
}

function monthRange(y: number, m: number, tz: string) {
  const next = shiftMonth(y, m, 1);
  return {
    start: ymd(y, m, 1),
    end: ymd(y, m, daysIn(y, m)),
    label: `${MONTHS[m - 1]} ${y}`,
    startUtc: new Date(zonedMidnightUtc(y, m, 1, tz)).toISOString(),
    endUtc: new Date(zonedMidnightUtc(next.y, next.m, 1, tz)).toISOString(),
  };
}

/** Period for an explicit "YYYY-MM" (owner's timezone). Returns null if malformed. */
export function periodForMonth(ym: string, tz: string): ReportPeriod | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(ym);
  if (!match || !isValidTimeZone(tz)) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const prev = shiftMonth(y, m, -1);
  return { ...monthRange(y, m, tz), prior: monthRange(prev.y, prev.m, tz) };
}

/** The last fully elapsed calendar month in `tz`, relative to `now`. */
export function previousMonthPeriod(now: Date, tz: string): ReportPeriod {
  const local = localParts(now.getTime(), tz);
  const prev = shiftMonth(local.year, local.month, -1);
  const prior = shiftMonth(prev.y, prev.m, -1);
  return { ...monthRange(prev.y, prev.m, tz), prior: monthRange(prior.y, prior.m, tz) };
}

/**
 * Due once the local clock passes send_day/send_hour of the current month.
 * Staying "due" for the rest of the month makes the sweep self-healing after
 * downtime; the unique (user_id, period_start) row keeps it idempotent.
 */
export function isReportDue(
  s: { enabled: boolean; send_day: number; send_hour: number; timezone: string },
  now: Date,
): boolean {
  if (!s.enabled || !isValidTimeZone(s.timezone)) return false;
  const local = localParts(now.getTime(), s.timezone);
  if (local.day > s.send_day) return true;
  return local.day === s.send_day && local.hour >= s.send_hour;
}
