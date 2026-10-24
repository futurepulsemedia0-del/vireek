import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES,
  burnRate,
  errorBudget,
  evaluateBurnAlerts,
  incidentCopy,
  incidentKey,
  pickCounts,
  regionsFor,
  shouldResolve,
  windowsFor,
  type Counts,
  type WindowCountRow,
} from './slo';

const OBJ = 0.995;

describe('errorBudget', () => {
  it('reports no_data without events', () => {
    const b = errorBudget({ good: 0, total: 0 }, OBJ);
    expect(b.state).toBe('no_data');
    expect(b.sli).toBeNull();
    expect(b.remaining).toBeNull();
  });
  it('computes consumption against the allowed bad events', () => {
    const b = errorBudget({ good: 990, total: 1000 }, OBJ); // allowed 5, bad 10
    expect(b.allowedBad).toBeCloseTo(5, 6);
    expect(b.consumed).toBeCloseTo(2, 6);
    expect(b.remaining).toBeCloseTo(-1, 6);
    expect(b.state).toBe('exhausted');
  });
  it('flags warning at half the budget and healthy below it', () => {
    expect(errorBudget({ good: 998, total: 1000 }, OBJ).state).toBe('healthy'); // 2 of 5 allowed
    expect(errorBudget({ good: 997, total: 1000 }, OBJ).state).toBe('warning'); // 3 of 5 allowed
  });
  it('clamps nonsense input', () => {
    const b = errorBudget({ good: 50, total: 10 }, OBJ);
    expect(b.good).toBe(10);
    expect(b.bad).toBe(0);
  });
});

describe('burnRate', () => {
  it('is 1 when exactly on objective, 0 when perfect, null without data', () => {
    expect(burnRate({ good: 995, total: 1000 }, OBJ)).toBeCloseTo(1, 6);
    expect(burnRate({ good: 10, total: 10 }, OBJ)).toBe(0);
    expect(burnRate({ good: 0, total: 0 }, OBJ)).toBeNull();
  });
});

function counter(map: Record<number, Counts>) {
  return (m: number): Counts => map[m] ?? { good: 0, total: 0 };
}

describe('evaluateBurnAlerts', () => {
  it('does not fire on a single flaky probe', () => {
    const d = evaluateBurnAlerts(counter({ 60: { good: 3, total: 4 }, 15: { good: 0, total: 1 }, 360: { good: 20, total: 21 } }), OBJ);
    expect(d.firing).toBe(false);
  });
  it('fires a major incident on a fast sustained burn in both windows', () => {
    const d = evaluateBurnAlerts(counter({ 60: { good: 2, total: 6 }, 15: { good: 0, total: 2 }, 360: { good: 30, total: 36 } }), OBJ);
    expect(d.firing).toBe(true);
    expect(d.impact).toBe('major');
  });
  it('requires the short window to still be burning (already recovered = no alert)', () => {
    const d = evaluateBurnAlerts(counter({ 60: { good: 2, total: 6 }, 15: { good: 2, total: 2 }, 360: { good: 30, total: 36 } }), OBJ);
    expect(d.impact).not.toBe('major');
  });
  it('fires a minor incident on a slower sustained burn', () => {
    // 6h: 3 bad of 24 = 12.5% -> 25x ; 1h: 2 bad of 4 -> 100x but fast rule lacks bad events in 15m
    const d = evaluateBurnAlerts(counter({ 360: { good: 21, total: 24 }, 60: { good: 3, total: 4 }, 15: { good: 1, total: 1 } }), OBJ);
    expect(d.firing).toBe(true);
    expect(d.impact).toBe('minor');
  });
  it('prefers major when both rules fire', () => {
    const d = evaluateBurnAlerts(counter({ 360: { good: 10, total: 30 }, 60: { good: 1, total: 5 }, 15: { good: 0, total: 2 } }), OBJ, DEFAULT_RULES);
    expect(d.impact).toBe('major');
  });
});

describe('shouldResolve', () => {
  it('needs a clean hour with enough samples', () => {
    expect(shouldResolve({ good: 4, total: 4 })).toBe(true);
    expect(shouldResolve({ good: 1, total: 1 })).toBe(false);
    expect(shouldResolve({ good: 3, total: 4 })).toBe(false);
  });
});

describe('window helpers', () => {
  const rows: WindowCountRow[] = [
    { window_minutes: 60, sli: 'availability', region: 'us-east', good: 3, total: 4 },
    { window_minutes: 60, sli: 'availability', region: 'eu-west', good: '4', total: '4' },
    { window_minutes: 60, sli: 'webhook_delivery', region: 'us-east', good: 1, total: 1 },
  ];
  it('sums across regions or filters by one', () => {
    expect(pickCounts(rows, 60, 'availability')).toEqual({ good: 7, total: 8 });
    expect(pickCounts(rows, 60, 'availability', 'us-east')).toEqual({ good: 3, total: 4 });
    expect(pickCounts(rows, 15, 'availability')).toEqual({ good: 0, total: 0 });
  });
  it('lists regions per SLI, sorted', () => {
    expect(regionsFor(rows, 'availability')).toEqual(['eu-west', 'us-east']);
  });
  it('always requests short, hour, long and the SLO window, deduped and capped at 90 days', () => {
    expect(windowsFor(30)).toEqual([15, 60, 360, 43200]);
    expect(windowsFor(500)).toContain(129600);
    expect(windowsFor(0)).toContain(1440);
  });
});

describe('incident helpers', () => {
  it('builds stable dedupe keys', () => {
    expect(incidentKey('voice_availability', 'us-east')).toBe('slo:voice_availability:us-east');
    expect(incidentKey('voice_availability', null)).toBe('slo:voice_availability:all');
  });
  it('writes customer-safe copy with the region', () => {
    const c = incidentCopy({ sli: 'availability', label: 'x' }, 'us-east', { firing: true, impact: 'major', rule: null, longBurn: 20, shortBurn: 30 });
    expect(c.title).toBe('Voice AI degraded in us-east');
    expect(c.message).toContain('not being answered');
    expect(c.message).not.toMatch(/\+\d/); // never leaks a phone number
  });
});
