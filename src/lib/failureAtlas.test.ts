import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  aggregateTechnicianOutcomes,
  atlasConfidence,
  bestPart,
  bestTest,
  formatAgeMonths,
  formatModelFamily,
  humanizeKey,
  optionLabel,
  ATLAS_SYMPTOMS,
  shrunkSuccessProbability,
  wilsonInterval,
} from './failureAtlas';

describe('formatAgeMonths', () => {
  it('formats years and months', () => {
    expect(formatAgeMonths(101)).toBe('8y 5m');
    expect(formatAgeMonths(24)).toBe('2y');
    expect(formatAgeMonths(7)).toBe('7m');
  });
  it('handles missing or invalid input', () => {
    expect(formatAgeMonths(null)).toBe('—');
    expect(formatAgeMonths(undefined)).toBe('—');
    expect(formatAgeMonths(-3)).toBe('—');
    expect(formatAgeMonths(Number.NaN)).toBe('—');
  });
});

describe('labels', () => {
  it('humanizes keys and falls back for unknown option keys', () => {
    expect(humanizeKey('bad_capacitor')).toBe('Bad capacitor');
    expect(optionLabel(ATLAS_SYMPTOMS, 'short_cycling')).toBe('Short cycling');
    expect(optionLabel(ATLAS_SYMPTOMS, 'weird_new_key')).toBe('Weird new key');
  });
  it('labels the brand-wide scope', () => {
    expect(formatModelFamily('*')).toBe('All models');
    expect(formatModelFamily('24acc6')).toBe('24ACC6');
  });
});

describe('wilsonInterval', () => {
  it('returns a full-width interval for empty samples', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 100 });
  });
  it('brackets the observed rate and stays inside [0,100]', () => {
    const { low, high } = wilsonInterval(18, 100);
    expect(low).toBeLessThan(18);
    expect(high).toBeGreaterThan(18);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(100);
  });
  it('tightens as the sample grows', () => {
    const small = wilsonInterval(2, 10);
    const large = wilsonInterval(200, 1000);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });
  it('is safe at the extremes', () => {
    expect(wilsonInterval(0, 50).low).toBe(0);
    expect(wilsonInterval(50, 50).high).toBe(100);
  });
});

describe('shrunkSuccessProbability', () => {
  it('returns the baseline when the technician has no history', () => {
    expect(shrunkSuccessProbability(0, 0, 80)).toBeCloseTo(0.8, 6);
  });
  it('does not let a tiny perfect record read as 100%', () => {
    const p = shrunkSuccessProbability(2, 2, 70);
    expect(p).toBeLessThan(0.9);
    expect(p).toBeGreaterThan(0.7);
  });
  it('converges to the technician record with a large sample', () => {
    expect(shrunkSuccessProbability(190, 200, 60)).toBeGreaterThan(0.9);
  });
  it('falls back to 50% prior when baseline is unknown and clamps bad input', () => {
    expect(shrunkSuccessProbability(0, 0, null)).toBeCloseTo(0.5, 6);
    expect(shrunkSuccessProbability(99, 5, 70)).toBeLessThanOrEqual(1);
    expect(shrunkSuccessProbability(-4, 5, 70)).toBeGreaterThanOrEqual(0);
  });
});

describe('atlasConfidence', () => {
  it('grades evidence strength', () => {
    expect(
      atlasConfidence({ units_observed: 400, contributor_count: 20, failure_events: 80 }),
    ).toBe('high');
    expect(atlasConfidence({ units_observed: 100, contributor_count: 9, failure_events: 20 })).toBe(
      'medium',
    );
    expect(atlasConfidence({ units_observed: 40, contributor_count: 5, failure_events: 10 })).toBe(
      'low',
    );
  });
});

describe('bestPart / bestTest', () => {
  const parts = [
    { part: 'universal capacitor', share_pct: 50, first_visit_fix_pct: 70, sample: 40 },
    { part: 'oem capacitor', share_pct: 20, first_visit_fix_pct: 92, sample: 16 },
    { part: 'rare thing', share_pct: 2, first_visit_fix_pct: 100, sample: 2 },
  ];
  it('ignores tiny samples when a solid option exists', () => {
    expect(bestPart({ top_parts: parts })?.part).toBe('oem capacitor');
  });
  it('falls back to the largest pool when nothing is solid', () => {
    expect(bestPart({ top_parts: [parts[2]] })?.part).toBe('rare thing');
    expect(bestPart({ top_parts: [] })).toBeNull();
  });
  it('picks the diagnostic test with the best first-visit-fix rate', () => {
    const tests = [
      { test: 'visual_inspection', first_visit_fix_pct: 55, sample: 30 },
      { test: 'capacitance_test', first_visit_fix_pct: 88, sample: 25 },
    ];
    expect(bestTest({ top_diagnostic_tests: tests })?.test).toBe('capacitance_test');
    expect(bestTest({ top_diagnostic_tests: [] })).toBeNull();
  });
});

describe('aggregateTechnicianOutcomes', () => {
  const names = new Map([
    ['t1', 'Ana'],
    ['t2', 'Ben'],
  ]);
  it('aggregates per technician, ignores unassigned jobs and ranks by shrunk probability', () => {
    const rows = [
      ...Array.from({ length: 10 }, () => ({
        technician_id: 't1',
        resolution: 'fixed_first_visit',
      })),
      { technician_id: 't2', resolution: 'fixed_first_visit' },
      { technician_id: 't2', resolution: 'fixed_followup' },
      { technician_id: null, resolution: 'fixed_first_visit' },
    ];
    const out = aggregateTechnicianOutcomes(rows, names, 70);
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('Ana');
    expect(out[0].jobs).toBe(10);
    expect(out[0].firstVisitFixes).toBe(10);
    expect(out[1].name).toBe('Ben');
    expect(out[0].successProbability).toBeGreaterThan(out[1].successProbability);
  });
  it('falls back to a generic name for unknown technicians', () => {
    const out = aggregateTechnicianOutcomes(
      [{ technician_id: 'zzz', resolution: 'fixed_first_visit' }],
      names,
      70,
    );
    expect(out[0].name).toBe('Technician');
  });
});
