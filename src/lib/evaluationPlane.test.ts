import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVAL_POLICY,
  assess,
  buildEvaluation,
  computeMetrics,
  type BinRow,
  type EvalDim,
} from './evaluationPlane';

/** Build bin rows for `n` predictions at probability `p` where `wins` of them had outcome 1. */
function rows(dim: EvalDim, seg: string, version: string, p: number, n: number, wins: number): BinRow {
  const losses = n - wins;
  return {
    dim,
    seg,
    version,
    bin: Math.min(9, Math.floor(p * 10)),
    n,
    sum_p: p * n,
    sum_y: wins,
    sum_sq: wins * (1 - p) ** 2 + losses * p ** 2,
  };
}

describe('computeMetrics', () => {
  it('returns nulls for an empty window', () => {
    const m = computeMetrics([]);
    expect(m.n).toBe(0);
    expect(m.brier).toBeNull();
    expect(m.ece).toBeNull();
  });

  it('is well calibrated when predicted ≈ actual', () => {
    const m = computeMetrics([rows('overall', 'all', 'v1', 0.8, 100, 80)]);
    expect(m.ece).toBeCloseTo(0, 5);
    expect(m.bias).toBeCloseTo(0, 5);
    expect(m.brier).toBeCloseTo(0.16, 4);
  });

  it('flags over-confidence with positive bias', () => {
    const m = computeMetrics([rows('overall', 'all', 'v1', 0.9, 100, 60)]);
    expect(m.bias).toBeCloseTo(0.3, 4);
    expect(m.ece).toBeCloseTo(0.3, 4);
  });

  it('has no skill when always predicting the base rate', () => {
    const m = computeMetrics([rows('overall', 'all', 'v1', 0.7, 100, 70)]);
    expect(m.skill).toBeCloseTo(0, 4);
  });
});

describe('assess', () => {
  const policy = DEFAULT_EVAL_POLICY;

  it('is insufficient below the minimum sample', () => {
    const m = computeMetrics([rows('overall', 'all', 'v1', 0.8, 10, 8)]);
    expect(assess(m, null, policy).status).toBe('insufficient');
  });

  it('marks drift as degrading even when static metrics are fine', () => {
    const cur = computeMetrics([rows('overall', 'all', 'v1', 0.5, 40, 22), rows('overall', 'all', 'v1', 0.9, 40, 36)]);
    const base = computeMetrics([rows('overall', 'all', 'v1', 0.5, 40, 22), rows('overall', 'all', 'v1', 0.9, 40, 37)]);
    const forced = { ...base, brier: (cur.brier ?? 0) - 0.04 };
    const a = assess(cur, forced, policy);
    expect(a.drift).toBeCloseTo(0.04, 3);
    expect(a.status).toBe('degrading');
  });

  it('marks a model worse than the base rate as poor', () => {
    const m = computeMetrics([rows('overall', 'all', 'v1', 0.9, 50, 25), rows('overall', 'all', 'v1', 0.1, 50, 25)]);
    expect(assess(m, null, policy).status).toBe('poor');
  });
});

describe('buildEvaluation', () => {
  it('surfaces a failing segment first and hides all-unknown dimensions', () => {
    // Informative model: confident-and-right on 40 jobs, coin-flip on 20.
    const good = (seg: string, dim: EvalDim = 'state') => [rows(dim, seg, 'v1', 0.9, 40, 36), rows(dim, seg, 'v1', 0.5, 20, 10)];
    // Same predictions, but the 0.9 bucket now only wins 28 of 40 (over-confident).
    const bad = (seg: string) => [rows('state', seg, 'v1', 0.9, 40, 28), rows('state', seg, 'v1', 0.5, 20, 10)];
    const current: BinRow[] = [
      ...good('all', 'overall'),
      ...good('TX'),
      ...bad('FL'),
      ...good('unknown', 'trade'),
    ];
    const baseline: BinRow[] = [...good('all', 'overall'), ...good('TX'), ...good('FL')];
    const ev = buildEvaluation(current, baseline);
    expect(ev.segments.some((s) => s.dim === 'trade')).toBe(false);
    expect(ev.segments[0].seg).toBe('FL');
    expect(ev.segments[0].assessment.status).toBe('poor');
    expect(ev.segments.find((s) => s.seg === 'TX')?.assessment.status).toBe('good');
  });

  it('compares the latest version with the previous one', () => {
    const current: BinRow[] = [
      rows('overall', 'all', 'v1', 0.7, 100, 60),
      rows('overall', 'all', 'v2', 0.7, 100, 70),
    ];
    const ev = buildEvaluation(current, []);
    expect(ev.comparison.latest).toBe('v2');
    expect(ev.comparison.verdict).toBe('latest_better');
  });

  it('refuses to compare versions without enough evidence', () => {
    const ev = buildEvaluation([rows('overall', 'all', 'v1', 0.7, 100, 70), rows('overall', 'all', 'v2', 0.7, 5, 4)], []);
    expect(ev.comparison.verdict).toBe('insufficient');
  });
});
