import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  MIN_SCORED_OUTCOMES,
  awaitingOutcome,
  calibrationGap,
  computeCalibrationError,
  computeOverrideRate,
  computeReliabilityScore,
  computeSuccessRate,
  formatCents,
  formatPct,
  formatRate,
  gradeFor,
  needsAttribution,
  policyLabel,
  shortHash,
  type AiMetricsTotals,
  type AiReliabilityMetrics,
  type CalibrationBin,
} from './aiGovernance';

function totals(overrides: Partial<AiMetricsTotals> = {}): AiMetricsTotals {
  return {
    total: 0,
    auto_approved: 0,
    review_required: 0,
    blocked: 0,
    pending_reviews: 0,
    approved: 0,
    rejected: 0,
    overridden: 0,
    executed: 0,
    outcomes_recorded: 0,
    successful: 0,
    partial: 0,
    failed: 0,
    no_effect: 0,
    wrong: 0,
    unattributed_failures: 0,
    avg_confidence: null,
    net_impact_cents: 0,
    ...overrides,
  };
}

function metrics(t: Partial<AiMetricsTotals>, calibration: CalibrationBin[] = []): AiReliabilityMetrics {
  return { window_days: 30, totals: totals(t), calibration, by_type: [], by_model: [], error_categories: [] };
}

describe('computeSuccessRate', () => {
  it('returns null when nothing is scored', () => {
    expect(computeSuccessRate({ successful: 0, partial: 0, failed: 0 })).toBeNull();
  });
  it('counts partial as half a success', () => {
    expect(computeSuccessRate({ successful: 6, partial: 2, failed: 2 })).toBeCloseTo(0.7);
  });
});

describe('computeCalibrationError', () => {
  it('is null without usable bins', () => {
    expect(computeCalibrationError([])).toBeNull();
    expect(computeCalibrationError([{ bin_start: 90, count: 5, avg_confidence: 95, success_rate: null }])).toBeNull();
  });
  it('is 0 for perfectly calibrated bins', () => {
    const bins: CalibrationBin[] = [
      { bin_start: 80, count: 10, avg_confidence: 85, success_rate: 0.85 },
      { bin_start: 90, count: 10, avg_confidence: 95, success_rate: 0.95 },
    ];
    expect(computeCalibrationError(bins)).toBeCloseTo(0);
  });
  it('weights the gap by bin size', () => {
    const bins: CalibrationBin[] = [
      { bin_start: 90, count: 30, avg_confidence: 95, success_rate: 0.65 }, // gap 0.30
      { bin_start: 50, count: 10, avg_confidence: 55, success_rate: 0.55 }, // gap 0
    ];
    expect(computeCalibrationError(bins)).toBeCloseTo(0.225);
  });
});

describe('calibrationGap', () => {
  it('is positive when over-confident and negative when under-confident', () => {
    expect(calibrationGap({ bin_start: 90, count: 10, avg_confidence: 95, success_rate: 0.7 })).toBe(25);
    expect(calibrationGap({ bin_start: 50, count: 10, avg_confidence: 55, success_rate: 0.8 })).toBe(-25);
  });
  it('is null when a value is missing', () => {
    expect(calibrationGap({ bin_start: 50, count: 1, avg_confidence: null, success_rate: 0.5 })).toBeNull();
  });
});

describe('computeOverrideRate', () => {
  it('is null before any human review', () => {
    expect(computeOverrideRate({ approved: 0, rejected: 0, overridden: 0 })).toBeNull();
  });
  it('counts rejects and overrides as disagreement', () => {
    expect(computeOverrideRate({ approved: 6, rejected: 2, overridden: 2 })).toBeCloseTo(0.4);
  });
});

