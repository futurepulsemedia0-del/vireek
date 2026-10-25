import { describe, expect, it } from 'vitest';
import { analyzeLeaks, type HtJob } from './leakEngine';
import { FIX_ASSUMPTIONS, measureBaselineDelta, measureFillGap, suggestFixes, type MeasurableFix, type WaitlistEntry } from './fixes';

const UTC = { timeZone: 'UTC' };
let n = 0;
const job = (start: string, end: string, extra: Partial<HtJob> = {}): HtJob => ({
  id: `f${++n}`, techId: 't1', techName: 'Alex', scheduledAt: null, startedAt: start, enRouteAt: null, completedAt: end,
  durationMinutes: null, status: 'completed', isRework: false, tags: null, ...extra,
});
const wl = (id: string, priority = 0, created = '2027-02-01T00:00:00Z'): WaitlistEntry => ({ id, customerName: `Customer ${id}`, serviceType: 'AC repair', requestedDate: '2027-03-20', priority, createdAt: created });
const NOW = Date.parse('2027-03-15T06:00:00Z');

describe('suggestFixes', () => {
  const planned = (s: string, e: string) => job(s, e, { status: 'scheduled', startedAt: null, completedAt: null, scheduledAt: s, durationMinutes: (Date.parse(e) - Date.parse(s)) / 60000 });
  const forecast = analyzeLeaks([planned('2027-03-16T08:00:00Z', '2027-03-16T10:00:00Z'), planned('2027-03-16T13:00:00Z', '2027-03-16T14:00:00Z')], { ...UTC, includePlanned: true });
  const history = analyzeLeaks([], UTC);

  it('offers the highest-priority waitlist entry for each fillable idle gap, once per entry', () => {
    const s = suggestFixes({ forecast, history, waitlist: [wl('a', 0), wl('b', 5)], nowMs: NOW });
    const fills = s.filter((x) => x.kind === 'fill_gap');
    expect(fills.length).toBe(2); // the 10:00–13:00 gap and the end-of-day slack
    expect(fills[0].waitlistEntryId).toBe('b');
    expect(fills[1].waitlistEntryId).toBe('a');
    expect(new Set(fills.map((f) => f.fingerprint)).size).toBe(2);
    expect(fills[0].estimatedHours).toBe(1);
  });

  it('never suggests past gaps and makes no suggestion without waitlist entries', () => {
    expect(suggestFixes({ forecast, history, waitlist: [], nowMs: NOW }).filter((x) => x.kind === 'fill_gap')).toHaveLength(0);
    expect(suggestFixes({ forecast, history, waitlist: [wl('a')], nowMs: Date.parse('2027-03-30T00:00:00Z') })).toHaveLength(0);
  });

  it('suggests pattern fixes with a stored per-day baseline when history shows the leak', () => {
    const jobs: HtJob[] = [];
    for (let d = 1; d <= 6; d++) {
      const day = `2027-03-0${d}`;
      jobs.push(job(`${day}T08:00:00Z`, `${day}T09:00:00Z`, { status: 'no_show' }), job(`${day}T09:00:00Z`, `${day}T10:00:00Z`));
    }
    const h = analyzeLeaks(jobs, UTC);
    const s = suggestFixes({ forecast: analyzeLeaks([], UTC), history: h, waitlist: [], nowMs: NOW });
    const reminder = s.find((x) => x.kind === 'noshow_reminder');
    expect(reminder?.baselineHoursPerDay).toBe(1);
    expect(reminder?.estimatedHours).toBe(2.4); // 6h × 40% planning assumption
  });
});

describe('measurement — only real later data counts as recovered', () => {
  const fix: MeasurableFix = { kind: 'noshow_reminder', technicianId: null, approvedAt: '2027-03-10T12:00:00Z', baselineHoursPerDay: 1, windowStart: null, windowEnd: null };
  const after = (noShows: number) => {
    const jobs: HtJob[] = [];
    for (let d = 11; d <= 20; d++) {
      jobs.push(job(`2027-03-${d}T08:00:00Z`, `2027-03-${d}T09:00:00Z`, d - 10 <= noShows ? { status: 'no_show' } : {}), job(`2027-03-${d}T09:00:00Z`, `2027-03-${d}T10:00:00Z`));
    }
    return analyzeLeaks(jobs, UTC);
  };

  it('reports the drop versus baseline and never a negative number', () => {
    const a = after(3); // 3 no-show hours over 10 workdays vs baseline 10
    const m = measureBaselineDelta(fix, a.rows, a.days, '2027-03-10');
    expect(m.ready).toBe(true);
    expect(m.workdays).toBe(10);
    expect(m.hours).toBe(7);
    const worse = after(10);
    expect(measureBaselineDelta({ ...fix, baselineHoursPerDay: 0.5 }, worse.rows, worse.days, '2027-03-10').hours).toBe(0);
  });

  it('is not ready before enough workdays have passed', () => {
    const a = analyzeLeaks([job('2027-03-11T08:00:00Z', '2027-03-11T09:00:00Z')], UTC);
    const m = measureBaselineDelta(fix, a.rows, a.days, '2027-03-10');
    expect(m.ready).toBe(false);
    expect(m.hours).toBe(0);
    expect(FIX_ASSUMPTIONS.minWorkdaysToMeasure).toBe(5);
  });

  it('fill-gap: counts only the booked job time inside the offered slot, waits until the slot has passed', () => {
    const f: MeasurableFix = { kind: 'fill_gap', technicianId: 't1', approvedAt: '2027-03-15T07:00:00Z', baselineHoursPerDay: null, windowStart: '2027-03-16T10:00:00Z', windowEnd: '2027-03-16T11:00:00Z' };
    const booked = job('2027-03-16T10:00:00Z', '2027-03-16T10:45:00Z');
    expect(measureFillGap(f, booked, Date.parse('2027-03-16T09:00:00Z')).ready).toBe(false);
    expect(measureFillGap(f, booked, Date.parse('2027-03-17T00:00:00Z'))).toEqual({ ready: true, hours: 0.75, method: 'direct_slot', workdays: 1 });
    expect(measureFillGap(f, null, Date.parse('2027-03-17T00:00:00Z')).hours).toBe(0);
    expect(measureFillGap(f, { ...booked, status: 'scheduled', startedAt: null, completedAt: null }, Date.parse('2027-03-17T00:00:00Z')).hours).toBe(0);
  });
});
