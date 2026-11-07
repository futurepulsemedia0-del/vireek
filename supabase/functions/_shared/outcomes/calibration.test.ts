import { describe, it, expect } from 'vitest';
import {
  assessPredictor, brierScore, brierSkillScore, calibrationDrift, expectedCalibrationError, reliabilityBins, type Prediction,
} from './calibration';

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

function sample(n: number, seed: number, truth: (p: number) => number): Prediction[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => { const p = r(); return { p, y: r() < truth(p) ? 1 : 0 } as Prediction; });
}

describe('brierScore', () => {
  it('is 0 for perfect and 1 for maximally wrong predictions', () => {
    expect(brierScore([{ p: 1, y: 1 }, { p: 0, y: 0 }])).toBe(0);
    expect(brierScore([{ p: 1, y: 0 }, { p: 0, y: 1 }])).toBe(1);
  });
  it('matches a hand computed value', () => {
    expect(brierScore([{ p: 0.8, y: 1 }, { p: 0.4, y: 0 }])).toBeCloseTo(0.1, 10);
  });
  it('ignores invalid probabilities and returns null when empty', () => {
    expect(brierScore([{ p: 2, y: 1 }, { p: NaN, y: 0 }])).toBeNull();
  });
});

describe('reliability bins / ECE', () => {
  it('puts p=1 in the last bin and p=0 in the first', () => {
    const bins = reliabilityBins([{ p: 1, y: 1 }, { p: 0, y: 0 }]);
    expect(bins[9].n).toBe(1);
    expect(bins[0].n).toBe(1);
  });
  it('a well calibrated predictor has small ECE, a miscalibrated one large ECE', () => {
    const good = sample(5000, 1, (p) => p);
    const bad = sample(5000, 2, (p) => 1 - p);
    expect(expectedCalibrationError(reliabilityBins(good))!).toBeLessThan(0.04);
    expect(expectedCalibrationError(reliabilityBins(bad))!).toBeGreaterThan(0.3);
  });
});

describe('assessPredictor', () => {
  it('insufficient data never demotes', () => {
    const a = assessPredictor(sample(20, 3, (p) => 1 - p));
    expect(a.status).toBe('insufficient_data');
    expect(a.weight).toBe(1);
  });
  it('demotes a miscalibrated predictor (weight 0) and keeps a calibrated one', () => {
    expect(assessPredictor(sample(500, 4, (p) => 1 - p)).status).toBe('demote');
    const ok = assessPredictor(sample(2000, 5, (p) => p));
    expect(ok.status).toBe('ok');
    expect(ok.weight).toBe(1);
  });
  it('a predictor no better than the base rate has non-positive skill and is demoted', () => {
    const r = rng(6);
    const preds: Prediction[] = Array.from({ length: 800 }, () => ({ p: r() < 0.5 ? 0.9 : 0.1, y: r() < 0.5 ? 1 : 0 }));
    expect(brierSkillScore(preds)!).toBeLessThan(0);
    expect(assessPredictor(preds).status).toBe('demote');
  });
});

describe('calibrationDrift', () => {
  it('detects degradation between windows and stays quiet when stable', () => {
    const prior = sample(800, 7, (p) => p);
    const stable = sample(800, 8, (p) => p);
    const drifted = sample(800, 9, (p) => Math.max(0, Math.min(1, p * 0.4)));
    expect(calibrationDrift(prior, stable).drifted).toBe(false);
    expect(calibrationDrift(prior, drifted).drifted).toBe(true);
  });
  it('does not flag drift with too little data', () => {
    expect(calibrationDrift(sample(10, 1, (p) => p), sample(10, 2, (p) => 1 - p)).drifted).toBe(false);
  });
});
