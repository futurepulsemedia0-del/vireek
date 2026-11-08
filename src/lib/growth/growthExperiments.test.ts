import { describe, it, expect } from 'vitest';
import {
  analyzeGrowthExperiment,
  requiredPerArm,
  twoProportion,
  type ArmCounts,
  type ExperimentResultsRaw,
} from './growthExperiments';

const DAY = 86_400_000;
const NOW = new Date('2028-03-01T00:00:00Z');
const arm = (o: Partial<ArmCounts> = {}): ArmCounts => ({
  assigned: 200, activation_n: 200, activation_k: 60, trial_n: 0, trial_k: 0, paying_n: 100, cancel_k: 5, ...o,
});
const raw = (t: Partial<ArmCounts>, c: Partial<ArmCounts>, over: Partial<ExperimentResultsRaw['experiment']> = {}): ExperimentResultsRaw => ({
  experiment: {
    key: 'onb_checklist', status: 'running', treatment_share: 50, primary_metric: 'activated_7d', min_runtime_days: 14,
    alpha: 0.05, started_at: new Date(NOW.getTime() - 30 * DAY).toISOString(), ended_at: null, ...over,
  },
  arms: { treatment: arm(t), control: arm(c) },
});

describe('twoProportion', () => {
  it('matches a hand-computed example (45/100 vs 30/100)', () => {
    const r = twoProportion(45, 100, 30, 100, 1.959963984540054);
    expect(r?.effect).toBeCloseTo(0.15, 10);
    // pooled p=.375, se=sqrt(.375*.625*.02)=0.06846532 => z=2.19089
    expect(r?.z).toBeCloseTo(2.19089, 4);
    expect(r?.p).toBeCloseTo(0.02846, 3);
  });
  it('identical arms: z=0, p=1', () => {
    const r = twoProportion(10, 50, 10, 50, 1.96);
    expect(r?.z).toBe(0);
    expect(r?.p).toBeCloseTo(1, 6);
  });
  it('rejects impossible input', () => {
    expect(twoProportion(5, 0, 1, 10, 1.96)).toBeNull();
    expect(twoProportion(11, 10, 1, 10, 1.96)).toBeNull();
  });
});

describe('requiredPerArm', () => {
  it('20% baseline, +5pp, alpha .05, 80% power => ~1091', () => {
    const n = requiredPerArm(0.2, 0.05, 0.05);
    expect(n).toBeGreaterThan(1085);
    expect(n).toBeLessThan(1100);
  });
  it('invalid baseline returns null', () => {
    expect(requiredPerArm(0, 0.05, 0.05)).toBeNull();
    expect(requiredPerArm(0.97, 0.05, 0.05)).toBeNull();
  });
});

describe('analyzeGrowthExperiment', () => {
  it('SRM failure invalidates the experiment regardless of outcome', () => {
    const a = analyzeGrowthExperiment(raw({ assigned: 400 }, { assigned: 200 }), NOW);
    expect(a.verdict).toBe('invalid');
    expect(a.recommendation).toBe('fix_design');
  });
  it('never issues a verdict before the minimum runtime (no peeking)', () => {
    const started = new Date(NOW.getTime() - 3 * DAY).toISOString();
    const a = analyzeGrowthExperiment(raw({ activation_k: 90 }, { activation_k: 40 }, { started_at: started }), NOW);
    expect(a.verdict).toBe('collecting');
    expect(a.reasons).toContain('runtime_not_reached');
    expect(a.minRuntimeMet).toBe(false);
  });
  it('small cells => collecting', () => {
    const a = analyzeGrowthExperiment(raw({ assigned: 20, activation_n: 20, activation_k: 10 }, { assigned: 20, activation_n: 20, activation_k: 4 }), NOW);
    expect(a.verdict).toBe('collecting');
    expect(a.reasons).toContain('sample_below_minimum');
  });
  it('sparse binary events => collecting', () => {
    const a = analyzeGrowthExperiment(raw({ activation_k: 2 }, { activation_k: 0 }), NOW);
    expect(a.verdict).toBe('collecting');
    expect(a.reasons).toContain('too_few_events');
  });
  it('clear win with healthy guardrail => adopt', () => {
    const a = analyzeGrowthExperiment(raw({ activation_k: 90 }, { activation_k: 60 }), NOW);
    expect(a.verdict).toBe('win');
    expect(a.guardrail.status).toBe('ok');
    expect(a.recommendation).toBe('adopt');
  });
  it('win but guardrail breached => iterate, never adopt', () => {
    const a = analyzeGrowthExperiment(raw({ activation_k: 90, paying_n: 400, cancel_k: 120 }, { activation_k: 60, paying_n: 400, cancel_k: 40 }), NOW);
    expect(a.verdict).toBe('win');
    expect(a.guardrail.status).toBe('breached');
    expect(a.recommendation).toBe('iterate');
  });
  it('win with unknown guardrail (few payers) => adopt_monitor', () => {
    const a = analyzeGrowthExperiment(raw({ activation_k: 90, paying_n: 5, cancel_k: 0 }, { activation_k: 60, paying_n: 5, cancel_k: 0 }), NOW);
    expect(a.guardrail.status).toBe('unknown');
    expect(a.recommendation).toBe('adopt_monitor');
  });
  it('significant loss => reject', () => {
    const a = analyzeGrowthExperiment(raw({ activation_k: 60 }, { activation_k: 95 }), NOW);
    expect(a.verdict).toBe('loss');
    expect(a.recommendation).toBe('reject');
  });
  it('tight CI around zero => no_effect', () => {
    const big = { assigned: 5000, activation_n: 5000, activation_k: 1500 };
    const a = analyzeGrowthExperiment(raw(big, { ...big, activation_k: 1495 }), NOW);
    expect(a.verdict).toBe('no_effect');
  });
  it('wide CI, not significant => inconclusive', () => {
    const a = analyzeGrowthExperiment(raw({ activation_k: 66 }, { activation_k: 60 }), NOW);
    expect(a.verdict).toBe('inconclusive');
  });
  it('uses trial metric when it is primary', () => {
    const a = analyzeGrowthExperiment(
      raw({ trial_n: 100, trial_k: 45 }, { trial_n: 100, trial_k: 25 }, { primary_metric: 'trial_to_paid' }), NOW);
    expect(a.primary?.nT).toBe(100);
    expect(a.verdict).toBe('win');
  });
  it('missing arm => collecting', () => {
    const r = raw({}, {});
    delete r.arms.control;
    expect(analyzeGrowthExperiment(r, NOW).verdict).toBe('collecting');
  });
  it('concluded experiments measure runtime up to ended_at, not now', () => {
    const s = new Date(NOW.getTime() - 30 * DAY).toISOString();
    const e = new Date(NOW.getTime() - 20 * DAY).toISOString();
    const a = analyzeGrowthExperiment(raw({}, {}, { status: 'concluded', started_at: s, ended_at: e }), NOW);
    expect(Math.round(a.elapsedDays)).toBe(10);
  });
});
