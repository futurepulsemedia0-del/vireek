import { describe, expect, it } from 'vitest';
import {
  brierTrend,
  coverageRows,
  dataCompletenessScore,
  describeEquipment,
  failedKindsFor,
  formatRateWithInterval,
  formatReason,
  gradeCalibration,
  settledCount,
  type LearningMetrics,
} from '@/lib/fieldIntelligence';

const metrics = (over: Partial<LearningMetrics> = {}): LearningMetrics => ({
  total_observations: 100,
  label_counts: { success: 60, partial: 10, failure: 10, ambiguous: 5, pending: 15 },
  adjudication_backlog: 5,
  human: { n: 0, override_rate: null },
  coverage: { with_equipment: 100, with_diagnosis: 50, with_parts: 80, with_technician: 100, multimodal: 10, with_cost: 70 },
  copilot_agreement: { n: 0, rate: null },
  ftf: null,
  assurance: null,
  ftf_brier_delta: null,
  ...over,
});

describe('gradeCalibration', () => {
  it('refuses to grade small samples', () => {
    expect(gradeCalibration({ n: 19, ece: 0.01 })).toBe('insufficient');
    expect(gradeCalibration(null)).toBe('insufficient');
  });
  it('grades by expected calibration error', () => {
    expect(gradeCalibration({ n: 50, ece: 0.04 })).toBe('excellent');
    expect(gradeCalibration({ n: 50, ece: 0.09 })).toBe('good');
    expect(gradeCalibration({ n: 50, ece: 0.15 })).toBe('fair');
    expect(gradeCalibration({ n: 50, ece: 0.3 })).toBe('poor');
  });
});

describe('coverage', () => {
  it('lists the weakest chain link first', () => {
    const rows = coverageRows(metrics());
    expect(rows[0].key).toBe('multimodal');
    expect(rows[1].key).toBe('with_diagnosis');
  });
  it('averages only the five core links', () => {
    expect(dataCompletenessScore(metrics())).toBeCloseTo((1 + 0.5 + 0.8 + 1 + 0.7) / 5, 5);
  });
  it('returns nothing without observations', () => {
    expect(coverageRows(metrics({ total_observations: 0 }))).toEqual([]);
    expect(dataCompletenessScore(null)).toBeNull();
  });
});

describe('formatting', () => {
  it('shows the interval next to the rate', () => {
    expect(formatRateWithInterval(0.62, 0.41, 0.78)).toBe('62% (41%–78%)');
    expect(formatRateWithInterval(null, null, null)).toBe('—');
  });
  it('explains outcome reasons', () => {
    expect(formatReason('soft_signals:2')).toContain('2 soft signals');
    expect(formatReason('callback')).toBe('Callback after the visit');
    expect(formatReason('some_new_reason')).toBe('some new reason');
  });
  it('describes equipment with age', () => {
    expect(describeEquipment({ equipment_make: 'Carrier', equipment_model: '24ACC6', equipment_type: 'ac', equipment_age_months: 135 })).toBe('Carrier 24ACC6 · 11 yr old');
    expect(describeEquipment({ equipment_make: null, equipment_model: null, equipment_type: null, equipment_age_months: null })).toBe('Equipment not linked');
  });
});

describe('metrics helpers', () => {
  it('counts only settled outcomes', () => {
    expect(settledCount(metrics().label_counts)).toBe(80);
  });
  it('reads the Brier trend direction', () => {
    expect(brierTrend(-0.02)?.text).toContain('Improving');
    expect(brierTrend(0.03)?.text).toContain('Degrading');
    expect(brierTrend(0.001)?.text).toBe('Stable vs last run');
    expect(brierTrend(null)).toBeNull();
  });
  it('never sends failed kinds for a success verdict', () => {
    expect(failedKindsFor('success', ['part'])).toEqual([]);
    expect(failedKindsFor('failure', ['part'])).toEqual(['part']);
  });
});
