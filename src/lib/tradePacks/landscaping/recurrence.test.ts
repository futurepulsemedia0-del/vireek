import { describe, it, expect } from 'vitest';
import { planVisits, scheduledUtc, validateSchedule, previewVisits, type ContractSchedule } from './recurrence.ts';
import { holidaysForYear, buildHolidayLookup, monthInWindow } from './calendar.ts';

const base: ContractSchedule = {
  startDate: '2027-03-01', // Monday
  endDate: null,
  seasons: [{ fromMonth: 1, toMonth: 12, intervalWeeks: 1 }],
  holidayPolicy: 'shift_next',
  holidaySet: 'us_core',
  extraHolidays: [],
  workdays: [1, 2, 3, 4, 5],
  pauses: [],
  preferredTime: '09:00',
  timezone: 'America/Chicago',
};
const dates = (s: ContractSchedule, from: string, to: string) => planVisits(s, { from, to }).map((v) => `${v.date}${v.status === 'skipped' ? `!${v.reason}` : ''}`);

describe('landscaping recurrence: cadence', () => {
  it('weekly visits are anchored to the start date', () => {
    expect(dates(base, '2027-03-01', '2027-03-22')).toEqual(['2027-03-01', '2027-03-08', '2027-03-15', '2027-03-22']);
  });
  it('biweekly keeps even week indexes regardless of window start', () => {
    const s = { ...base, seasons: [{ fromMonth: 1, toMonth: 12, intervalWeeks: 2 }] };
    expect(dates(s, '2027-03-01', '2027-04-12')).toEqual(['2027-03-01', '2027-03-15', '2027-03-29', '2027-04-12']);
    expect(dates(s, '2027-03-08', '2027-04-12')).toEqual(['2027-03-15', '2027-03-29', '2027-04-12']); // same dates from a later window
  });
  it('windows are idempotent: two adjacent windows equal one big window', () => {
    const all = planVisits(base, { from: '2027-03-01', to: '2027-06-30' }).map((v) => v.n);
    const a = planVisits(base, { from: '2027-03-01', to: '2027-04-30' }).map((v) => v.n);
    const b = planVisits(base, { from: '2027-05-01', to: '2027-06-30' }).map((v) => v.n);
    expect([...a, ...b]).toEqual(all);
  });
  it('respects end date', () => {
    expect(dates({ ...base, endDate: '2027-03-10' }, '2027-03-01', '2027-03-31')).toEqual(['2027-03-01', '2027-03-08']);
  });
});

describe('landscaping recurrence: seasons', () => {
  it('only generates inside seasons and uses each season interval', () => {
    const s = { ...base, startDate: '2027-03-29', seasons: [{ fromMonth: 4, toMonth: 10, intervalWeeks: 1 }] };
    expect(dates(s, '2027-03-29', '2027-04-12')).toEqual(['2027-04-05', '2027-04-12']);
  });
  it('season windows wrap the new year', () => {
    expect(monthInWindow(1, 11, 3)).toBe(true);
    expect(monthInWindow(7, 11, 3)).toBe(false);
    const s = { ...base, startDate: '2026-12-28', seasons: [{ fromMonth: 11, toMonth: 3, intervalWeeks: 2 }] };
    expect(dates(s, '2026-12-28', '2027-02-01')).toEqual(['2026-12-28', '2027-01-11', '2027-01-25']);
  });
  it('rejects overlapping seasons', () => {
    const s = { ...base, seasons: [{ fromMonth: 1, toMonth: 6, intervalWeeks: 1 }, { fromMonth: 6, toMonth: 9, intervalWeeks: 2 }] };
    expect(validateSchedule(s)).toContain('Seasons cannot overlap');
  });
});

