import { describe, it, expect } from 'vitest';
import { addBusinessDays, addMonths, easterSunday, holidaysFor, isBusinessDay, nextBusinessDay, calendarInfo } from './packHolidays';

const dates = (c: string, y: number, sub?: string) => holidaysFor(c, y, sub).map((h) => h.date);
const find = (c: string, y: number, name: string, sub?: string) => holidaysFor(c, y, sub).find((h) => h.name.includes(name));

describe('easter', () => {
  it('matches known dates', () => {
    expect(easterSunday(2024)).toBe('2024-03-31');
    expect(easterSunday(2025)).toBe('2025-04-20');
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
  });
});

describe('US', () => {
  it('has the 11 federal holidays', () => {
    expect(holidaysFor('US', 2026)).toHaveLength(11);
    expect(find('US', 2026, 'Thanksgiving')?.date).toBe('2026-11-26');
    expect(find('US', 2026, 'Memorial')?.date).toBe('2026-05-25');
    expect(find('US', 2026, 'Labor')?.date).toBe('2026-09-07');
  });
  it('observes weekend holidays federally', () => {
    expect(find('US', 2026, 'Independence')?.date).toBe('2026-07-03'); // Sat -> Fri
    expect(find('US', 2027, 'Christmas')?.date).toBe('2027-12-24'); // Sat -> Fri
    expect(find('US', 2027, 'Independence')?.date).toBe('2027-07-05'); // Sun -> Mon
  });
  it('puts a Saturday New Year observance in the previous December', () => {
    expect(dates('US', 2021)).toContain('2021-12-31');
    expect(dates('US', 2022)).not.toContain('2022-01-01');
  });
});

describe('UK', () => {
  it('gives England bank holidays and substitutes', () => {
    expect(find('GB', 2026, 'Good Friday')?.date).toBe('2026-04-03');
    expect(find('GB', 2026, 'Spring')?.date).toBe('2026-05-25');
    expect(find('GB', 2026, 'Summer')?.date).toBe('2026-08-31');
    const xm = holidaysFor('GB', 2026).filter((h) => h.date >= '2026-12-01').map((h) => h.date);
    expect(xm).toEqual(['2026-12-25', '2026-12-28']); // Boxing Day Sat -> Mon 28
    const xm2 = holidaysFor('GB', 2027).filter((h) => h.date >= '2027-12-01').map((h) => h.date);
    expect(xm2).toEqual(['2027-12-27', '2027-12-28']); // Sat/Sun -> Mon/Tue
    const xm3 = holidaysFor('GB', 2022).filter((h) => h.date >= '2022-12-01').map((h) => h.date);
    expect(xm3).toEqual(['2022-12-26', '2022-12-27']); // Sun -> Tue (Mon is Boxing Day)
  });
  it('differs by nation', () => {
    expect(find('GB', 2026, 'Summer', 'SCT')?.date).toBe('2026-08-03');
    expect(find('GB', 2026, 'St Patrick', 'NIR')?.date).toBe('2026-03-17');
    expect(find('GB', 2026, 'St Patrick', 'ENG')).toBeUndefined();
  });
});

describe('Canada & Australia', () => {
  it('knows provincial days', () => {
    expect(find('CA', 2026, 'Victoria Day', 'ON')?.date).toBe('2026-05-18');
    expect(find('CA', 2026, 'Family Day', 'ON')?.date).toBe('2026-02-16');
    expect(find('CA', 2026, 'Family Day', 'QC')).toBeUndefined();
    expect(find('CA', 2026, 'Saint-Jean', 'QC')?.date).toBe('2026-06-24');
    expect(find('CA', 2027, 'Canada Day')?.date).toBe('2027-07-01');
  });
  it('knows state days', () => {
    expect(find('AU', 2026, 'King', 'NSW')?.date).toBe('2026-06-08');
    expect(find('AU', 2026, 'King', 'QLD')?.date).toBe('2026-10-05');
    expect(find('AU', 2026, 'Labour', 'VIC')?.date).toBe('2026-03-09');
    expect(find('AU', 2026, 'Australia Day')?.date).toBe('2026-01-26');
    expect(find('AU', 2026, 'Anzac')?.date).toBe('2026-04-25'); // Saturday, not shifted
  });
});

describe('EU', () => {
  it('computes movable German feasts and state variance', () => {
    expect(find('DE', 2026, 'Ascension')?.date).toBe('2026-05-14');
    expect(find('DE', 2026, 'Corpus', 'BY')?.date).toBe('2026-06-04');
    expect(find('DE', 2026, 'Corpus', 'BE')).toBeUndefined();
    expect(find('DE', 2026, 'Repentance', 'SN')?.date).toBe('2026-11-18');
  });
  it('handles Irish, Dutch and French rules', () => {
    expect(find('IE', 2026, 'Brigid')?.date).toBe('2026-02-02');
    expect(find('IE', 2025, 'Brigid')?.date).toBe('2025-02-03');
    expect(find('NL', 2026, 'King')?.date).toBe('2026-04-27');
    expect(find('NL', 2025, 'King')?.date).toBe('2025-04-26');
    expect(find('FR', 2026, 'Bastille')?.date).toBe('2026-07-14');
  });
  it('is explicit about thin coverage', () => {
    expect(calendarInfo('CY').coverage).toBe('minimal');
    expect(holidaysFor('CY', 2026)).toHaveLength(2);
    expect(calendarInfo('FR').coverage).toBe('full');
  });
});

describe('business days', () => {
  it('skips weekends and holidays', () => {
    expect(isBusinessDay('2026-07-03', 'US')).toBe(false); // observed Independence Day
    expect(isBusinessDay('2026-07-06', 'US')).toBe(true);
    expect(nextBusinessDay('2026-07-04', 'US')).toBe('2026-07-06');
    expect(addBusinessDays('2026-12-23', 3, 'GB')).toBe('2026-12-30'); // 24, (25,28 closed), 29, 30
  });
  it('lets tenants override a day', () => {
    expect(isBusinessDay('2026-07-03', 'US', null, [{ date: '2026-07-03', closed: false }])).toBe(true);
    expect(isBusinessDay('2026-07-08', 'US', null, [{ date: '2026-07-08', closed: true }])).toBe(false);
  });
  it('clamps month arithmetic', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(() => isBusinessDay('2026-13-40', 'US')).toThrow();
  });
});
