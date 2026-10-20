import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HOURLY_COST, EMPTY_MAPPING, analyzeHours, buildShareSummary, defaultSettings, mappingError, parseBillable,
  parseDateTime, parseDurationMinutes, sanitizeSettings, suggestMapping, zonedToUtc, type AuditMapping, type AuditSettings,
} from './hoursAudit';
import { SAMPLE_HEADERS, buildSampleTable } from './hoursAuditSample';

const H = ['Tech', 'Customer', 'Address', 'Start', 'End', 'Billable'];
const M: AuditMapping = { ...EMPTY_MAPPING, technician: 'Tech', start: 'Start', end: 'End', billable: 'Billable' };
const S: Partial<AuditSettings> = { ...defaultSettings('UTC'), paidHoursPerDay: 8 };
const row = (tech: string, start: string, end: string, billable = 'Yes') => [tech, 'SYNTHETIC Customer', '1 Synthetic St', start, end, billable];
const run = (rows: string[][], s: Partial<AuditSettings> = S, m: AuditMapping = M) => analyzeHours(H, rows, m, s);

describe('parseDateTime', () => {
  it('reads ISO, M/D/Y with AM/PM and D/M/Y', () => {
    const iso = parseDateTime('2026-03-02 09:30', 'mdy', 'UTC');
    expect(iso).toBe(Date.UTC(2026, 2, 2, 9, 30));
    expect(parseDateTime('3/2/2026 9:30 AM', 'mdy', 'UTC')).toBe(iso);
    expect(parseDateTime('02/03/2026 09:30', 'dmy', 'UTC')).toBe(iso);
    expect(parseDateTime('3/2/2026 12:00 AM', 'mdy', 'UTC')).toBe(Date.UTC(2026, 2, 2, 0, 0));
    expect(parseDateTime('3/2/2026 12:15 PM', 'mdy', 'UTC')).toBe(Date.UTC(2026, 2, 2, 12, 15));
  });
  it('honours explicit offsets and ignores the chosen zone for them', () => {
    expect(parseDateTime('2026-03-02T09:30:00-05:00', 'mdy', 'Asia/Tokyo')).toBe(Date.UTC(2026, 2, 2, 14, 30));
    expect(parseDateTime('2026-03-02T09:30:00Z', 'mdy', 'Asia/Tokyo')).toBe(Date.UTC(2026, 2, 2, 9, 30));
  });
  it('converts wall-clock time in a zone, across daylight saving', () => {
    expect(parseDateTime('2026-01-15 08:00', 'mdy', 'America/New_York')).toBe(Date.UTC(2026, 0, 15, 13, 0));
    expect(parseDateTime('2026-07-15 08:00', 'mdy', 'America/New_York')).toBe(Date.UTC(2026, 6, 15, 12, 0));
    expect(zonedToUtc(2026, 3, 8, 12, 0, 0, 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 16, 0)); // after spring-forward
  });
  it('rejects impossible or unreadable values', () => {
    for (const bad of ['', 'abc', '2026-02-30 10:00', '13/45/2026', '3/2/2026 25:00', '3/2/2026 13:00 PM']) expect(parseDateTime(bad, 'mdy', 'UTC')).toBeNull();
  });
});

describe('parseDurationMinutes / parseBillable', () => {
  it('handles the usual shapes', () => {
    expect(parseDurationMinutes('90', 'minutes')).toBe(90);
    expect(parseDurationMinutes('1.5', 'hours')).toBe(90);
    expect(parseDurationMinutes('1:30', 'minutes')).toBe(90);
    expect(parseDurationMinutes('1h 30m', 'minutes')).toBe(90);
    expect(parseDurationMinutes('45 min', 'hours')).toBe(45);
    expect(parseDurationMinutes('soon', 'minutes')).toBeNull();
  });
  it('treats only explicit no-style values as non-billable', () => {
    expect(parseBillable('No')).toBe(false);
    expect(parseBillable('Warranty')).toBe(false);
    expect(parseBillable('')).toBe(true);
    expect(parseBillable('Yes')).toBe(true);
  });
});

