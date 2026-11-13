/**
 * Landscaping pack — pure calendar helpers.
 *
 * No imports from the app, no DOM, no Node/Deno APIs: this file is imported by the browser
 * AND by the landscaping-cron edge function (hence the explicit `.ts` import style used
 * across this folder). All dates are plain `YYYY-MM-DD` strings and all math is done in UTC,
 * so results never depend on the machine's timezone.
 *
 * Holiday sets are a SCHEDULING convenience (“don't mow on Thanksgiving”), not legal advice
 * about working-day rules. Tenants can add their own dates.
 */

export type ISODate = string;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidISODate(v: unknown): v is ISODate {
  if (typeof v !== 'string') return false;
  const m = ISO.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function parts(iso: ISODate): [number, number, number] {
  const m = ISO.exec(iso);
  if (!m || !isValidISODate(iso)) throw new Error(`Invalid date: ${String(iso)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const pad = (n: number) => String(n).padStart(2, '0');

export function toISO(y: number, month1: number, d: number): ISODate {
  return `${String(y).padStart(4, '0')}-${pad(month1)}-${pad(d)}`;
}

function fromUTC(ms: number): ISODate {
  const dt = new Date(ms);
  return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(iso: ISODate, n: number): ISODate {
  const [y, m, d] = parts(iso);
  return fromUTC(Date.UTC(y, m - 1, d + n));
}

/** Whole days from a to b (b − a); negative when b is earlier. */
export function daysBetween(a: ISODate, b: ISODate): number {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(iso: ISODate): number {
  const [y, m, d] = parts(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function monthOf(iso: ISODate): number {
  return parts(iso)[1];
}

export function yearOf(iso: ISODate): number {
  return parts(iso)[0];
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** nth (1-based) given weekday of a month. */
function nthWeekday(year: number, month1: number, weekday: number, n: number): ISODate {
  const first = new Date(Date.UTC(year, month1 - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return toISO(year, month1, day);
}

function lastWeekday(year: number, month1: number, weekday: number): ISODate {
  const last = daysInMonth(year, month1);
  const lastDow = new Date(Date.UTC(year, month1 - 1, last)).getUTCDay();
  return toISO(year, month1, last - ((lastDow - weekday + 7) % 7));
}

/** Fixed-date holiday: Saturday → Friday before, Sunday → Monday after. */
function observed(year: number, month1: number, day: number): ISODate {
  const iso = toISO(year, month1, day);
  const dow = weekdayOf(iso);
  return dow === 6 ? addDays(iso, -1) : dow === 0 ? addDays(iso, 1) : iso;
}

export type HolidaySet = 'none' | 'us_core';

/**
 * Six days landscape crews commonly don't work, as observed dates.
 * `us_core`: New Year's Day, Memorial Day, Independence Day, Labor Day, Thanksgiving, Christmas.
 */
export function holidaysForYear(year: number, set: HolidaySet): Record<ISODate, string> {
  if (set === 'none') return {};
  return {
    [observed(year, 1, 1)]: "New Year's Day",
    [lastWeekday(year, 5, 1)]: 'Memorial Day',
    [observed(year, 7, 4)]: 'Independence Day',
    [nthWeekday(year, 9, 1, 1)]: 'Labor Day',
    [nthWeekday(year, 11, 4, 4)]: 'Thanksgiving',
    [observed(year, 12, 25)]: 'Christmas Day',
  };
}

/**
 * Holiday lookup for a date range. Looks one year either side because an observed date can fall
 * in the neighbouring year (Jan 1 on a Saturday is observed on Dec 31).
 * `extra` are tenant-specific closure dates (invalid entries are ignored).
 */
export function buildHolidayLookup(from: ISODate, to: ISODate, set: HolidaySet, extra: readonly string[] = []): (iso: ISODate) => string | null {
  const map = new Map<ISODate, string>();
  for (let y = yearOf(from) - 1; y <= yearOf(to) + 1; y += 1) {
    for (const [d, name] of Object.entries(holidaysForYear(y, set))) map.set(d, name);
  }
  for (const d of extra) if (isValidISODate(d)) map.set(d, 'Company closure');
  return (iso) => map.get(iso) ?? null;
}

/** Is `month` (1-12) inside [from, to]? A window like Nov→Mar wraps around the new year. */
export function monthInWindow(month: number, fromMonth: number, toMonth: number): boolean {
  return fromMonth <= toMonth ? month >= fromMonth && month <= toMonth : month >= fromMonth || month <= toMonth;
}

/** Next working day strictly after `iso` that is not a holiday. Bounded; returns null if none within `maxDays`. */
export function nextWorkday(iso: ISODate, workdays: readonly number[], isHoliday: (d: ISODate) => string | null, maxDays = 7, direction: 1 | -1 = 1): ISODate | null {
  for (let i = 1; i <= maxDays; i += 1) {
    const d = addDays(iso, i * direction);
    if (workdays.includes(weekdayOf(d)) && !isHoliday(d)) return d;
  }
  return null;
}
