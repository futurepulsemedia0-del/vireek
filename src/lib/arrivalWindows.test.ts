import { describe, expect, it } from 'vitest';
import {
  buildOfferedWindows,
  formatLength,
  formatWindowRange,
  isValidWindow,
  narrowArrivalWindow,
  narrowingChoices,
  normalizeOnTimeRow,
  percent,
  rateTone,
  sanitizeGraceMinutes,
  sanitizeNarrowMinutes,
  sanitizeWindowOptions,
  summarizeOnTime,
  windowLengthMinutes,
  type OnTimeRow,
} from './arrivalWindows';
import type { HoursMap } from './bookingPolicy';

const MIN = 60_000;
// Wednesday 2026-10-07, local time (same convention as bookingPolicy.test.ts)
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 9, 7 + dayOffset, h, m, 0, 0);
const WEEKDAYS: HoursMap = Object.fromEntries(
  (['mon', 'tue', 'wed', 'thu', 'fri'] as const).map((d) => [d, { open: '08:00', close: '17:00' }]),
);
const hourlySlots = (from: number, to: number, skip: number[] = []) =>
  Array.from({ length: to - from }, (_, i) => from + i).filter((h) => !skip.includes(h)).map((h) => at(h));

describe('sanitizing', () => {
  it('keeps only 1-4 hour lengths, unique and sorted', () => {
    expect(sanitizeWindowOptions([240, 60, 60, 90, 999, 'x'])).toEqual([60, 240]);
  });
  it('falls back to the defaults for junk or empty input', () => {
    expect(sanitizeWindowOptions(null)).toEqual([60, 120, 180, 240]);
    expect(sanitizeWindowOptions([])).toEqual([60, 120, 180, 240]);
    expect(sanitizeWindowOptions([5, 7])).toEqual([60, 120, 180, 240]);
  });
  it('snaps and clamps the narrow target', () => {
    expect(sanitizeNarrowMinutes(95)).toBe(90);
    expect(sanitizeNarrowMinutes(10)).toBe(60);
    expect(sanitizeNarrowMinutes(900)).toBe(240);
    expect(sanitizeNarrowMinutes('abc')).toBe(120);
  });
  it('clamps grace to 0-60', () => {
    expect(sanitizeGraceMinutes(-5)).toBe(0);
    expect(sanitizeGraceMinutes(120)).toBe(60);
    expect(sanitizeGraceMinutes(15)).toBe(15);
  });
});

describe('narrowArrivalWindow', () => {
  const four = { start: at(8), end: at(12) };

  it('centres a 2h window on the planned arrival', () => {
    const w = narrowArrivalWindow(four, at(10), 120);
    expect(w.start.getTime()).toBe(at(9).getTime());
    expect(w.end.getTime()).toBe(at(11).getTime());
  });
  it('clamps to the start of the original window', () => {
    const w = narrowArrivalWindow(four, at(8), 120);
    expect(w.start.getTime()).toBe(at(8).getTime());
    expect(w.end.getTime()).toBe(at(10).getTime());
  });
  it('clamps to the end of the original window', () => {
    const w = narrowArrivalWindow(four, at(11, 30), 120);
    expect(w.start.getTime()).toBe(at(10).getTime());
    expect(w.end.getTime()).toBe(at(12).getTime());
  });
  it('never widens and never goes below one hour', () => {
    const two = { start: at(9), end: at(11) };
    expect(windowLengthMinutes(narrowArrivalWindow(two, at(9), 240))).toBe(120);
    expect(windowLengthMinutes(narrowArrivalWindow(four, at(10), 15))).toBe(60);
  });
  it('always keeps the planned arrival inside the narrowed window', () => {
    for (const target of [60, 90, 120, 180]) {
      for (let m = 0; m < 240; m += 15) {
        const anchor = new Date(four.start.getTime() + m * MIN);
        const w = narrowArrivalWindow(four, anchor, target);
        expect(anchor.getTime() >= w.start.getTime() && anchor.getTime() < w.end.getTime()).toBe(true);
        expect(w.start.getTime() >= four.start.getTime() && w.end.getTime() <= four.end.getTime()).toBe(true);
        expect(windowLengthMinutes(w)).toBe(target);
      }
    }
  });
  it('lists only shorter lengths as narrowing choices', () => {
    expect(narrowingChoices(four)).toEqual([60, 120, 180]);
    expect(narrowingChoices({ start: at(9), end: at(10) })).toEqual([]);
  });
  it('validates window length', () => {
    expect(isValidWindow(four)).toBe(true);
    expect(isValidWindow({ start: at(9), end: at(9, 30) })).toBe(false);
    expect(isValidWindow({ start: at(8), end: at(14) })).toBe(false);
  });
});