describe('analyzeHours — attribution order (non-billable → drive → idle → unscheduled)', () => {
  it('splits one day exactly as documented', () => {
    // 08:00–10:00 billable, 10:20–11:00 non-billable, 13:00–15:00 billable. paid 8h.
    const r = run([row('A', '2026-03-02 08:00', '2026-03-02 10:00'), row('A', '2026-03-02 10:20', '2026-03-02 11:00', 'No'), row('A', '2026-03-02 13:00', '2026-03-02 15:00')]);
    const d = r.days[0];
    expect(d.billable).toBeCloseTo(4, 5);
    expect(d.leaked).toBeCloseTo(4, 5);
    expect(d.nonBillableJob).toBeCloseTo(40 / 60, 5);
    expect(d.drive).toBeCloseTo(50 / 60, 5); // gaps 20m + 120m, each capped at 30m
    expect(d.idle).toBeCloseTo(90 / 60, 5); // 0 + 90m
    expect(d.nonBillableJob + d.drive + d.idle + d.unscheduled).toBeCloseTo(d.leaked, 5);
    expect(d.unscheduled).toBeCloseTo(4 - 40 / 60 - 50 / 60 - 90 / 60, 5);
  });
  it('clips later causes first on an overtime day and never leaks negative hours', () => {
    const r = run([row('A', '2026-03-02 06:00', '2026-03-02 12:00', 'No'), row('A', '2026-03-02 12:30', '2026-03-02 17:00')]); // 4.5 billable, paid 8
    const d = r.days[0];
    expect(d.leaked).toBeCloseTo(3.5, 5);
    expect(d.nonBillableJob).toBeCloseTo(3.5, 5); // takes the whole budget first
    expect(d.drive + d.idle + d.unscheduled).toBeCloseTo(0, 5);
    const over = run([row('A', '2026-03-02 06:00', '2026-03-02 16:00')]);
    expect(over.days[0].leaked).toBe(0);
  });
});

describe('analyzeHours — hard cases', () => {
  it('counts overlapping jobs once and reports the overlap', () => {
    const r = run([row('A', '2026-03-02 08:00', '2026-03-02 10:00'), row('A', '2026-03-02 09:00', '2026-03-02 11:00')]);
    expect(r.days[0].billable).toBeCloseTo(3, 5);
    expect(r.overlapHours).toBeCloseTo(1, 5);
  });
  it('keeps an overnight job on the day it started', () => {
    const r = run([row('Night', '2026-03-02 22:00', '2026-03-03 05:00')]);
    expect(r.days).toHaveLength(1);
    expect(r.days[0].day).toBe('2026-03-02');
    expect(r.days[0].billable).toBeCloseTo(7, 5);
  });
  it('uses the chosen time zone for the day boundary', () => {
    const rows = [row('A', '2026-03-02T23:30:00Z', '2026-03-03T01:00:00Z')];
    expect(run(rows, { ...S, timeZone: 'UTC' }).days[0].day).toBe('2026-03-02');
    expect(run(rows, { ...S, timeZone: 'Asia/Tokyo' }).days[0].day).toBe('2026-03-03');
  });
  it('estimates a missing end from the technician median, or skips when asked', () => {
    const rows = [row('A', '2026-03-02 08:00', '2026-03-02 10:00'), row('A', '2026-03-03 08:00', '2026-03-03 10:00'), row('A', '2026-03-04 08:00', '')];
    const est = run(rows);
    expect(est.rowsImputed).toBe(1);
    expect(est.days[2].billable).toBeCloseTo(2, 5);
    const skip = run(rows, { ...S, missingEnd: 'skip' });
    expect(skip.rowsImputed).toBe(0);
    expect(skip.issueCounts.missing_end).toBe(1);
  });
  it('uses a duration column when the end is blank', () => {
    const m: AuditMapping = { ...M, duration: 'Customer' }; // reuse a column purely to exercise the path
    const r = analyzeHours(['Tech', 'Customer', 'Start', 'End'], [['A', '90', '2026-03-02 08:00', '']], { ...m, duration: 'Customer', start: 'Start', end: 'End', billable: '' }, S);
    expect(r.days[0].billable).toBeCloseTo(1.5, 5);
  });
  it('rejects malformed rows with row numbers and reasons, and keeps going', () => {
    const r = run([
      row('A', '2026-03-02 08:00', '2026-03-02 10:00'),
      row('', '2026-03-02 08:00', '2026-03-02 10:00'),
      row('A', 'garbage', '2026-03-02 10:00'),
      row('A', '2026-03-02 08:00', 'garbage'),
      row('A', '2026-03-02 10:00', '2026-03-02 09:00'),
      row('A', '2026-03-02 00:00', '2026-03-05 00:00'),
    ]);
    expect(r.rowsUsed).toBe(1);
    expect(r.issues.map((i) => [i.row, i.code])).toEqual([[3, 'missing_technician'], [4, 'bad_start'], [5, 'bad_end'], [6, 'end_before_start'], [7, 'too_long']]);
  });
  it('treats technician names case-insensitively and sorts alphabetically, not by leakage', () => {
    const r = run([row('zed', '2026-03-02 08:00', '2026-03-02 09:00'), row('ZED', '2026-03-03 08:00', '2026-03-03 16:00'), row('Amy', '2026-03-02 08:00', '2026-03-02 16:00')]);
    expect(r.techs.map((t) => t.name)).toEqual(['Amy', 'zed']);
  });
  it('prices leakage with the editable hourly cost', () => {
    const rows = [row('A', '2026-03-02 08:00', '2026-03-02 12:00')]; // 4 h billable → 4 h leaked
    expect(run(rows).totals.leakedCost).toBeCloseTo(4 * DEFAULT_HOURLY_COST, 2);
    expect(run(rows, { ...S, hourlyCost: 100 }).totals.leakedCost).toBe(400);
  });
});