describe('landscaping recurrence: holidays', () => {
  it('computes observed holidays (Memorial Day 2027, July 4 2026 on Saturday → Fri)', () => {
    expect(holidaysForYear(2027, 'us_core')['2027-05-31']).toBe('Memorial Day');
    expect(holidaysForYear(2026, 'us_core')['2026-07-03']).toBe('Independence Day');
    expect(holidaysForYear(2027, 'us_core')['2027-11-25']).toBe('Thanksgiving');
  });
  it('Jan 1 on a Saturday is observed on Dec 31 of the previous year', () => {
    const h = buildHolidayLookup('2021-12-20', '2022-01-10', 'us_core');
    expect(h('2021-12-31')).toBe("New Year's Day");
  });
  const s = { ...base, startDate: '2027-05-17' };
  it('shift_next moves a Memorial Day visit to Tuesday and does not drift later visits', () => {
    const v = planVisits(s, { from: '2027-05-17', to: '2027-06-14' });
    expect(v.map((x) => x.date)).toEqual(['2027-05-17', '2027-05-24', '2027-06-01', '2027-06-07', '2027-06-14']);
    expect(v.find((x) => x.originalDate === '2027-05-31')).toMatchObject({ date: '2027-06-01', shifted: true, holidayName: 'Memorial Day' });
    expect(v.find((x) => x.originalDate === '2027-06-07')?.date).toBe('2027-06-07');
  });
  it('shift_prev moves to Friday, skip skips, ignore keeps', () => {
    expect(planVisits({ ...s, holidayPolicy: 'shift_prev' }, { from: '2027-05-31', to: '2027-05-31' })[0].date).toBe('2027-05-28');
    expect(planVisits({ ...s, holidayPolicy: 'skip' }, { from: '2027-05-31', to: '2027-05-31' })[0]).toMatchObject({ status: 'skipped', reason: 'holiday' });
    expect(planVisits({ ...s, holidayPolicy: 'ignore' }, { from: '2027-05-31', to: '2027-05-31' })[0]).toMatchObject({ status: 'scheduled', date: '2027-05-31' });
  });
  it('custom closure dates are honoured', () => {
    const v = planVisits({ ...s, extraHolidays: ['2027-05-24'] }, { from: '2027-05-24', to: '2027-05-24' })[0];
    expect(v.date).toBe('2027-05-25');
  });
  it('shift is skipped when no working day is free within the cadence gap', () => {
    const v = planVisits({ ...s, workdays: [1] }, { from: '2027-05-31', to: '2027-05-31' })[0];
    expect(v).toMatchObject({ status: 'skipped', reason: 'holiday' });
  });
});

describe('landscaping recurrence: pauses', () => {
  it('skips visits inside a pause and resumes afterwards; open-ended pause skips everything', () => {
    const s = { ...base, pauses: [{ from: '2027-03-05', to: '2027-03-16' }] };
    expect(dates(s, '2027-03-01', '2027-03-22')).toEqual(['2027-03-01', '2027-03-08!paused', '2027-03-15!paused', '2027-03-22']);
    expect(dates({ ...base, pauses: [{ from: '2027-03-05', to: null }] }, '2027-03-01', '2027-03-22').slice(1).every((d) => d.endsWith('!paused'))).toBe(true);
  });
  it('a holiday shift that lands inside a pause is skipped as paused', () => {
    const s = { ...base, startDate: '2027-05-17', pauses: [{ from: '2027-06-01', to: '2027-06-03' }] };
    expect(planVisits(s, { from: '2027-05-31', to: '2027-05-31' })[0]).toMatchObject({ status: 'skipped', reason: 'paused' });
  });
});

describe('landscaping recurrence: DST-correct times', () => {
  it('keeps 09:00 wall-clock across the spring-forward change (US 2027-03-14)', () => {
    expect(scheduledUtc('2027-03-08', '09:00', 'America/Chicago')).toBe('2027-03-08T15:00:00.000Z');
    expect(scheduledUtc('2027-03-15', '09:00', 'America/Chicago')).toBe('2027-03-15T14:00:00.000Z');
  });
  it('keeps 09:00 across fall-back (2027-11-07) and for a southern-hemisphere zone', () => {
    expect(scheduledUtc('2027-11-01', '09:00', 'America/Chicago')).toBe('2027-11-01T14:00:00.000Z');
    expect(scheduledUtc('2027-11-08', '09:00', 'America/Chicago')).toBe('2027-11-08T15:00:00.000Z');
    expect(scheduledUtc('2027-01-11', '09:00', 'Australia/Sydney')).toBe('2027-01-10T22:00:00.000Z');
  });
  it('works on the DST change day itself (after the 02:00 gap)', () => {
    expect(scheduledUtc('2027-03-14', '09:00', 'America/Chicago')).toBe('2027-03-14T14:00:00.000Z');
  });
  it('rejects start times in the DST gap/overlap window and bad zones', () => {
    expect(validateSchedule({ ...base, preferredTime: '02:30' })).toContain('Start time must be between 05:00 and 20:59');
    expect(validateSchedule({ ...base, timezone: 'Mars/Base' })).toContain('Unknown timezone');
  });
});

describe('landscaping recurrence: guards', () => {
  it('rejects invalid schedules and oversized windows', () => {
    expect(() => planVisits({ ...base, startDate: '2027-02-30' }, { from: '2027-03-01', to: '2027-03-02' })).toThrow();
    expect(() => planVisits(base, { from: '2027-01-01', to: '2029-01-01' })).toThrow(/too long/);
  });
  it('previewVisits returns the next scheduled visits only', () => {
    const s = { ...base, pauses: [{ from: '2027-03-05', to: '2027-03-16' }] };
    expect(previewVisits(s, '2027-03-01', 3).map((v) => v.date)).toEqual(['2027-03-01', '2027-03-22', '2027-03-29']);
  });
});
