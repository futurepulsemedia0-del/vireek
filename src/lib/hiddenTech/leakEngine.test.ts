import { describe, expect, it } from 'vitest';
import { LEAK_CAUSES, analyzeLeaks, classifyJob, sanitizeHtSettings, type HtJob } from './leakEngine';

const UTC = { timeZone: 'UTC' };
let seq = 0;
function job(start: string | null, end: string | null, extra: Partial<HtJob> = {}): HtJob {
  seq += 1;
  return {
    id: `j${seq}`, techId: 't1', techName: 'Alex', scheduledAt: null, startedAt: start, enRouteAt: null, completedAt: end,
    durationMinutes: null, status: 'completed', isRework: false, tags: null, ...extra,
  };
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('analyzeLeaks — basic attribution', () => {
  it('splits a gap into paperwork, idle and drive and fills the end-of-day slack', () => {
    const r = analyzeLeaks([job('2027-03-01T08:00:00Z', '2027-03-01T10:00:00Z'), job('2027-03-01T10:45:00Z', '2027-03-01T12:00:00Z')], UTC);
    expect(r.days).toHaveLength(1);
    const d = r.days[0];
    expect(d.paidHours).toBe(8);
    expect(d.billableHours).toBe(3.25);
    expect(d.leakedHours).toBe(4.75);
    expect(d.byCause.paperwork).toBeCloseTo(0.17, 2); // 10 minutes
    expect(d.byCause.drive).toBe(0.5); // last 30 minutes of the gap
    expect(d.byCause.idle_gap).toBeCloseTo(4.08, 2); // 5 min idle + 4h slack
  });

  it('every leaked hour has exactly one cause: rows add up to paid − billable', () => {
    let s = 12345;
    const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let n = 0; n < 40; n++) {
      const jobs: HtJob[] = [];
      let t = Date.parse('2027-03-02T07:00:00Z');
      const count = 2 + Math.floor(rnd() * 5);
      for (let i = 0; i < count; i++) {
        t += Math.floor(rnd() * 90) * 60_000;
        const len = (20 + Math.floor(rnd() * 150)) * 60_000;
        const flavour = rnd();
        jobs.push(job(new Date(t).toISOString(), new Date(t + len).toISOString(), {
          status: flavour < 0.1 ? 'no_show' : flavour < 0.2 ? 'waiting_parts' : 'completed', isRework: flavour > 0.9,
        }));
        t += len - (rnd() < 0.2 ? 30 * 60_000 : 0); // sometimes overlap
      }
      const r = analyzeLeaks(jobs, UTC);
      for (const d of r.days) {
        expect(d.paidHours).toBe(8);
        expect(Math.abs(d.billableHours + d.leakedHours - d.paidHours) < 0.02).toBe(true);
        expect(Math.abs(sum(LEAK_CAUSES.map((c) => d.byCause[c])) - d.leakedHours) < 0.03).toBe(true);
      }
      for (const row of r.rows) expect(LEAK_CAUSES.includes(row.cause)).toBe(true);
    }
  });
});

describe('analyzeLeaks — cause rules', () => {
  it('assigns no-show, callback and waiting-approval jobs to their own cause', () => {
    const r = analyzeLeaks([
      job('2027-03-03T08:00:00Z', '2027-03-03T09:00:00Z', { status: 'no_show' }),
      job('2027-03-03T09:00:00Z', '2027-03-03T10:00:00Z', { isRework: true }),
      job('2027-03-03T10:00:00Z', '2027-03-03T11:00:00Z', { status: 'waiting_approval' }),
      job('2027-03-03T11:00:00Z', '2027-03-03T12:00:00Z'),
    ], UTC);
    const d = r.days[0];
    expect(d.byCause.no_show).toBe(1);
    expect(d.byCause.callback).toBe(1);
    expect(d.byCause.waiting_approval).toBe(1);
    expect(d.billableHours).toBe(1);
    expect(r.rows.find((x) => x.cause === 'no_show')?.confidence).toBe('measured');
  });

  it('attributes the idle gap after a waiting-parts job to parts_run, and uses en-route time for measured drive', () => {
    const r = analyzeLeaks([
      job('2027-03-04T08:00:00Z', '2027-03-04T09:00:00Z', { tags: 'Parts' }),
      job('2027-03-04T11:00:00Z', '2027-03-04T12:00:00Z', { enRouteAt: '2027-03-04T10:30:00Z' }),
    ], UTC);
    const d = r.days[0];
    // job 1 is billable but flagged parts: gap 09:00–11:00 = 10 min paperwork + 80 min parts_run + 30 min measured drive
    expect(d.byCause.paperwork).toBeCloseTo(0.17, 2);
    expect(d.byCause.parts_run).toBeCloseTo(1.33, 2);
    expect(d.byCause.drive).toBe(0.5);
    expect(r.rows.find((x) => x.cause === 'drive')?.confidence).toBe('measured');
  });

  it('classifyJob prefers measured status over inferred tags', () => {
    expect(classifyJob({ status: 'completed', isRework: false, tags: 'no show' }).cause).toBe('no_show');
    expect(classifyJob({ status: 'completed', isRework: false, tags: 'no show' }).confidence).toBe('inferred');
    expect(classifyJob({ status: 'no_show', isRework: false, tags: null }).confidence).toBe('measured');
    expect(classifyJob({ status: 'completed', isRework: false, tags: 'vip' }).billable).toBe(true);
  });
});

