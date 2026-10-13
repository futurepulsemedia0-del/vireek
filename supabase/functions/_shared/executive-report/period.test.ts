import { describe, it, expect } from 'vitest';
import { isReportDue, isValidTimeZone, periodForMonth, previousMonthPeriod, zonedMidnightUtc } from './period';

describe('period', () => {
  it('validates time zones', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
  it('builds UTC month bounds with an exclusive end', () => {
    const p = periodForMonth('2026-09', 'UTC')!;
    expect(p.start).toBe('2026-09-01');
    expect(p.end).toBe('2026-09-30');
    expect(p.label).toBe('September 2026');
    expect(p.startUtc).toBe('2026-09-01T00:00:00.000Z');
    expect(p.endUtc).toBe('2026-10-01T00:00:00.000Z');
    expect(p.prior.label).toBe('August 2026');
  });
  it('respects the local timezone (EDT = UTC-4, EST = UTC-5)', () => {
    expect(periodForMonth('2026-09', 'America/New_York')!.startUtc).toBe('2026-09-01T04:00:00.000Z');
    expect(periodForMonth('2026-12', 'America/New_York')!.startUtc).toBe('2026-12-01T05:00:00.000Z');
    expect(zonedMidnightUtc(2026, 3, 8, 'America/New_York')).toBe(Date.parse('2026-03-08T05:00:00Z'));
  });
  it('wraps the year for January', () => {
    const p = previousMonthPeriod(new Date('2027-01-05T12:00:00Z'), 'UTC');
    expect(p.label).toBe('December 2026');
    expect(p.prior.label).toBe('November 2026');
  });
  it('uses the local month, not the UTC month, near midnight', () => {
    // 2026-10-01 02:00 UTC is still 30 Sep in New York → previous month is August.
    const p = previousMonthPeriod(new Date('2026-10-01T02:00:00Z'), 'America/New_York');
    expect(p.label).toBe('August 2026');
  });
  it('rejects malformed months', () => {
    expect(periodForMonth('2026-13', 'UTC')).toBeNull();
    expect(periodForMonth('2026-9', 'UTC')).toBeNull();
  });
  it('is due from send_day/send_hour onward and stays due', () => {
    const s = { enabled: true, send_day: 3, send_hour: 8, timezone: 'UTC' };
    expect(isReportDue(s, new Date('2026-10-03T07:59:00Z'))).toBe(false);
    expect(isReportDue(s, new Date('2026-10-03T08:00:00Z'))).toBe(true);
    expect(isReportDue(s, new Date('2026-10-20T00:00:00Z'))).toBe(true);
    expect(isReportDue({ ...s, enabled: false }, new Date('2026-10-20T00:00:00Z'))).toBe(false);
    expect(isReportDue({ ...s, timezone: 'bad/zone' }, new Date('2026-10-20T00:00:00Z'))).toBe(false);
  });
});
