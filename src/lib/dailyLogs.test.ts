import { describe, expect, it } from 'vitest';
import {
  addDays,
  blankCrew,
  blankDelay,
  blankVisitor,
  buildPayload,
  dailyLogError,
  emptyForm,
  formFromDetail,
  formatLogDate,
  formatMinutes,
  isIsoDate,
  isTooFarAhead,
  missingLogDates,
  parseHours,
  parseWhole,
  totalCrewHours,
  totalDelayMinutes,
  validateForm,
  type DailyLog,
} from './dailyLogs';

describe('parsing', () => {
  it('parses whole numbers within range and rejects the rest', () => {
    expect(parseWhole('', 0, 10)).toBeNull();
    expect(parseWhole(' 7 ', 0, 10)).toBe(7);
    expect(parseWhole('-5', -60, 150)).toBe(-5);
    expect(parseWhole('11', 0, 10)).toBe('invalid');
    expect(parseWhole('1.5', 0, 10)).toBe('invalid');
    expect(parseWhole('abc', 0, 10)).toBe('invalid');
  });
  it('parses hours with at most two decimals, 0..24', () => {
    expect(parseHours('')).toBe(0);
    expect(parseHours('8')).toBe(8);
    expect(parseHours('7.25')).toBe(7.25);
    expect(parseHours('24')).toBe(24);
    expect(parseHours('24.5')).toBe('invalid');
    expect(parseHours('7.255')).toBe('invalid');
    expect(parseHours('-1')).toBe('invalid');
  });
});

describe('validateForm', () => {
  it('accepts an empty draft but blocks submit', () => {
    const r = validateForm(emptyForm());
    expect(Object.keys(r.errors)).toHaveLength(0);
    expect(r.submitBlockers).toHaveLength(2);
  });
  it('allows submit once weather and work are set', () => {
    const f = { ...emptyForm(), weather_code: 'rain' as const, work_performed: 'Set the air handler.' };
    expect(validateForm(f).submitBlockers).toHaveLength(0);
  });
  it('flags bad temperatures, crew, delays and visitors', () => {
    const f = {
      ...emptyForm(),
      temp_high_f: '40',
      temp_low_f: '60',
      wind_mph: '999',
      crew: [{ ...blankCrew(), name: '', hours: '30' }],
      delays: [{ ...blankDelay(), minutes: '' }],
      visitors: [{ ...blankVisitor(), name: '  ' }],
    };
    const e = validateForm(f).errors;
    expect(e.temp_high_f).toBeTruthy();
    expect(e.wind_mph).toBeTruthy();
    expect(e['crew-0-name']).toBeTruthy();
    expect(e['crew-0-hours']).toBeTruthy();
    expect(e['delay-0-minutes']).toBeTruthy();
    expect(e['visitor-0-name']).toBeTruthy();
  });
});

describe('payload and totals', () => {
  it('builds a clean payload', () => {
    const f = {
      ...emptyForm(),
      weather_code: 'clear' as const,
      temp_high_f: '72',
      work_performed: '  Framed the closet.  ',
      ai_summary: '   ',
      ai_generated_at: '2026-10-27T10:00:00Z',
      ai_edited: true,
      crew: [{ ...blankCrew(), name: ' Sam ', hours: '8' }],
      delays: [{ ...blankDelay(), minutes: '45' }],
    };
    const p = buildPayload(f);
    expect(p.work_performed).toBe('Framed the closet.');
    expect(p.temp_high_f).toBe(72);
    expect(p.temp_low_f).toBeNull();
    expect(p.ai_summary).toBeNull();
    expect(p.ai_generated_at).toBeNull();
    expect(p.ai_edited).toBe(false);
    expect(p.crew[0].name).toBe('Sam');
    expect(p.crew[0].hours).toBe(8);
    expect(p.delays[0].minutes).toBe(45);
  });
  it('sums hours and delay minutes without float drift', () => {
    expect(totalCrewHours([{ hours: '0.1' }, { hours: '0.2' }, { hours: 7.5 }])).toBe(7.8);
    expect(totalCrewHours([{ hours: 'oops' }])).toBe(0);
    expect(totalDelayMinutes([{ minutes: '30' }, { minutes: 90 }, { minutes: '' }])).toBe(120);
  });
  it('formats minutes', () => {
    expect(formatMinutes(0)).toBe('0 min');
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(120)).toBe('2 h');
    expect(formatMinutes(135)).toBe('2 h 15 min');
  });
  it('round-trips a stored log into the form', () => {
    const log = {
      id: 'l1', project_id: 'p1', log_date: '2026-10-26', status: 'draft', weather_code: 'fog', temp_high_f: 55, temp_low_f: null, wind_mph: 4,
      weather_notes: null, work_performed: 'Demo', ai_summary: 'AI text', ai_generated_at: '2026-10-26T12:00:00Z', ai_edited: true,
      submitted_at: null, created_at: '', updated_at: '',
    } as DailyLog;
    const f = formFromDetail({ log, crew: [], delays: [], visitors: [] });
    expect(f.weather_code).toBe('fog');
    expect(f.temp_low_f).toBe('');
    expect(f.ai_edited).toBe(true);
    expect(formFromDetail({ log: null, crew: [], delays: [], visitors: [] })).toEqual(emptyForm());
  });
});

describe('dates', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
  it('validates ISO dates', () => {
    expect(isIsoDate('2026-10-27')).toBe(true);
    expect(isIsoDate('2026-02-31')).toBe(false);
    expect(isIsoDate('10/27/2026')).toBe(false);
  });
  it('allows at most one day ahead', () => {
    expect(isTooFarAhead('2026-10-28', '2026-10-27')).toBe(false);
    expect(isTooFarAhead('2026-10-29', '2026-10-27')).toBe(true);
  });
  it('formats a date without timezone drift', () => {
    expect(formatLogDate('2026-10-27')).toContain('Oct 27, 2026');
    expect(formatLogDate('garbage')).toBe('garbage');
  });
  it('lists missing weekdays newest first and skips weekends', () => {
    // 2026-10-27 is a Tuesday. Existing: Tue 27 and Mon 26.
    const have = new Set(['2026-10-27', '2026-10-26']);
    expect(missingLogDates('2026-10-20', '2026-10-27', have)).toEqual(['2026-10-23', '2026-10-22', '2026-10-21', '2026-10-20']);
    expect(missingLogDates(null, '2026-10-27', have)).toEqual([]);
    expect(missingLogDates('2026-10-27', '2026-10-27', have)).toEqual([]);
  });
});

describe('dailyLogError', () => {
  it('maps server codes and duplicates', () => {
    expect(dailyLogError(new Error('log_locked'), 'x')).toContain('locked');
    expect(dailyLogError({ message: 'duplicate key value violates unique constraint' }, 'x')).toContain('already exists');
    expect(dailyLogError(new Error('boom'), 'fallback')).toBe('fallback');
  });
});