describe('analyzeLeaks — messy real-world data', () => {
  it('skips rows with missing technician or times, and estimates a missing end', () => {
    const noTech = job('2027-03-05T08:00:00Z', '2027-03-05T09:00:00Z', { techId: '' });
    const noTime = job(null, null);
    const noEnd = job('2027-03-05T08:00:00Z', null, { durationMinutes: 90 });
    const r = analyzeLeaks([noTech, noTime, noEnd], UTC);
    expect(r.skipped.map((x) => x.code).sort()).toEqual(['missing_technician', 'missing_time']);
    expect(r.days[0].billableHours).toBe(1.5);
    const noDuration = analyzeLeaks([job('2027-03-05T08:00:00Z', null)], UTC);
    expect(noDuration.days[0].billableHours).toBe(1); // documented 60 minute default
  });

  it('rejects unreadable timestamps, end-before-start and absurdly long jobs', () => {
    const r = analyzeLeaks([
      job('not a date', '2027-03-05T09:00:00Z'),
      job('2027-03-05T10:00:00Z', '2027-03-05T09:00:00Z'),
      job('2027-03-05T00:00:00Z', '2027-03-07T00:00:00Z'),
    ], UTC);
    expect(r.skipped.map((x) => x.code).sort()).toEqual(['bad_time', 'end_before_start', 'too_long']);
    expect(r.days).toHaveLength(0);
  });

  it('counts overlapping jobs once and reports the overlap', () => {
    const r = analyzeLeaks([job('2027-03-06T08:00:00Z', '2027-03-06T10:00:00Z'), job('2027-03-06T09:00:00Z', '2027-03-06T11:00:00Z'), job('2027-03-06T08:30:00Z', '2027-03-06T09:30:00Z')], UTC);
    const d = r.days[0];
    expect(d.billableHours).toBe(3);
    expect(d.overlapHours).toBe(2);
    expect(r.skipped.map((x) => x.code)).toEqual(['fully_overlapped']);
  });

  it('keeps an overnight job on the day it started and never leaks into a phantom second day', () => {
    const r = analyzeLeaks([job('2027-03-07T22:00:00Z', '2027-03-08T06:00:00Z')], UTC);
    expect(r.days).toHaveLength(1);
    expect(r.days[0].day).toBe('2027-03-07');
    expect(r.days[0].billableHours).toBe(8);
    expect(r.days[0].leakedHours).toBe(0);
  });

  it('uses the local calendar day of the configured time zone', () => {
    // 23:30 UTC on Mar 9 is already Mar 10 in Berlin (UTC+1).
    const r = analyzeLeaks([job('2027-03-09T23:30:00Z', '2027-03-10T00:30:00Z')], { timeZone: 'Europe/Berlin' });
    expect(r.days[0].day).toBe('2027-03-10');
  });

  it('ignores cancelled and never-run jobs, and counts planned jobs only for the forecast', () => {
    const cancelled = job('2027-03-11T08:00:00Z', '2027-03-11T09:00:00Z', { status: 'cancelled' });
    const planned = job(null, null, { scheduledAt: '2027-03-11T08:00:00Z', durationMinutes: 60, status: 'scheduled' });
    expect(analyzeLeaks([cancelled, planned], UTC).days).toHaveLength(0);
    const f = analyzeLeaks([planned], { ...UTC, includePlanned: true });
    expect(f.days[0].billableHours).toBe(1);
  });
});

describe('settings, totals and honesty rules', () => {
  it('clamps garbage settings and falls back to the $84.40 default', () => {
    const s = sanitizeHtSettings({ hourlyCost: Number.NaN, paidHoursPerDay: -3, timeZone: 'Mars/Base' });
    expect(s.hourlyCost).toBe(84.4);
    expect(s.paidHoursPerDay).toBe(1);
    expect(s.timeZone).toBe('UTC');
  });

  it('lists technicians alphabetically (never a ranking) and returns at most three top leaks', () => {
    const r = analyzeLeaks([
      job('2027-03-12T08:00:00Z', '2027-03-12T09:00:00Z', { techId: 'b', techName: 'Zed' }),
      job('2027-03-12T08:00:00Z', '2027-03-12T09:00:00Z', { techId: 'a', techName: 'Amy', status: 'no_show' }),
    ], UTC);
    expect(r.techs.map((t) => t.techName)).toEqual(['Amy', 'Zed']);
    expect(r.topLeaks.length <= 3).toBe(true);
    expect(r.totals.leakedCost).toBe(Math.round(r.totals.leakedHours * 84.4 * 100) / 100);
  });
});
