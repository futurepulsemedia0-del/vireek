import { describe, it, expect } from 'vitest';
import { decideAction, evaluateHealth, wilson, zHigher, type CohortStats } from './rolloutHealth.ts';

const cohort = (o: Partial<CohortStats> = {}): CohortStats => ({ requests: 1000, errors: 5, p95_ms: 400, offered: 0, answered: 0, ...o });
const sum = (canary: Partial<CohortStats>, baseline: Partial<CohortStats> = {}) => ({ canary: cohort(canary), baseline: cohort(baseline) });

describe('statistics helpers', () => {
  it('wilson bounds bracket the observed rate and handle n=0', () => {
    const w = wilson(30, 100);
    expect(w.lower < 0.3 && w.upper > 0.3).toBe(true);
    expect(wilson(0, 0)).toEqual({ lower: 0, upper: 1 });
  });
  it('zHigher is 0 for empty or degenerate samples', () => {
    expect(zHigher(0, 0, 1, 10)).toBe(0);
    expect(zHigher(0, 100, 0, 100)).toBe(0);
  });
});

describe('evaluateHealth', () => {
  it('is ok for a healthy canary', () => expect(evaluateHealth(sum({}, {})).severity).toBe('ok'));

  it('reports insufficient data instead of judging a tiny sample', () => {
    expect(evaluateHealth(sum({ requests: 50, errors: 25 })).severity).toBe('insufficient');
  });

  it('does not roll back on small-sample noise (3% of 300 vs a 2% ceiling, baseline similar)', () => {
    expect(evaluateHealth(sum({ requests: 300, errors: 9 }, { requests: 1000, errors: 25 }), { minRequests: 100 }).severity).toBe('ok');
  });

  it('flags a confident error-rate breach', () => {
    const e = evaluateHealth(sum({ requests: 1000, errors: 60 }));
    expect(e.severity).toBe('breach');
    expect(e.reasons.join()).toContain('error rate');
  });

  it('flags error rate significantly above baseline even under the absolute ceiling', () => {
    const e = evaluateHealth(sum({ requests: 5000, errors: 100 }, { requests: 5000, errors: 10 }), { maxErrorRate: 0.5 });
    expect(e.severity).toBe('breach');
  });

  it('flags latency over baseline ratio and over an absolute ceiling', () => {
    expect(evaluateHealth(sum({ p95_ms: 900 }, { p95_ms: 400 })).severity).toBe('breach');
    expect(evaluateHealth(sum({ p95_ms: 900 }, { p95_ms: 0 }), { maxP95Ms: 800 }).severity).toBe('breach');
  });

  it('treats a confident call-answer drop as critical', () => {
    const e = evaluateHealth(sum({ offered: 200, answered: 120 }, { offered: 200, answered: 190 }));
    expect(e.severity).toBe('critical');
  });

  it('judges answer rate only with enough offered calls', () => {
    expect(evaluateHealth(sum({ offered: 10, answered: 2 })).severity).toBe('ok');
  });

  it('answer-rate critical applies even when request volume is low', () => {
    expect(evaluateHealth(sum({ requests: 20, errors: 0, offered: 100, answered: 40 })).severity).toBe('critical');
  });

  it('survives a zero baseline without NaN', () => {
    expect(evaluateHealth({ canary: cohort(), baseline: { requests: 0, errors: 0, p95_ms: 0, offered: 0, answered: 0 } }).severity).toBe('ok');
  });
});

describe('decideAction', () => {
  const ok = { severity: 'ok' as const, reasons: [] };
  it('holds while soaking, promotes after the soak window', () => {
    expect(decideAction({ evaluation: ok, breachCount: 0, soakMinutes: 3 }).decision).toBe('hold');
    expect(decideAction({ evaluation: ok, breachCount: 1, soakMinutes: 12 })).toEqual({ decision: 'promote', nextBreachCount: 0, reasons: [] });
  });
  it('requires consecutive breaches before rolling back', () => {
    const breach = { severity: 'breach' as const, reasons: ['x'] };
    const first = decideAction({ evaluation: breach, breachCount: 0, soakMinutes: 20 });
    expect(first.decision).toBe('hold');
    expect(first.nextBreachCount).toBe(1);
    expect(decideAction({ evaluation: breach, breachCount: 1, soakMinutes: 20 }).decision).toBe('rollback');
  });
  it('rolls back immediately on a critical result', () => {
    expect(decideAction({ evaluation: { severity: 'critical', reasons: ['calls'] }, breachCount: 0, soakMinutes: 0 }).decision).toBe('rollback');
  });
  it('an insufficient tick neither promotes nor resets the breach count', () => {
    const a = decideAction({ evaluation: { severity: 'insufficient', reasons: ['few'] }, breachCount: 1, soakMinutes: 60 });
    expect(a.decision).toBe('hold');
    expect(a.nextBreachCount).toBe(1);
  });
  it('honours a custom breachesToRollback of 1', () => {
    expect(decideAction({ evaluation: { severity: 'breach', reasons: [] }, breachCount: 0, soakMinutes: 0, slo: { breachesToRollback: 1 } }).decision).toBe('rollback');
  });
});
