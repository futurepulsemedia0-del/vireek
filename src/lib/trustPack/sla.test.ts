import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SLA_TIERS, computeMonthlyReport, creditPctFor, floorTo, formatMinutes, formatUptime, mergeIntervals, periodWindow,
  previousPeriod, quoteCredit, validateTiers, classifyIncident, type Incident,
} from './sla';

const T = (s: string) => Date.parse(s);
const tenant = { id: 't1', region: 'eu' as const };
const inc = (o: Partial<Incident>): Incident => ({
  id: 'i', title: 'x', kind: 'outage', scope: 'all', tenant_id: null, started_at: '2026-09-10T00:00:00Z', ended_at: '2026-09-10T01:00:00Z',
  announced_at: null, confirmed: true, ...o,
});
const AFTER = T('2026-10-05T00:00:00Z');

describe('periods', () => {
  it('computes month windows (leap-aware) and the previous period', () => {
    expect(periodWindow('2026-09').totalMinutes).toBe(30 * 1440);
    expect(periodWindow('2028-02').totalMinutes).toBe(29 * 1440);
    expect(previousPeriod(T('2026-01-15T00:00:00Z'))).toBe('2025-12');
    expect(() => periodWindow('2026-13')).toThrow();
  });
});

describe('mergeIntervals', () => {
  it('unions overlaps so a minute is never counted twice', () => {
    expect(mergeIntervals([{ start: 0, end: 10 }, { start: 5, end: 20 }, { start: 30, end: 40 }, { start: 40, end: 50 }]))
      .toEqual([{ start: 0, end: 20 }, { start: 30, end: 50 }]);
    expect(mergeIntervals([{ start: 5, end: 5 }])).toEqual([]);
  });
});

describe('classifyIncident', () => {
  it('counts confirmed outages, in scope', () => {
    expect(classifyIncident(inc({}), tenant)).toEqual({ counts: true, reason: null });
  });
  it('excludes unconfirmed, degraded, third-party and force majeure', () => {
    expect(classifyIncident(inc({ confirmed: false }), tenant).reason).toBe('not_confirmed');
    expect(classifyIncident(inc({ kind: 'degraded' }), tenant).reason).toBe('degraded');
    expect(classifyIncident(inc({ kind: 'third_party' }), tenant).reason).toBe('third_party');
    expect(classifyIncident(inc({ kind: 'force_majeure' }), tenant).reason).toBe('force_majeure');
  });
  it('respects region and tenant scoping', () => {
    expect(classifyIncident(inc({ scope: 'us' }), tenant).reason).toBe('not_your_region');
    expect(classifyIncident(inc({ scope: 'eu' }), tenant).counts).toBe(true);
    expect(classifyIncident(inc({ tenant_id: 'other' }), tenant).reason).toBe('not_your_region');
    expect(classifyIncident(inc({ tenant_id: 't1', scope: 'us' }), tenant).counts).toBe(true);
  });
  it('excludes maintenance only when announced 24h+ ahead', () => {
    const base = { kind: 'maintenance' as const, started_at: '2026-09-10T00:00:00Z' };
    expect(classifyIncident(inc({ ...base, announced_at: '2026-09-09T00:00:00Z' }), tenant).reason).toBe('announced_maintenance');
    expect(classifyIncident(inc({ ...base, announced_at: '2026-09-09T06:00:00Z' }), tenant).counts).toBe(true);
    expect(classifyIncident(inc({ ...base, announced_at: null }), tenant).counts).toBe(true);
  });
});

