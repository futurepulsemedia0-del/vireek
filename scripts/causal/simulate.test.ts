import { describe, it, expect } from 'vitest';
import { simulateTenant } from './simulate';
import { runStudy } from './study';

const SEEDS = 200;
const TIMEOUT = 240_000;

describe('simulation harness (ground truth)', () => {
  it('is deterministic for a seed and logs correct propensities', () => {
    const a = simulateTenant({ seed: 3, jobs: 500 });
    const b = simulateTenant({ seed: 3, jobs: 500 });
    expect(JSON.stringify(a.rows)).toBe(JSON.stringify(b.rows));
    for (const r of a.rows) {
      expect(Math.abs(r.members.reduce((s, m) => s + m.p, 0) - 1)).toBeLessThan(1e-9);
      expect(r.members.length).toBeGreaterThanOrEqual(2);
    }
  });

  const main = runStudy({ jobs: 6000 }, SEEDS);
  const small = runStudy({ jobs: 600 }, SEEDS);

  it(`(a) naive observational contrast is biased for senior technicians; AIPW is not (${SEEDS} seeds)`, () => {
    expect(main.biasNaiveSenior).toBeLessThan(-0.015);
    expect(Math.abs(main.biasAipwSenior)).toBeLessThan(0.005);
  }, TIMEOUT);

  it(`(b) IPW and AIPW recover truth on average (|mean bias| < 0.005) across ${SEEDS} seeds`, () => {
    expect(main.seeds).toBeGreaterThanOrEqual(200);
    expect(Math.abs(main.biasAipw)).toBeLessThan(0.005);
    expect(Math.abs(main.biasIpw)).toBeLessThan(0.005);
    expect(main.rmseAipw).toBeLessThan(main.rmseIpw); // doubly robust variance reduction
  }, TIMEOUT);

  it('(c) raw 95% interval coverage is within 0.90–0.97', () => {
    expect(main.coverageRaw).toBeGreaterThan(0.9);
    expect(main.coverageRaw).toBeLessThan(0.97);
    expect(small.coverageRaw).toBeGreaterThan(0.9);
  }, TIMEOUT);

  it('(d) shrinkage reduces error at small n (and at moderate n)', () => {
    expect(small.rmseShrunk).toBeLessThan(0.6 * small.rmseAipw);
    expect(main.rmseShrunk).toBeLessThan(main.rmseAipw);
  }, TIMEOUT);

  // KNOWN FINDING (see docs/_audit/causal-network-report.md): shrunk intervals undercover at moderate n even after the
  // documented SE inflation. This guard fails if it gets WORSE; it does not claim the interval is calibrated.
  it('guard: shrunk interval coverage does not fall below the measured floor (0.80)', () => {
    expect(main.coverageShrunk).toBeGreaterThan(0.8);
    expect(small.coverageShrunk).toBeGreaterThan(0.8);
  }, TIMEOUT);

  it('nothing is reportable at small n (honest "not enough data")', () => {
    expect(small.reportableShare).toBeLessThan(0.01);
  }, TIMEOUT);
});
