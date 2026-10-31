import { describe, expect, it } from 'vitest';
import {
  addZonedDays,
  isValidTimeZone,
  offsetMinutesAt,
  startOfZonedDay,
  zonedDayKey,
  zonedDisplay,
  zonedWallTimeToInstant,
} from './timezone';

const NY = 'America/New_York';
const wall = (year: number, month: number, day: number, hour: number, minute = 0) => ({ year, month, day, hour, minute });

describe('timezone — DST edges', () => {
  it('spring forward (2026-03-08, New York): offset jumps -5h → -4h', () => {
    expect(offsetMinutesAt(new Date('2026-03-08T06:59:00Z'), NY)).toBe(-300);
    expect(offsetMinutesAt(new Date('2026-03-08T07:00:00Z'), NY)).toBe(-240);
  });

  it('a wall time inside the spring-forward gap moves forward by the gap', () => {
    expect(zonedWallTimeToInstant(wall(2026, 3, 8, 2, 30), NY).toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('an ambiguous fall-back time resolves earlier/later on request', () => {
    expect(zonedWallTimeToInstant(wall(2026, 11, 1, 1, 30), NY, 'earlier').toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(zonedWallTimeToInstant(wall(2026, 11, 1, 1, 30), NY, 'later').toISOString()).toBe('2026-11-01T06:30:00.000Z');
  });

  it('addZonedDays keeps the wall-clock time across a 23h and a 25h day', () => {
    const before = zonedWallTimeToInstant(wall(2026, 3, 7, 9), NY);
    expect(addZonedDays(before, 1, NY).toISOString()).toBe('2026-03-08T13:00:00.000Z');
    const fall = zonedWallTimeToInstant(wall(2026, 10, 31, 9), NY);
    expect(addZonedDays(fall, 1, NY).toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });

  it('start of a 23-hour day and day keys use the zone, not UTC', () => {
    expect(startOfZonedDay(new Date('2026-03-08T20:00:00Z'), NY).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(zonedDayKey(new Date('2026-03-08T04:30:00Z'), NY)).toBe('2026-03-07');
  });

  it('handles half-hour and 45-minute zones and southern-hemisphere DST', () => {
    expect(offsetMinutesAt(new Date('2026-07-15T00:00:00Z'), 'Asia/Kolkata')).toBe(330);
    expect(offsetMinutesAt(new Date('2026-07-15T00:00:00Z'), 'Asia/Kathmandu')).toBe(345);
    expect(offsetMinutesAt(new Date('2026-01-15T00:00:00Z'), 'Australia/Lord_Howe')).toBe(660);
    expect(offsetMinutesAt(new Date('2026-07-15T00:00:00Z'), 'Australia/Lord_Howe')).toBe(630);
  });

  it('validates zone names', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });
});

describe('zonedDisplay', () => {
  const instant = new Date('2026-07-04T14:00:00Z');

  it('shows business time and the viewer time when zones differ', () => {
    const z = zonedDisplay(instant, { businessZone: 'America/Chicago', viewerZone: NY, locale: 'en-US' });
    expect(z.businessText).toBe('9:00 AM CT');
    expect(z.viewerText).toBe('10:00 AM ET');
  });

  it('omits the viewer time when the wall clock is identical', () => {
    expect(zonedDisplay(instant, { businessZone: NY, viewerZone: NY, locale: 'en-US' }).viewerText).toBeNull();
  });

  it('falls back to the viewer zone when no business zone is set', () => {
    const z = zonedDisplay(instant, { businessZone: null, viewerZone: NY, locale: 'en-US' });
    expect(z.businessZone).toBe(NY);
    expect(z.viewerText).toBeNull();
  });

  it('honors a 24-hour clock', () => {
    const z = zonedDisplay(instant, { businessZone: 'Europe/Berlin', viewerZone: NY, locale: 'de-DE', hourCycle: 'h23' });
    expect(z.businessText.startsWith('16:00')).toBe(true);
  });
});