describe('computeMonthlyReport', () => {
  it('is 100% with no incidents', () => {
    const r = computeMonthlyReport('2026-09', tenant, [], AFTER);
    expect(r).toMatchObject({ state: 'final', uptimePct: 100, downtimeMinutes: 0, measuredMinutes: 30 * 1440 });
  });
  it('subtracts counted downtime only', () => {
    const r = computeMonthlyReport('2026-09', tenant, [inc({}), inc({ id: 'd', kind: 'degraded', started_at: '2026-09-11T00:00:00Z', ended_at: '2026-09-12T00:00:00Z' })], AFTER);
    expect(r.downtimeMinutes).toBe(60);
    expect(r.uptimePct).toBeCloseTo(100 - (60 / 43200) * 100, 6);
    expect(r.verdicts.length).toBe(2);
  });
  it('does not double count overlapping outages', () => {
    const r = computeMonthlyReport('2026-09', tenant, [inc({}), inc({ id: 'b', started_at: '2026-09-10T00:30:00Z', ended_at: '2026-09-10T02:00:00Z' })], AFTER);
    expect(r.downtimeMinutes).toBe(120);
  });
  it('clips incidents that straddle the month boundary', () => {
    const r = computeMonthlyReport('2026-09', tenant, [inc({ started_at: '2026-08-31T23:00:00Z', ended_at: '2026-09-01T01:00:00Z' })], AFTER);
    expect(r.downtimeMinutes).toBe(60);
    const out = computeMonthlyReport('2026-09', tenant, [inc({ started_at: '2026-08-01T00:00:00Z', ended_at: '2026-08-02T00:00:00Z' })], AFTER);
    expect(out.verdicts.length).toBe(0);
  });
  it('runs open incidents until now and marks the month in progress', () => {
    const now = T('2026-09-10T12:00:00Z');
    const r = computeMonthlyReport('2026-09', tenant, [inc({ ended_at: null })], now);
    expect(r.state).toBe('in_progress');
    expect(r.downtimeMinutes).toBe(12 * 60);
    expect(r.measuredMinutes).toBe(9.5 * 1440);
  });
  it('ignores incidents with unparseable dates instead of throwing', () => {
    expect(computeMonthlyReport('2026-09', tenant, [inc({ started_at: 'garbage' })], AFTER).downtimeMinutes).toBe(0);
  });
});

describe('credits', () => {
  it('matches the public SLA schedule 10 / 25 / 50', () => {
    expect(creditPctFor(99.95, DEFAULT_SLA_TIERS)).toBe(0);
    expect(creditPctFor(99.9, DEFAULT_SLA_TIERS)).toBe(0);
    expect(creditPctFor(99.8999, DEFAULT_SLA_TIERS)).toBe(10);
    expect(creditPctFor(99.0, DEFAULT_SLA_TIERS)).toBe(10);
    expect(creditPctFor(98.99, DEFAULT_SLA_TIERS)).toBe(25);
    expect(creditPctFor(94.9, DEFAULT_SLA_TIERS)).toBe(50);
  });
  it('quotes cents, capped at the fee, and zero without a fee', () => {
    expect(quoteCredit(98, DEFAULT_SLA_TIERS, 49900)).toEqual({ creditPct: 25, creditCents: 12475 });
    expect(quoteCredit(98, DEFAULT_SLA_TIERS, null)).toEqual({ creditPct: 25, creditCents: 0 });
    expect(quoteCredit(100, DEFAULT_SLA_TIERS, 49900)).toEqual({ creditPct: 0, creditCents: 0 });
    expect(quoteCredit(10, [{ below: 99, credit_pct: 100 }], 500).creditCents).toBe(500);
  });
  it('validates custom tiers', () => {
    expect(validateTiers(DEFAULT_SLA_TIERS)).toBe(true);
    expect(validateTiers([])).toBe(false);
    expect(validateTiers([{ below: 99.9, credit_pct: 50 }, { below: 99, credit_pct: 10 }])).toBe(false); // worse uptime, smaller credit
    expect(validateTiers([{ below: 99, credit_pct: 10 }, { below: 99, credit_pct: 20 }])).toBe(false);
    expect(validateTiers([{ below: 120, credit_pct: 10 }])).toBe(false);
    expect(validateTiers('x')).toBe(false);
  });
});

describe('formatting', () => {
  it('floors uptime so it never rounds up into compliance', () => {
    expect(floorTo(99.8999, 3)).toBe(99.899);
    expect(formatUptime(99.8999)).toBe('99.899%');
    expect(formatUptime(100)).toBe('100.000%');
  });
  it('formats minutes', () => {
    expect(formatMinutes(0)).toBe('0 min');
    expect(formatMinutes(0.4)).toBe('<1 min');
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(120)).toBe('2h');
    expect(formatMinutes(135)).toBe('2h 15m');
  });
});
