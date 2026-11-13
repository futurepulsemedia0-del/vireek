/**
 * Landscaping pack — recurring maintenance-contract visit generation (pure).
 *
 * KEEP IN SYNC with public.landscape_plan_visits() in
 * supabase/migrations/20290301000000_landscaping_pack.sql (the database is the source of truth
 * for what actually gets created; this mirror powers previews and is pinned by recurrence.test.ts).
 *
 * Model
 *  - Visit N falls on  startDate + 7·N days  (always computed from the anchor, never “previous + interval”,
 *    so a holiday shift never drifts later visits).
 *  - A visit exists only when its ORIGINAL date lies in a season and N is a multiple of that season's
 *    `intervalWeeks` (weekly = 1, biweekly = 2 …). Seasons may wrap the new year (Nov → Mar).
 *  - Holidays: ignore | skip | shift to the next / previous working day (never past the next visit).
 *  - Pause windows: no visit, no billing. Skipped visits are still returned so the UI can explain them.
 *  - Times are wall-clock in the contract's timezone and converted to UTC DST-correctly.
 *    `preferredTime` is limited to 05:00–20:59 so the twice-a-year DST gap/overlap hours never apply.
 */

import {
  addDays,
  buildHolidayLookup,
  daysBetween,
  isValidISODate,
  monthInWindow,
  monthOf,
  nextWorkday,
  type HolidaySet,
  type ISODate,
} from './calendar.ts';

export interface SeasonRule {
  fromMonth: number;
  toMonth: number;
  intervalWeeks: number;
}

export type HolidayPolicy = 'shift_next' | 'shift_prev' | 'skip' | 'ignore';

export interface PauseWindow {
  from: ISODate;
  /** Inclusive; null = paused until resumed. */
  to: ISODate | null;
}

export interface ContractSchedule {
  startDate: ISODate;
  endDate: ISODate | null;
  seasons: SeasonRule[];
  holidayPolicy: HolidayPolicy;
  holidaySet: HolidaySet;
  extraHolidays: string[];
  /** 0 = Sunday … 6 = Saturday; used only when shifting around a holiday. */
  workdays: number[];
  pauses: PauseWindow[];
  /** HH:MM wall-clock start in `timezone`. */
  preferredTime: string;
  timezone: string;
}

export type SkipReason = 'holiday' | 'paused' | 'contract_ended';

export interface PlannedVisit {
  /** Stable occurrence index (weeks since startDate). Unique per contract → the idempotency key. */
  n: number;
  originalDate: ISODate;
  date: ISODate;
  status: 'scheduled' | 'skipped';
  reason: SkipReason | null;
  holidayName: string | null;
  shifted: boolean;
  intervalWeeks: number;
}

export const MAX_SEASONS = 4;
export const MAX_INTERVAL_WEEKS = 4;
export const MAX_WINDOW_DAYS = 400;
export const DEFAULT_SEASONS: SeasonRule[] = [{ fromMonth: 1, toMonth: 12, intervalWeeks: 1 }];
export const MON_FRI = [1, 2, 3, 4, 5];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Human-readable problems; empty = valid. */
export function validateSchedule(s: ContractSchedule): string[] {
  const e: string[] = [];
  if (!isValidISODate(s.startDate)) e.push('Start date is invalid');
  if (s.endDate !== null && !isValidISODate(s.endDate)) e.push('End date is invalid');
  if (isValidISODate(s.startDate) && s.endDate && isValidISODate(s.endDate) && s.endDate < s.startDate) e.push('End date must be on or after the start date');
  if (!Array.isArray(s.seasons) || s.seasons.length < 1 || s.seasons.length > MAX_SEASONS) {
    e.push(`Add between 1 and ${MAX_SEASONS} seasons`);
  } else {
    const used = new Set<number>();
    for (const r of s.seasons) {
      if (![r.fromMonth, r.toMonth].every((m) => Number.isInteger(m) && m >= 1 && m <= 12)) e.push('Season months must be 1–12');
      if (!Number.isInteger(r.intervalWeeks) || r.intervalWeeks < 1 || r.intervalWeeks > MAX_INTERVAL_WEEKS) e.push(`Visit interval must be 1–${MAX_INTERVAL_WEEKS} weeks`);
      for (let m = 1; m <= 12; m += 1) {
        if (monthInWindow(m, r.fromMonth, r.toMonth)) {
          if (used.has(m)) e.push('Seasons cannot overlap');
          used.add(m);
        }
      }
    }
  }
  if (!['shift_next', 'shift_prev', 'skip', 'ignore'].includes(s.holidayPolicy)) e.push('Unknown holiday policy');
  if (!Array.isArray(s.workdays) || s.workdays.length === 0 || s.workdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) e.push('Choose at least one working day');
  if (!TIME_RE.test(s.preferredTime) || Number(s.preferredTime.slice(0, 2)) < 5 || Number(s.preferredTime.slice(0, 2)) > 20) e.push('Start time must be between 05:00 and 20:59');
  if (!isValidTimeZone(s.timezone)) e.push('Unknown timezone');
  for (const p of s.pauses ?? []) {
    if (!isValidISODate(p.from) || (p.to !== null && !isValidISODate(p.to))) e.push('Pause dates are invalid');
    else if (p.to !== null && p.to < p.from) e.push('A pause must end on or after it starts');
  }
  return [...new Set(e)];
}

