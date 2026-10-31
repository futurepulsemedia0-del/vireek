/* ------------------------------------------------------------------ */
/*  timezone — DST-safe helpers for schedules, appointments, reports   */
/*                                                                      */
/*  Pure module (no app imports) so it is trivially testable.           */
/*  Policy: instants are always UTC (ISO strings in the database);      */
/*  "wall time in a zone" is converted with zonedWallTimeToInstant().   */
/*  Never add 24h * N to a Date to move "N days" — use addZonedDays().  */
/* ------------------------------------------------------------------ */

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

/** Wall-clock fields of `instant` as seen in `timeZone`. */
export function wallTimeIn(instant: Date, timeZone: string): WallTime {
  const p: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour === 24 ? 0 : p.hour,
    minute: p.minute,
    second: p.second,
  };
}

/** UTC offset of `timeZone` at `instant`, in minutes east of UTC. */
export function offsetMinutesAt(instant: Date, timeZone: string): number {
  const w = wallTimeIn(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60_000);
}

export type Disambiguation = 'earlier' | 'later';

/**
 * Wall-clock time in `timeZone` → UTC instant.
 *  - Ambiguous time (clocks go back, the hour happens twice): `earlier` (default) or `later`.
 *  - Non-existent time (clocks go forward, e.g. 02:30 never happens): moves forward
 *    by the gap, matching the "compatible" rule used by JS Temporal and most calendars.
 */
export function zonedWallTimeToInstant(
  wall: Omit<WallTime, 'second'> & { second?: number },
  timeZone: string,
  disambiguation: Disambiguation = 'earlier',
): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second ?? 0);
  const before = offsetMinutesAt(new Date(guess - 86_400_000), timeZone);
  const after = offsetMinutesAt(new Date(guess + 86_400_000), timeZone);
  const candidates = [...new Set([before, after])]
    .map((off) => new Date(guess - off * 60_000))
    .filter((c) => offsetMinutesAt(c, timeZone) === (guess - c.getTime()) / 60_000);
  if (candidates.length === 0) return new Date(guess - before * 60_000); // in a gap
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return disambiguation === 'earlier' ? candidates[0] : candidates[candidates.length - 1];
}

/** Same wall-clock time `days` calendar days later in `timeZone` (DST-safe). */
export function addZonedDays(instant: Date, days: number, timeZone: string): Date {
  const w = wallTimeIn(instant, timeZone);
  const shifted = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return zonedWallTimeToInstant(
    { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: w.hour, minute: w.minute, second: w.second },
    timeZone,
  );
}

/** Start (00:00) of the calendar day containing `instant` in `timeZone`. */
export function startOfZonedDay(instant: Date, timeZone: string): Date {
  const w = wallTimeIn(instant, timeZone);
  return zonedWallTimeToInstant({ year: w.year, month: w.month, day: w.day, hour: 0, minute: 0 }, timeZone);
}

/** Calendar-day key `YYYY-MM-DD` of `instant` in `timeZone`. */
export function zonedDayKey(instant: Date, timeZone: string): string {
  const w = wallTimeIn(instant, timeZone);
  return `${String(w.year).padStart(4, '0')}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/** Short DST-neutral zone label, e.g. "CT" / "ET" / "GMT+1" (locale-dependent). */
export function zoneLabel(instant: Date, timeZone: string, locale: string): string {
  try {
    const part = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'shortGeneric' })
      .formatToParts(instant)
      .find((x) => x.type === 'timeZoneName');
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

export interface ZonedDisplay {
  /** "9:00 AM CT" */
  businessText: string;
  /** "10:00 AM ET" — null when the viewer sees the same wall clock (same zone or same offset). */
  viewerText: string | null;
  businessZone: string;
  viewerZone: string;
}

/**
 * Time in the business zone plus (when different) the viewer's zone.
 * Returns data, not a sentence: the component composes the user-facing
 * phrase through i18next ("{{business}} (your time {{viewer}})").
 */
export function zonedDisplay(
  instant: Date,
  opts: { businessZone: string | null; viewerZone: string; locale: string; hourCycle?: 'h12' | 'h23' },
): ZonedDisplay {
  const businessZone = opts.businessZone && isValidTimeZone(opts.businessZone) ? opts.businessZone : opts.viewerZone;
  const fmt = (zone: string) => {
    const time = new Intl.DateTimeFormat(opts.locale, {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit',
      ...(opts.hourCycle ? { hourCycle: opts.hourCycle } : {}),
    }).format(instant);
    return `${time} ${zoneLabel(instant, zone, opts.locale)}`;
  };
  const sameWallClock =
    businessZone === opts.viewerZone || offsetMinutesAt(instant, businessZone) === offsetMinutesAt(instant, opts.viewerZone);
  return {
    businessText: fmt(businessZone),
    viewerText: sameWallClock ? null : fmt(opts.viewerZone),
    businessZone,
    viewerZone: opts.viewerZone,
  };
}
