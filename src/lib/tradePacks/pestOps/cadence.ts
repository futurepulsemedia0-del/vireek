/**
 * Pest Ops — plan cadence + route-day scheduling (pure, no I/O).
 *
 * Dates come from the SAME anchored math the Recurring Jobs engine uses
 * (`occurrenceDate`: start + N·interval, month-end clamped, never "previous + interval"),
 * so a preview here always matches the visits Postgres will generate. On top of that this
 * module adds the pest-specific rules:
 *   - seasonal windows (incl. windows that wrap the new year, e.g. Nov–Mar),
 *   - route weekday rules (shift to the nearest allowed day, never drift the anchor),
 *   - closed dates (holidays / blackout days),
 *   - wall-clock-stable start times across DST (09:00 local stays 09:00 local).
 */

import { isValidISODate, occurrenceDate, zonedToUtcISO, type IntervalUnit } from '@/lib/recurringJobs';
import { applySeason, weekdayOf } from '../framework';

export type PestCadence = 'monthly' | 'bimonthly' | 'quarterly' | 'seasonal' | 'annual';

export interface CadenceDef {
  cadence: PestCadence;
  label: string;
  intervalUnit: IntervalUnit;
  intervalCount: number;
  /** A season window is mandatory. */
  needsSeason: boolean;
}

export const PEST_CADENCES: Record<PestCadence, CadenceDef> = {
  monthly: { cadence: 'monthly', label: 'Monthly', intervalUnit: 'month', intervalCount: 1, needsSeason: false },
  bimonthly: { cadence: 'bimonthly', label: 'Every 2 months', intervalUnit: 'month', intervalCount: 2, needsSeason: false },
  quarterly: { cadence: 'quarterly', label: 'Quarterly', intervalUnit: 'month', intervalCount: 3, needsSeason: false },
  seasonal: { cadence: 'seasonal', label: 'Seasonal (monthly in season)', intervalUnit: 'month', intervalCount: 1, needsSeason: true },
  annual: { cadence: 'annual', label: 'Annual', intervalUnit: 'year', intervalCount: 1, needsSeason: false },
};

export const PEST_CADENCE_KEYS = Object.keys(PEST_CADENCES) as PestCadence[];

export function isPestCadence(v: string): v is PestCadence {
  return Object.prototype.hasOwnProperty.call(PEST_CADENCES, v);
}

export interface Season {
  fromMonth: number;
  toMonth: number;
}

export function isValidSeason(s: Season | undefined | null): s is Season {
  return !!s && Number.isInteger(s.fromMonth) && Number.isInteger(s.toMonth) && s.fromMonth >= 1 && s.fromMonth <= 12 && s.toMonth >= 1 && s.toMonth <= 12;
}

/** Month (1-12) inside the window? Handles wrap-around windows (fromMonth > toMonth). */
export function inSeason(month: number, season: Season): boolean {
  return season.fromMonth <= season.toMonth ? month >= season.fromMonth && month <= season.toMonth : month >= season.fromMonth || month <= season.toMonth;
}

export interface ScheduleInput {
  /** First anchor date, YYYY-MM-DD (tenant-local). */
  startDate: string;
  cadence: PestCadence;
  season?: Season | null;
  /** IANA zone the visit is booked in. */
  timeZone: string;
  /** Wall-clock start, HH:MM. */
  localTime: string;
  /** Allowed weekdays (0 = Sunday). Empty / omitted = any day. */
  routeWeekdays?: number[];
  /** How far (days) a visit may move off its anchor to land on an allowed day. Default 3. */
  maxShiftDays?: number;
  /** YYYY-MM-DD dates nobody works (holidays, blackout). */
  closedDates?: string[];
  /** Inclusive last date; null/omitted = until `limit`. */
  endDate?: string | null;
  /** First occurrence index to emit (default 0). */
  fromN?: number;
  /** Max visits returned (default 12, hard cap 120). */
  limit?: number;
}

export type VisitStatus = 'ok' | 'shifted' | 'needs_attention';

export interface PlannedVisit {
  n: number;
  /** The date the cadence says (never moved). */
  anchorDate: string;
  /** The date to book (== anchorDate unless shifted). */
  date: string;
  startsAtUtc: string;
  shiftedDays: number;
  status: VisitStatus;
  reason?: string;
}