describe('buildOfferedWindows', () => {
  const base = {
    hours: WEEKDAYS,
    holidays: [] as string[],
    leadTimeHours: 2,
    windowDays: 0,
    now: at(6),
  };

  it('tiles the day from opening time and never runs past closing', () => {
    const w = buildOfferedWindows({ ...base, slots: hourlySlots(8, 17), lengthMinutes: 240 });
    expect(w.map((x) => [x.start.getHours(), x.end.getHours()])).toEqual([[8, 12], [12, 16]]);
  });
  it('anchors each window on its earliest free slot', () => {
    const w = buildOfferedWindows({ ...base, slots: hourlySlots(8, 17, [8, 9]), lengthMinutes: 240 });
    expect(w[0].anchor.getHours()).toBe(10);
  });
  it('drops windows with no free slot', () => {
    const w = buildOfferedWindows({ ...base, slots: hourlySlots(12, 17), lengthMinutes: 240 });
    expect(w.map((x) => x.start.getHours())).toEqual([12]);
  });
  it('respects the lead time', () => {
    const w = buildOfferedWindows({ ...base, leadTimeHours: 3, slots: hourlySlots(8, 17), lengthMinutes: 240 });
    expect(w.map((x) => x.start.getHours())).toEqual([12]);
  });
  it('offers 1 hour windows on every free hour', () => {
    const w = buildOfferedWindows({ ...base, slots: hourlySlots(8, 12, [9]), lengthMinutes: 60 });
    expect(w.map((x) => x.start.getHours())).toEqual([8, 10, 11]);
  });
  it('skips holidays, closed days and bad input', () => {
    const slots = hourlySlots(8, 17);
    expect(buildOfferedWindows({ ...base, holidays: ['2026-10-07'], slots, lengthMinutes: 120 })).toHaveLength(0);
    expect(buildOfferedWindows({ ...base, hours: null, slots, lengthMinutes: 120 })).toHaveLength(0);
    expect(buildOfferedWindows({ ...base, slots, lengthMinutes: 30 })).toHaveLength(0);
    expect(buildOfferedWindows({ ...base, slots: [], lengthMinutes: 120 })).toHaveLength(0);
    // Saturday has no hours
    expect(buildOfferedWindows({ ...base, now: at(6, 0, 3), slots: [at(9, 0, 3)], lengthMinutes: 120 })).toHaveLength(0);
  });
});

describe('formatting', () => {
  it('formats a range in the requested time zone', () => {
    const w = { start: new Date(Date.UTC(2026, 9, 20, 14, 0)), end: new Date(Date.UTC(2026, 9, 20, 16, 0)) };
    const s = formatWindowRange(w, { timeZone: 'UTC', locale: 'en-US' }).replace(/\s/g, ' ');
    expect(s).toBe('2:00 PM – 4:00 PM');
  });
  it('labels lengths', () => {
    expect(formatLength(60)).toBe('1 hour');
    expect(formatLength(180)).toBe('3 hours');
    expect(formatLength(90)).toBe('90 min');
  });
});

describe('on-time statistics', () => {
  const row = (over: Partial<OnTimeRow>): OnTimeRow => ({
    technician_id: 't', technician_name: 'T', windowed_jobs: 0, measured_jobs: 0, on_time_jobs: 0, late_jobs: 0,
    early_jobs: 0, missed_jobs: 0, kept_original_jobs: 0, total_minutes_late: 0, max_minutes_late: 0, ...over,
  });

  it('computes percentages with one decimal and null when empty', () => {
    expect(percent(9, 10)).toBe(90);
    expect(percent(2, 3)).toBe(66.7);
    expect(percent(0, 0)).toBeNull();
  });
  it('aggregates rows and weights lateness only over jobs that actually arrived', () => {
    const s = summarizeOnTime([
      row({ windowed_jobs: 10, measured_jobs: 8, on_time_jobs: 6, late_jobs: 2, missed_jobs: 1, kept_original_jobs: 4, total_minutes_late: 30, max_minutes_late: 30, early_jobs: 2 }),
      row({ windowed_jobs: 4, measured_jobs: 4, on_time_jobs: 4, kept_original_jobs: 4 }),
    ]);
    expect(s.measured).toBe(12);
    expect(s.onTime).toBe(10);
    expect(s.onTimeRate).toBe(83.3);
    expect(s.keptOriginalRate).toBe(66.7);
    expect(s.avgMinutesLate).toBe(30); // 30 min over the single late job that arrived; the missed one has no arrival time
    expect(s.maxMinutesLate).toBe(30);
  });
  it('handles an empty report', () => {
    const s = summarizeOnTime([]);
    expect(s.onTimeRate).toBeNull();
    expect(s.avgMinutesLate).toBeNull();
    expect(s.maxMinutesLate).toBe(0);
  });
  it('coerces numeric strings from the API', () => {
    const r = normalizeOnTimeRow({ technician_id: 'a', measured_jobs: '7', total_minutes_late: '12.5', on_time_jobs: null });
    expect(r.measured_jobs).toBe(7);
    expect(r.total_minutes_late).toBe(12.5);
    expect(r.on_time_jobs).toBe(0);
  });
  it('maps rates to tones', () => {
    expect(rateTone(null)).toBe('none');
    expect(rateTone(97)).toBe('good');
    expect(rateTone(90)).toBe('warn');
    expect(rateTone(70)).toBe('bad');
  });
});
