import { describe, expect, it } from 'vitest';
import { calcCoopUnits, isRuleEarning, sumLedger } from './cooperativeBenefits';

const base = { records: 2500, cohorts: 4, unitsPer1000Records: 2, unitsPerCohort: 0.5, maxUnits30d: null, trailing30d: 0 };

describe('calcCoopUnits', () => {
  it('adds the per-record and per-cohort components', () => {
    expect(calcCoopUnits(base)).toBe(7); // 2.5 x 2 + 4 x 0.5
  });
  it('earns nothing when no rate is set (rules ship empty)', () => {
    expect(calcCoopUnits({ ...base, unitsPer1000Records: null, unitsPerCohort: null })).toBe(0);
  });
  it('clamps to the remaining 30-day headroom', () => {
    expect(calcCoopUnits({ ...base, maxUnits30d: 10, trailing30d: 6 })).toBe(4);
  });
  it('returns 0 when the cap is already used up or exceeded', () => {
    expect(calcCoopUnits({ ...base, maxUnits30d: 10, trailing30d: 10 })).toBe(0);
    expect(calcCoopUnits({ ...base, maxUnits30d: 10, trailing30d: 99 })).toBe(0);
  });
  it('treats negative or non-finite inputs as zero', () => {
    expect(calcCoopUnits({ ...base, records: -5, cohorts: Number.NaN })).toBe(0);
  });
  it('rounds to 4 decimals like the SQL numeric', () => {
    expect(calcCoopUnits({ ...base, records: 1, cohorts: 0, unitsPer1000Records: 0.33333333 })).toBe(0.0003);
  });
});

describe('isRuleEarning', () => {
  it('requires active and a rate', () => {
    expect(isRuleEarning({ active: false, units_per_1000_records: 1, units_per_cohort: null })).toBe(false);
    expect(isRuleEarning({ active: true, units_per_1000_records: null, units_per_cohort: null })).toBe(false);
    expect(isRuleEarning({ active: true, units_per_1000_records: null, units_per_cohort: 0.1 })).toBe(true);
  });
});

describe('sumLedger', () => {
  it('nets accruals, redemptions and adjustments', () => {
    expect(sumLedger([{ units: 7 }, { units: -2.5 }, { units: 0.25 }])).toBe(4.75);
  });
});