const HARD_LIMIT = 120;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function validateSchedule(input: ScheduleInput): string[] {
  const errors: string[] = [];
  if (!isValidISODate(input.startDate)) errors.push('Start date is not a valid date');
  if (input.endDate && !isValidISODate(input.endDate)) errors.push('End date is not a valid date');
  if (input.endDate && isValidISODate(input.startDate) && input.endDate < input.startDate) errors.push('End date is before the start date');
  if (!isPestCadence(input.cadence)) errors.push('Unknown cadence');
  else if (PEST_CADENCES[input.cadence].needsSeason && !isValidSeason(input.season)) errors.push('A seasonal plan needs a season (from-month and to-month)');
  if (input.season && !isValidSeason(input.season)) errors.push('Season months must be between 1 and 12');
  if (!HHMM.test(input.localTime)) errors.push('Start time must be HH:MM');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone });
  } catch {
    errors.push('Unknown time zone');
  }
  if ((input.routeWeekdays ?? []).some((d) => !Number.isInteger(d) || d < 0 || d > 6)) errors.push('Route weekdays must be 0-6');
  if (input.maxShiftDays !== undefined && (!Number.isInteger(input.maxShiftDays) || input.maxShiftDays < 0 || input.maxShiftDays > 14)) errors.push('Max shift must be 0-14 days');
  return errors;
}

/**
 * Plans the next visits. Throws on invalid input (callers validate first with validateSchedule()).
 * Out-of-season anchors are skipped (their index is consumed, so later visits keep their dates).
 */
export function planVisits(input: ScheduleInput): PlannedVisit[] {
  const errors = validateSchedule(input);
  if (errors.length) throw new Error(errors[0]);

  const def = PEST_CADENCES[input.cadence];
  const season = input.season ?? null;
  const weekdays = new Set(input.routeWeekdays ?? []);
  const closed = new Set(input.closedDates ?? []);
  const maxShift = input.maxShiftDays ?? 3;
  const limit = Math.min(Math.max(input.limit ?? 12, 1), HARD_LIMIT);
  const fromN = Math.max(input.fromN ?? 0, 0);

  // A season window that does not contain the start month begins at its next opening.
  let anchorStart = input.startDate;
  let endDate = input.endDate ?? null;
  if (season) {
    const w = applySeason(input.startDate, season);
    anchorStart = w.start;
    if (!endDate) endDate = w.end;
  }

  const allowed = (date: string): boolean => {
    if (closed.has(date)) return false;
    if (weekdays.size > 0 && !weekdays.has(weekdayOf(date))) return false;
    if (season && !inSeason(Number(date.slice(5, 7)), season)) return false;
    if (endDate && date > endDate) return false;
    return true;
  };

  const out: PlannedVisit[] = [];
  for (let n = fromN; out.length < limit && n < fromN + 600; n += 1) {
    const anchorDate = occurrenceDate(anchorStart, def.intervalUnit, def.intervalCount, n);
    if (endDate && anchorDate > endDate) break;
    if (season && !inSeason(Number(anchorDate.slice(5, 7)), season)) continue;

    // 0, +1…+max, then −1…−max: prefer a later day, fall back to an earlier one.
    const offsets = [0];
    for (let k = 1; k <= maxShift; k += 1) offsets.push(k);
    for (let k = 1; k <= maxShift; k += 1) offsets.push(-k);
    const hit = offsets.find((o) => allowed(addDays(anchorDate, o)));

    if (hit === undefined) {
      out.push({
        n,
        anchorDate,
        date: anchorDate,
        startsAtUtc: zonedToUtcISO(anchorDate, input.localTime, input.timeZone),
        shiftedDays: 0,
        status: 'needs_attention',
        reason: `No allowed route day within ${maxShift} day(s) of ${anchorDate}`,
      });
      continue;
    }
    const date = addDays(anchorDate, hit);
    out.push({
      n,
      anchorDate,
      date,
      startsAtUtc: zonedToUtcISO(date, input.localTime, input.timeZone),
      shiftedDays: hit,
      status: hit === 0 ? 'ok' : 'shifted',
    });
  }
  return out;
}

/** Visits a full term should contain (used for renewal pricing / expectations). */
export function expectedVisitsPerTerm(cadence: PestCadence, season: Season | null | undefined, termMonths = 12): number {
  const def = PEST_CADENCES[cadence];
  if (def.intervalUnit === 'year') return Math.max(Math.floor(termMonths / 12), 1);
  if (cadence === 'seasonal' && season) {
    const months = season.fromMonth <= season.toMonth ? season.toMonth - season.fromMonth + 1 : 12 - season.fromMonth + 1 + season.toMonth;
    return months;
  }
  return Math.floor(termMonths / def.intervalCount);
}