describe('computeReliabilityScore', () => {
  it('refuses to guess with too little evidence', () => {
    const r = computeReliabilityScore(metrics({ successful: MIN_SCORED_OUTCOMES - 1 }));
    expect(r.score).toBeNull();
    expect(r.grade).toBeNull();
    expect(r.reason).toMatch(/at least/);
  });

  it('scores a healthy, well-calibrated system as excellent', () => {
    const r = computeReliabilityScore(
      metrics(
        { successful: 48, partial: 0, failed: 2, review_required: 10, pending_reviews: 0, executed: 50, outcomes_recorded: 50 },
        [{ bin_start: 90, count: 50, avg_confidence: 95, success_rate: 0.96 }],
      ),
    );
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.grade).toBe('excellent');
  });

  it('penalises over-confidence', () => {
    const calibrated = computeReliabilityScore(
      metrics({ successful: 30, failed: 10, executed: 40, outcomes_recorded: 40 }, [
        { bin_start: 70, count: 40, avg_confidence: 75, success_rate: 0.75 },
      ]),
    );
    const overConfident = computeReliabilityScore(
      metrics({ successful: 30, failed: 10, executed: 40, outcomes_recorded: 40 }, [
        { bin_start: 90, count: 40, avg_confidence: 95, success_rate: 0.75 },
      ]),
    );
    expect((calibrated.score as number) > (overConfident.score as number)).toBe(true);
  });

  it('drops components without data and renormalises the weights', () => {
    // No calibration bins, no reviews, nothing executed -> only "quality" remains.
    const r = computeReliabilityScore(metrics({ successful: 9, failed: 1 }));
    expect(r.score).toBe(90);
  });

  it('penalises an unresolved review backlog', () => {
    const base = { successful: 20, failed: 0, executed: 20, outcomes_recorded: 20, review_required: 10 };
    const clear = computeReliabilityScore(metrics({ ...base, pending_reviews: 0 }));
    const backlog = computeReliabilityScore(metrics({ ...base, pending_reviews: 10 }));
    expect((clear.score as number) > (backlog.score as number)).toBe(true);
  });
});

describe('gradeFor', () => {
  it('maps score bands', () => {
    expect(gradeFor(95)).toBe('excellent');
    expect(gradeFor(80)).toBe('good');
    expect(gradeFor(65)).toBe('fair');
    expect(gradeFor(10)).toBe('at_risk');
  });
});

describe('record helpers', () => {
  it('awaitingOutcome only when executed, pending outcome and not awaiting review', () => {
    expect(awaitingOutcome({ executed: true, outcome: 'pending', review_status: 'not_required' })).toBe(true);
    expect(awaitingOutcome({ executed: true, outcome: 'pending', review_status: 'pending' })).toBe(false);
    expect(awaitingOutcome({ executed: false, outcome: 'pending', review_status: 'not_required' })).toBe(false);
    expect(awaitingOutcome({ executed: true, outcome: 'successful', review_status: 'not_required' })).toBe(false);
  });
  it('needsAttribution for failures with no cause yet', () => {
    expect(needsAttribution({ outcome: 'failed', ai_was_wrong: null })).toBe(true);
    expect(needsAttribution({ outcome: 'failed', ai_was_wrong: false })).toBe(false);
    expect(needsAttribution({ outcome: 'successful', ai_was_wrong: null })).toBe(false);
  });
});

describe('formatting', () => {
  it('formats percentages and rates', () => {
    expect(formatPct(91.4)).toBe('91%');
    expect(formatPct(null)).toBe('—');
    expect(formatRate(0.914)).toBe('91%');
    expect(formatRate(undefined)).toBe('—');
  });
  it('formats cents', () => {
    expect(formatCents(12345)).toContain('123.45');
    expect(formatCents(-500)).toBe('-$5');
    expect(formatCents(null)).toBe('—');
  });
  it('shortens hashes and labels policies', () => {
    expect(shortHash('a'.repeat(64))).toBe('aaaaaaaa…aaaaaa');
    expect(shortHash(null)).toBe('—');
    expect(policyLabel('kill_switch')).toBe('Kill switch');
    expect(policyLabel('custom_rule')).toBe('custom rule');
  });
});
