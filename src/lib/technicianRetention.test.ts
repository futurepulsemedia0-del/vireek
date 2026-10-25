import { describe, it, expect } from 'vitest';
import {
  actionImpact, bandForScore, canViewRetention, DRIVER_WEIGHTS, filterByBand, formatTenure, formatUsd,
  sortScores, summarize, type RetentionAction, type TechRiskScore,
} from './technicianRetention';

function score(o: Partial<TechRiskScore> = {}): TechRiskScore {
  return {
    id: 's', tech_id: 't', week: '2026-10-19', score: 30, risk_band: 'elevated', data_quality: 'ok', confidence: 1,
    top_drivers: [], attrition_probability: 0.2, est_replacement_cost: 20000, expected_annual_cost: 4000,
    score_delta: null, computed_at: '2026-10-25T00:00:00Z', is_demo: false, ...o,
  };
}
function action(o: Partial<RetentionAction> = {}): RetentionAction {
  return {
    id: 'a', tech_id: 't', action_type: 'manager_one_on_one', driver_key: 'overtime', title: '', detail: '', params: {},
    status: 'suggested', baseline_score: null, outcome: null, score_after: null, decided_at: null, created_at: '', ...o,
  };
}

describe('bands', () => {
  it('uses the same thresholds as the engine', () => {
    expect(bandForScore(49)).toBe('elevated');
    expect(bandForScore(50)).toBe('high');
    expect(bandForScore(24)).toBe('low');
    expect(bandForScore(25)).toBe('elevated');
  });
  it('driver weights sum to 100', () => {
    expect(Object.values(DRIVER_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('sort / filter', () => {
  const list = [
    score({ tech_id: 'low', score: 5, risk_band: 'low', expected_annual_cost: 1000 }),
    score({ tech_id: 'hi-small', score: 60, risk_band: 'high', expected_annual_cost: 9000 }),
    score({ tech_id: 'hi-big', score: 80, risk_band: 'high', expected_annual_cost: 15000 }),
    score({ tech_id: 'none', score: 0, risk_band: 'insufficient' }),
  ];
  it('sorts by band then score; insufficient last', () => {
    expect(sortScores(list, 'risk').map((s) => s.tech_id)).toEqual(['hi-big', 'hi-small', 'low', 'none']);
  });
  it('sorts by expected cost', () => {
    expect(sortScores(list, 'cost')[0].tech_id).toBe('hi-big');
  });
  it('does not mutate the input and filters by band', () => {
    const copy = [...list];
    sortScores(list, 'risk');
    expect(list).toEqual(copy);
    expect(filterByBand(list, 'high')).toHaveLength(2);
    expect(filterByBand(list, 'all')).toHaveLength(4);
  });
});

describe('summarize', () => {
  it('handles an empty team', () => {
    expect(summarize([])).toEqual({ total: 0, high: 0, elevated: 0, low: 0, insufficient: 0, yearlyAttritionCost: 0, costAtRisk: 0 });
  });
  it('totals yearly cost and cost at risk', () => {
    const s = summarize([
      score({ risk_band: 'high', expected_annual_cost: 10000, est_replacement_cost: 25000 }),
      score({ risk_band: 'low', expected_annual_cost: 2000, est_replacement_cost: 20000 }),
      score({ risk_band: 'insufficient', expected_annual_cost: 2700, est_replacement_cost: 15000 }),
    ]);
    expect(s.yearlyAttritionCost).toBe(14700);
    expect(s.costAtRisk).toBe(25000);
    expect(s.high).toBe(1);
    expect(s.insufficient).toBe(1);
  });
});

describe('actionImpact', () => {
  it('counts only approved actions and their measured outcomes', () => {
    const i = actionImpact([
      action({ status: 'approved', outcome: 'improved' }),
      action({ status: 'approved', outcome: 'worsened' }),
      action({ status: 'approved' }),
      action({ status: 'suggested', outcome: 'improved' }),
    ]);
    expect(i).toEqual({ approved: 3, measured: 2, improved: 1, worsened: 1 });
  });
});

describe('formatting & access', () => {
  it('formats USD without cents and survives a bad locale', () => {
    expect(formatUsd(12345, 'en-US')).toBe('$12,345');
    expect(formatUsd(5, 'not a locale!!')).toBe('$5');
  });
  it('formats tenure', () => {
    expect(formatTenure(10)).toEqual({ unit: 'days', value: 10 });
    expect(formatTenure(180)).toEqual({ unit: 'months', value: 6 });
    expect(formatTenure(1095)).toEqual({ unit: 'years', value: 3 });
  });
  it('only owners, admins and managers can view', () => {
    expect(canViewRetention(true, null)).toBe(true);
    expect(canViewRetention(false, 'manager')).toBe(true);
    expect(canViewRetention(false, 'admin')).toBe(true);
    expect(canViewRetention(false, 'technician')).toBe(false);
    expect(canViewRetention(false, undefined)).toBe(false);
  });
});
