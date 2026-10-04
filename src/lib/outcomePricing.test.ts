import { describe, it, expect } from 'vitest';
import {
  type AssetInput,
  creditForPeriod,
  DEFAULT_CREDIT_SCHEDULE,
  estimateFailureRate,
  pmReduction,
  priceOutcomeGuarantee,
  validatePricingInput,
} from './outcomePricing';

function asset(over: Partial<AssetInput> & { id: string }): AssetInput {
  return {
    label: over.id,
    equipmentType: 'Rooftop RTU',
    ageYears: 8,
    expectedLifespanYears: 15,
    serviceIntervalMonths: 12,
    monthsSinceService: 10,
    observedFailures: 2,
    observedYears: 3,
    operatingHoursPerYear: 8760,
    downtimeCostPerHour: 250,
    ...over,
  };
}

const PORTFOLIO = [
  asset({ id: 'rtu1' }),
  asset({ id: 'chiller1', equipmentType: 'Chiller', ageYears: 12, observedFailures: 1 }),
  asset({ id: 'walkin', equipmentType: 'Walk-in cooler', ageYears: 6, observedFailures: 4 }),
];

describe('priceOutcomeGuarantee', () => {
  it('is deterministic', () => {
    const a = priceOutcomeGuarantee({ assets: PORTFOLIO, targetUptimePct: 98, termMonths: 36 });
    const b = priceOutcomeGuarantee({ assets: PORTFOLIO, targetUptimePct: 98, termMonths: 36 });
    expect(a.priceMonthlyCents).toBe(b.priceMonthlyCents);
    expect(a.risk).toEqual(b.risk);
  });

  it('keeps cents consistent: annual = 12 x monthly = sum of assets', () => {
    const r = priceOutcomeGuarantee({ assets: PORTFOLIO, targetUptimePct: 98, termMonths: 36 });
    expect(r.priceAnnualCents).toBe(r.priceMonthlyCents * 12);
    expect(r.assets.reduce((s, a) => s + a.priceAnnualCents, 0)).toBe(r.priceAnnualCents);
    expect(r.priceTermCents).toBe(r.priceAnnualCents * 3);
  });

  it('price components add up to the annual price', () => {
    const r = priceOutcomeGuarantee({ assets: PORTFOLIO, targetUptimePct: 98, termMonths: 12 });
    const sum = Object.values(r.components).reduce((s, n) => s + n, 0);
    expect(Math.abs(sum - r.priceAnnualCents / 100)).toBeLessThan(1);
  });

  it('never prices a higher target below a lower one', () => {
    const r = priceOutcomeGuarantee({ assets: PORTFOLIO, targetUptimePct: 98, termMonths: 12 });
    const offerable = r.curve.filter((p) => p.decision !== 'not_offerable');
    for (let i = 1; i < offerable.length; i++) {
      expect(offerable[i].priceAnnual).toBeGreaterThan(offerable[i - 1].priceAnnual - 0.5);
    }
  });

  it('refuses a guarantee it cannot deliver', () => {
    const hard = [
      asset({ id: 'old', equipmentType: 'Walk-in freezer', ageYears: 16, observedFailures: 9, operatingHoursPerYear: 2600 }),
      asset({ id: 'old2', ageYears: 15, observedFailures: 7, operatingHoursPerYear: 2600 }),
    ];
    const r = priceOutcomeGuarantee({ assets: hard, targetUptimePct: 99.9, termMonths: 12 });
    expect(r.decision).toBe('not_offerable');
    expect(r.priceAnnualCents).toBe(0);
    expect(r.assets.every((a) => !a.feasible)).toBe(true);
  });

  it('sends thin-history quotes to review', () => {
    const r = priceOutcomeGuarantee({
      assets: [asset({ id: 'new', equipmentType: 'Boiler', ageYears: 2, observedFailures: 0, observedYears: 0 })],
      targetUptimePct: 98,
      termMonths: 12,
    });
    expect(r.decision).toBe('needs_review');
    expect(r.dataConfidence).toBe(0);
  });

  it('pools risk: per-asset price falls as the portfolio grows', () => {
    const one = priceOutcomeGuarantee({ assets: [asset({ id: 'a0' })], targetUptimePct: 98, termMonths: 12 });
    const many = priceOutcomeGuarantee({
      assets: Array.from({ length: 12 }, (_, i) => asset({ id: `a${i}` })),
      targetUptimePct: 98,
      termMonths: 12,
    });
    expect(many.priceAnnualCents / 12).toBeLessThan(one.priceAnnualCents);
    expect(many.risk.probabilityOfLoss).toBeLessThan(one.risk.probabilityOfLoss);
  });

  it('rejects invalid input', () => {
    expect(() => priceOutcomeGuarantee({ assets: [], targetUptimePct: 98, termMonths: 12 })).toThrow();
    expect(validatePricingInput({ assets: PORTFOLIO, targetUptimePct: 70, termMonths: 12 })).toHaveLength(1);
    expect(validatePricingInput({ assets: PORTFOLIO, targetUptimePct: 98, termMonths: 0 })).toHaveLength(1);
  });
});

describe('failure model', () => {
  it('moves toward observed history and gains confidence', () => {
    const quiet = estimateFailureRate(asset({ id: 'q', observedFailures: 0, observedYears: 3 }), 1);
    const noisy = estimateFailureRate(asset({ id: 'n', observedFailures: 9, observedYears: 3 }), 1);
    expect(noisy.baseRate).toBeGreaterThan(quiet.baseRate);
    expect(estimateFailureRate(asset({ id: 'x', observedYears: 6 }), 1).dataConfidence).toBeGreaterThan(
      estimateFailureRate(asset({ id: 'y', observedYears: 1 }), 1).dataConfidence
    );
  });

  it('PM reduction rises with diminishing returns and stays under the ceiling', () => {
    expect(pmReduction(0, 12)).toBe(0);
    expect(pmReduction(2, 12)).toBeGreaterThan(pmReduction(1, 12));
    expect(pmReduction(12, 12)).toBeLessThan(0.55);
    expect(pmReduction(2, 12) - pmReduction(1, 12)).toBeLessThan(pmReduction(1, 12) - pmReduction(0, 12));
  });
});

describe('creditForPeriod', () => {
  it('follows the tier boundaries', () => {
    expect(creditForPeriod(98.5, 98, DEFAULT_CREDIT_SCHEDULE)).toBe(0);
    expect(creditForPeriod(98, 98, DEFAULT_CREDIT_SCHEDULE)).toBe(0);
    expect(creditForPeriod(97.6, 98, DEFAULT_CREDIT_SCHEDULE)).toBe(5);
    expect(creditForPeriod(96.5, 98, DEFAULT_CREDIT_SCHEDULE)).toBe(15);
    expect(creditForPeriod(95.5, 98, DEFAULT_CREDIT_SCHEDULE)).toBe(30);
    expect(creditForPeriod(50, 98, DEFAULT_CREDIT_SCHEDULE)).toBe(50);
  });
});