export function seasonFor(month: number, seasons: readonly SeasonRule[]): SeasonRule | null {
  return seasons.find((r) => monthInWindow(month, r.fromMonth, r.toMonth)) ?? null;
}

export function isPaused(date: ISODate, pauses: readonly PauseWindow[]): boolean {
  return pauses.some((p) => date >= p.from && (p.to === null || date <= p.to));
}

/**
 * Visits whose ORIGINAL date lies in [from, to] (inclusive). Throws on an invalid schedule or a
 * window longer than MAX_WINDOW_DAYS — callers always work in bounded look-ahead windows.
 */
export function planVisits(schedule: ContractSchedule, window: { from: ISODate; to: ISODate }): PlannedVisit[] {
  const problems = validateSchedule(schedule);
  if (problems.length) throw new Error(`Invalid schedule: ${problems.join('; ')}`);
  if (!isValidISODate(window.from) || !isValidISODate(window.to) || window.to < window.from) throw new Error('Invalid window');
  if (daysBetween(window.from, window.to) > MAX_WINDOW_DAYS) throw new Error('Window too long');

  const isHoliday = buildHolidayLookup(window.from < schedule.startDate ? window.from : schedule.startDate, window.to, schedule.holidaySet, schedule.extraHolidays);
  const out: PlannedVisit[] = [];
  const first = Math.max(0, Math.floor(daysBetween(schedule.startDate, window.from) / 7));

  for (let n = first; n <= first + Math.ceil(MAX_WINDOW_DAYS / 7) + 2; n += 1) {
    const originalDate = addDays(schedule.startDate, n * 7);
    if (originalDate > window.to) break;
    if (originalDate < window.from) continue;
    if (schedule.endDate && originalDate > schedule.endDate) break;

    const season = seasonFor(monthOf(originalDate), schedule.seasons);
    if (!season || n % season.intervalWeeks !== 0) continue;

    const base = { n, originalDate, intervalWeeks: season.intervalWeeks };
    if (isPaused(originalDate, schedule.pauses)) {
      out.push({ ...base, date: originalDate, status: 'skipped', reason: 'paused', holidayName: null, shifted: false });
      continue;
    }

    const holidayName = isHoliday(originalDate);
    let date = originalDate;
    let shifted = false;
    if (holidayName && schedule.holidayPolicy !== 'ignore') {
      if (schedule.holidayPolicy === 'skip') {
        out.push({ ...base, date: originalDate, status: 'skipped', reason: 'holiday', holidayName, shifted: false });
        continue;
      }
      // Never shift into (or past) the neighbouring visit: stay within the cadence gap.
      const maxShift = Math.min(6, season.intervalWeeks * 7 - 1);
      const moved = nextWorkday(originalDate, schedule.workdays, isHoliday, maxShift, schedule.holidayPolicy === 'shift_next' ? 1 : -1);
      if (!moved) {
        out.push({ ...base, date: originalDate, status: 'skipped', reason: 'holiday', holidayName, shifted: false });
        continue;
      }
      date = moved;
      shifted = true;
    }

    if (schedule.endDate && date > schedule.endDate) {
      out.push({ ...base, date, status: 'skipped', reason: 'contract_ended', holidayName, shifted });
    } else if (isPaused(date, schedule.pauses)) {
      out.push({ ...base, date, status: 'skipped', reason: 'paused', holidayName, shifted });
    } else {
      out.push({ ...base, date, status: 'scheduled', reason: null, holidayName, shifted });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Time zones (self-contained so the edge runtime can import this file) */
/* ------------------------------------------------------------------ */

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock date + `HH:MM` in `timeZone` → UTC ISO string (DST-aware; same result as `(date + time) AT TIME ZONE tz`). */
export function scheduledUtc(date: ISODate, time: string, timeZone: string): string {
  const tm = TIME_RE.exec(time);
  if (!isValidISODate(date) || !tm) throw new Error('Invalid date or time');
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, Number(tm[1]), Number(tm[2]));
  let utc = wall - tzOffsetMs(wall, timeZone);
  utc = wall - tzOffsetMs(utc, timeZone); // second pass settles dates next to a DST change
  return new Date(utc).toISOString();
}

/** First `limit` scheduled (not skipped) visits on/after `from` — for the contract preview. */
export function previewVisits(schedule: ContractSchedule, from: ISODate, limit = 8): PlannedVisit[] {
  const out: PlannedVisit[] = [];
  let cursor = from;
  for (let i = 0; i < 6 && out.length < limit; i += 1) {
    const to = addDays(cursor, 120);
    for (const v of planVisits(schedule, { from: cursor, to })) if (v.status === 'scheduled' && out.length < limit) out.push(v);
    cursor = addDays(to, 1);
    if (schedule.endDate && cursor > schedule.endDate) break;
  }
  return out;
}
