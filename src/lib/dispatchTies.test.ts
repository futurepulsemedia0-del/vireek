import { describe, it, expect } from 'vitest';
import { evaluateGate, nearTieStats, parseCandidates, powerPlan, tieSize, wilson, type DecisionLite } from './dispatchTies';

const cand = (id: string, score: number, eligible = true) => ({ technician_id: id, name: id, eligible, rank: null, score, summary: '', factors: [] });
const dec = (i: number, scores: number[], extra: Partial<DecisionLite> = {}): DecisionLite => ({
  id: `d${i}`, mode: 'auto', technician_id: 't1', note: null, created_at: new Date(Date.UTC(2027, 0, 1 + (i % 60))).toISOString(),
  explanation: { candidates: scores.map((s, j) => cand(`t${j + 1}`, s)) }, ...extra,
});

describe('parseCandidates', () => {
  it('ignores malformed input', () => {
    expect(parseCandidates(null)).toEqual([]);
    expect(parseCandidates({ candidates: 'x' })).toEqual([]);
    expect(parseCandidates({ candidates: [{ technician_id: 1, score: 2 }, { technician_id: 'a', score: NaN }] })).toEqual([]);
  });
});

describe('tieSize', () => {
  const c = [cand('a', 20), cand('b', 19.5), cand('c', 18), cand('x', 20, false)];
  it('counts only eligible candidates within eps of the best', () => {
    expect(tieSize(c, 0, 5)).toBe(1);
    expect(tieSize(c, 0.5, 5)).toBe(2);
    expect(tieSize(c, 2, 5)).toBe(3);
  });
  it('caps at k and returns 0 with no eligible candidate', () => {
    expect(tieSize(c, 2, 2)).toBe(2);
    expect(tieSize([cand('a', 1, false)], 5, 3)).toBe(0);
  });
});

describe('wilson', () => {
  it('is bounded and contains the point estimate', () => {
    const w = wilson(5, 100);
    expect(w.ciLow).toBeGreaterThan(0);
    expect(w.ciLow).toBeLessThan(0.05);
    expect(w.ciHigh).toBeGreaterThan(0.05);
    expect(wilson(0, 0).rate).toBe(0);
  });
});

describe('nearTieStats', () => {
  it('rate is monotone non-decreasing in eps and excludes gate-skipped and non-auto decisions', () => {
    const ds: DecisionLite[] = [
      ...Array.from({ length: 10 }, (_, i) => dec(i, [20, 20])),
      ...Array.from({ length: 10 }, (_, i) => dec(100 + i, [20, 19])),
      ...Array.from({ length: 80 }, (_, i) => dec(200 + i, [20, 10])),
      dec(300, [20, 20], { note: 'Skipped by system gates: x' }),
      dec(301, [20, 20], { mode: 'manual' }),
    ];
    const s = nearTieStats(ds, [1, 0, 3]);
    expect(s.stats.map((x) => x.eps)).toEqual([0, 1, 3]);
    expect(s.stats[0].tied.successes).toBe(10);
    expect(s.stats[1].tied.successes).toBe(20);
    expect(s.stats[2].tied.successes).toBe(20);
    expect(s.stats[0].denominator).toBe(100);
    expect(s.stats[0].gateSkipped).toBe(1);
    expect(s.autoDecisions).toBe(101);
  });
});

describe('powerPlan', () => {
  it('needs more jobs for smaller effects', () => {
    const rows = powerPlan({ tiedJobsPerMonth: 100, baselineRate: 0.85, mdeGrid: [0.02, 0.05, 0.1] });
    expect(rows[0].perArm!).toBeGreaterThan(rows[1].perArm!);
    expect(rows[1].perArm!).toBeGreaterThan(rows[2].perArm!);
    expect(rows[1].monthsNeeded!).toBeCloseTo((rows[1].perArm! * 2) / 100, 6);
  });
});

describe('evaluateGate', () => {
  const many = (rate: number, n = 400) => Array.from({ length: n }, (_, i) => dec(i, i < n * rate ? [20, 20] : [20, 5]));
  it('stops on insufficient data', () => {
    expect(evaluateGate(nearTieStats(many(0.5, 50), [0, 1, 2]), 0.85).verdict).toBe('INSUFFICIENT_DATA');
  });
  it('stops when ties are rare', () => {
    expect(evaluateGate(nearTieStats(many(0.02), [0, 1, 2]), 0.85).verdict).toBe('STOP_RARE_TIES');
  });
  it('stops when volume cannot detect the effect', () => {
    expect(evaluateGate(nearTieStats(many(0.06), [0, 1, 2]), 0.85).verdict).toBe('STOP_UNDERPOWERED');
  });
  it('passes with frequent ties and enough volume', () => {
    const ds = Array.from({ length: 6000 }, (_, i) => dec(i, i % 2 === 0 ? [20, 20] : [20, 5]));
    const out = evaluateGate(nearTieStats(ds, [0, 1, 2]), 0.85);
    expect(out.verdict).toBe('PASS');
    expect(out.epsChosen).toBe(0);
  });
});
