import { describe, it, expect } from 'vitest';
import { boundedStep, chooseVariant, rollbackDecision, shrunkRate } from './policyLearning';

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

describe('shrunkRate', () => {
  it('pulls tiny samples toward the prior and converges with data', () => {
    expect(shrunkRate(3, 3)).toBeCloseTo(0.6154, 3);
    expect(shrunkRate(900, 1000)).toBeCloseTo(0.8960, 3);
  });
});

describe('chooseVariant', () => {
  it('prefers the best variant and keeps exploration under the cap', () => {
    const r = rng(11);
    const vs = [{ key: 'a', k: 80, n: 100 }, { key: 'b', k: 40, n: 100 }, { key: 'c', k: 30, n: 100 }];
    let explored = 0, a = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) { const c = chooseVariant(vs, r, 0.1)!; if (c.explored) explored++; if (c.key === 'a') a++; }
    expect(explored / N).toBeLessThan(0.12);
    expect(a / N).toBeGreaterThan(0.88);
  });
  it('hard-caps exploration at 20% even if asked for more', () => {
    const r = rng(12);
    const vs = [{ key: 'a', k: 9, n: 10 }, { key: 'b', k: 1, n: 10 }];
    let explored = 0; const N = 10000;
    for (let i = 0; i < N; i++) if (chooseVariant(vs, r, 0.9)!.explored) explored++;
    expect(explored / N).toBeLessThan(0.22);
  });
  it('returns null for no variants', () => { expect(chooseVariant([], rng(1))).toBeNull(); });
});

describe('boundedStep', () => {
  it('never moves more than the step bound or outside the range', () => {
    expect(boundedStep(0.5, 1, 0.1, 0, 1)).toBeCloseTo(0.6, 10);
    expect(boundedStep(0.95, 5, 0.5, 0, 1)).toBe(1);
    expect(boundedStep(0.2, -3, 0.1, 0, 1)).toBeCloseTo(0.1, 10);
  });
});

describe('rollbackDecision (auto-rollback of a degrading change)', () => {
  const base = { baselineK: 92, baselineN: 100 }; // baseline success 92%
  it('rolls back a relax change whose outcomes degraded', () => {
    const d = rollbackDecision({ kind: 'relax_approval', ...base, postK: 10, postN: 40, windowElapsed: false });
    expect(d.action).toBe('rollback');
    expect(d.reason).toBe('outcomes_degraded');
  });
  it('keeps monitoring while healthy and confirms when the window ends', () => {
    expect(rollbackDecision({ kind: 'relax_approval', ...base, postK: 37, postN: 40, windowElapsed: false }).action).toBe('continue');
    expect(rollbackDecision({ kind: 'relax_approval', ...base, postK: 37, postN: 40, windowElapsed: true }).action).toBe('confirm');
  });
  it('does not roll back on a few early failures (needs minimum post data)', () => {
    expect(rollbackDecision({ kind: 'relax_approval', ...base, postK: 0, postN: 5, windowElapsed: false }).action).toBe('continue');
  });
  it('fails safe: relax change with no evidence at window end is rolled back; tighten is confirmed', () => {
    expect(rollbackDecision({ kind: 'relax_approval', ...base, postK: 3, postN: 3, windowElapsed: true }).action).toBe('rollback');
    expect(rollbackDecision({ kind: 'tighten_approval', ...base, postK: 3, postN: 3, windowElapsed: true }).action).toBe('confirm');
  });
  it('a missing baseline never lets a relax change stand', () => {
    expect(rollbackDecision({ kind: 'relax_approval', baselineK: 0, baselineN: 0, postK: 0, postN: 0, windowElapsed: false }).action).toBe('rollback');
  });
});