describe('mapping + settings helpers', () => {
  it('guesses a sensible mapping and validates it', () => {
    const m = suggestMapping(SAMPLE_HEADERS);
    expect(m.technician).toBe('Technician');
    expect(m.start).toBe('Start');
    expect(m.end).toBe('End');
    expect(mappingError(m, SAMPLE_HEADERS)).toBeNull();
    expect(mappingError({ ...m, end: '', duration: '' }, SAMPLE_HEADERS)).toMatch(/end-time/);
    expect(mappingError({ ...m, end: 'Start' }, SAMPLE_HEADERS)).toMatch(/only be used/);
  });
  it('sanitises nonsense settings', () => {
    const s = sanitizeSettings({ hourlyCost: -5, paidHoursPerDay: NaN as unknown as number, timeZone: 'Mars/Base' });
    expect(s.hourlyCost).toBe(0);
    expect(s.paidHoursPerDay).toBe(8);
    expect(s.timeZone).not.toBe('Mars/Base');
  });
});

describe('seed data, privacy and performance', () => {
  it('analyses the synthetic sample and reports the planted problems', () => {
    const { headers, rows } = buildSampleTable({ technicians: 4, days: 30 });
    const r = analyzeHours(headers, rows, suggestMapping(headers), defaultSettings('UTC'));
    expect(r.rowsRejected).toBeGreaterThanOrEqual(3);
    expect(r.rowsImputed).toBe(1);
    expect(r.overlapHours).toBeGreaterThan(0);
    expect(r.totals.leaked).toBeGreaterThan(0);
    expect(r.totals.billable).toBeLessThan(r.totals.paid);
  });
  it('share summary carries no technician, customer or address text', () => {
    const { headers, rows } = buildSampleTable({ technicians: 3, days: 10 });
    const r = analyzeHours(headers, rows, suggestMapping(headers), defaultSettings('UTC'));
    const text = buildShareSummary(r);
    for (const needle of ['Synthetic Tech', 'SYNTHETIC', 'Synthetic Street', 'J-1000']) expect(text).not.toContain(needle);
    expect(text).toContain('Estimate');
  });
  it('analyses 10,000 rows inside the performance budget', () => {
    const { headers, rows } = buildSampleTable({ technicians: 12, days: 365, malformed: false });
    expect(rows.length).toBeGreaterThanOrEqual(10_000);
    const t0 = performance.now();
    const r = analyzeHours(headers, rows, suggestMapping(headers), defaultSettings('America/New_York'));
    const ms = performance.now() - t0;
    expect(r.rowsUsed).toBe(rows.length);
    expect(ms).toBeLessThan(3000); // product budget is 60 s end to end; this is the CPU part
  });
});
