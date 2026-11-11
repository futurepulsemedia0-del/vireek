import { describe, it, expect } from 'vitest';
import { DEFAULT_ENTERPRISE_RATES, MARGIN_WARNING_THRESHOLD, isBelowMarginWarning, quoteEnterprise, type EnterpriseQuoteInput } from './enterpriseQuote';

const base: EnterpriseQuoteInput = { committedMinutes: 6000, seats: 40, locations: 3, phoneNumbers: 0, smsPerMonth: 0, supportMonthly: 0 };
const withMinutes = (committedMinutes: number, extra: Partial<EnterpriseQuoteInput> = {}) => quoteEnterprise({ ...base, committedMinutes, ...extra });

describe('documented defaults', () => {
  it('match the spec constants', () => {
    expect(DEFAULT_ENTERPRISE_RATES.voiceCostPerMinute).toBe(0.107);
    expect(DEFAULT_ENTERPRISE_RATES.nonVoiceBase).toBe(323);
    expect(DEFAULT_ENTERPRISE_RATES.targetGrossMargin).toBe(0.45);
    expect(DEFAULT_ENTERPRISE_RATES.overageCentsPerMinute).toBe(20);
    expect(MARGIN_WARNING_THRESHOLD).toBe(0.4);
    expect(Object.isFrozen(DEFAULT_ENTERPRISE_RATES)).toBe(true);
  });
});

describe('boundary volumes', () => {
  it('6,000 min is about $1,799 (floor $1,754.55 rounds up to $1,800)', () => {
    const q = withMinutes(6000);
    expect(q.monthlyFloorCents).toBe(175455);
    expect(q.listPriceCents).toBe(180000);
    expect(Math.abs(q.listPriceCents - 179900)).toBeLessThanOrEqual(100);
    expect(q.overageCentsPerMinute).toBe(20);
  });
  it('2,000 min is held at the $1,799 minimum list price', () => {
    const q = withMinutes(2000);
    expect(q.monthlyFloorCents).toBe(97637); // (214 + 323) / 0.55 = 976.36
    expect(q.listPriceCents).toBe(179900);
  });
  it('10,000 min rounds the floor up to the next $50', () => {
    const q = withMinutes(10000);
    expect(q.monthlyFloorCents).toBe(253273);
    expect(q.listPriceCents).toBe(255000);
  });
  it('0 minutes still honours the minimum price', () => {
    expect(withMinutes(0).listPriceCents).toBe(179900);
  });
});

describe('floor slope', () => {
  it('each extra 1,000 committed minutes raises the floor by about $195', () => {
    for (const m of [6000, 7000, 12000]) {
      const delta = (withMinutes(m + 1000).monthlyFloorCents - withMinutes(m).monthlyFloorCents) / 100;
      expect(Math.abs(delta - 195)).toBeLessThanOrEqual(1);
    }
  });
});

describe('rounding', () => {
  const rates = { voiceCostPerMinute: 0, nonVoiceBase: 1100, targetGrossMargin: 0.45 };
  it('a floor that is exactly a multiple of $50 is not bumped up', () => {
    const q = quoteEnterprise({ ...base, committedMinutes: 0 }, rates);
    expect(q.monthlyFloorCents).toBe(200000);
    expect(q.listPriceCents).toBe(200000);
  });
  it('one cent over a $50 multiple rounds to the next step', () => {
    const q = quoteEnterprise({ ...base, committedMinutes: 0 }, { ...rates, nonVoiceBase: 1100.01 });
    expect(q.monthlyFloorCents).toBe(200002);
    expect(q.listPriceCents).toBe(205000);
  });
  it('always returns whole-cent integers', () => {
    const q = withMinutes(7311, { smsPerMonth: 4321, phoneNumbers: 7, supportMonthly: 199.99, discount: 0.1234 });
    for (const v of [q.monthlyFloorCents, q.listPriceCents, q.onboardingCents, q.annualContractCents]) expect(Number.isInteger(v)).toBe(true);
  });
});

describe('non-voice cost inputs', () => {
  it('adds SMS, phone number and support costs before the margin gross-up', () => {
    const q = quoteEnterprise({ ...base, committedMinutes: 0, smsPerMonth: 10000, phoneNumbers: 10, supportMonthly: 100 }, { minListPriceUsd: 0 });
    // (10000 × 0.0118 + 10 × 1.15 + 100 + 323) / 0.55 = 552.5 / 0.55 = 1004.55
    expect(q.monthlyFloorCents).toBe(100455);
  });
  it('fixedAllocation input overrides nonVoiceBase', () => {
    const a = quoteEnterprise({ ...base, fixedAllocation: 0 }, { minListPriceUsd: 0 });
    expect(a.monthlyFloorCents).toBe(116728); // 642 / 0.55
  });
  it('seats do not change the price', () => {
    expect(withMinutes(6000, { seats: 5 })).toEqual(withMinutes(6000, { seats: 5000 }));
  });
});

describe('onboarding and annual contract', () => {
  it('onboarding is at least $2,500 and grows with locations', () => {
    expect(withMinutes(6000, { locations: 1 }).onboardingCents).toBe(250000);
    expect(withMinutes(6000, { locations: 5 }).onboardingCents).toBe(250000);
    expect(withMinutes(6000, { locations: 8 }).onboardingCents).toBe(400000);
  });
  it('annual is 12 × list with no discount', () => {
    expect(withMinutes(6000).annualContractCents).toBe(12 * 180000);
  });
  it('annual applies a given discount', () => {
    expect(withMinutes(6000, { discount: 0.1 }).annualContractCents).toBe(Math.round(12 * 180000 * 0.9));
  });
});

describe('margin warning', () => {
  it('a full-price quote clears the 40% threshold', () => {
    const q = withMinutes(6000);
    expect(q.grossMarginAtFullUse).toBeGreaterThan(0.45);
    expect(isBelowMarginWarning(q)).toBe(false);
  });
  it('a 20% discount drops margin below 40% and warns', () => {
    const q = withMinutes(6000, { discount: 0.2 });
    expect(q.grossMarginAtFullUse).toBeLessThan(0.4);
    expect(isBelowMarginWarning(q)).toBe(true);
  });
  it('a quote exactly at the threshold does not warn', () => {
    expect(isBelowMarginWarning({ grossMarginAtFullUse: 0.4 })).toBe(false);
    expect(isBelowMarginWarning({ grossMarginAtFullUse: 0.3999 })).toBe(true);
  });
  it('the floor itself meets the target margin', () => {
    const q = withMinutes(10000, { discount: 0 });
    expect(q.grossMarginAtFullUse).toBeGreaterThanOrEqual(0.45);
  });
});

describe('rate overrides and validation', () => {
  it('rates are overridable and do not mutate the defaults', () => {
    const q = quoteEnterprise(base, { targetGrossMargin: 0.6, overageCentsPerMinute: 25 });
    expect(q.overageCentsPerMinute).toBe(25);
    expect(q.monthlyFloorCents).toBeGreaterThan(withMinutes(6000).monthlyFloorCents);
    expect(DEFAULT_ENTERPRISE_RATES.targetGrossMargin).toBe(0.45);
  });
  it('undefined overrides fall back to defaults', () => {
    expect(quoteEnterprise(base, { voiceCostPerMinute: undefined })).toEqual(withMinutes(6000));
  });
  it('rejects invalid inputs', () => {
    expect(() => withMinutes(-1)).toThrow(RangeError);
    expect(() => withMinutes(Number.NaN)).toThrow(RangeError);
    expect(() => withMinutes(Infinity)).toThrow(RangeError);
    expect(() => withMinutes(6000, { locations: 1.5 })).toThrow(RangeError);
    expect(() => withMinutes(6000, { smsPerMonth: -5 })).toThrow(RangeError);
    expect(() => withMinutes(6000, { discount: 1 })).toThrow(RangeError);
    expect(() => withMinutes(6000, { discount: -0.1 })).toThrow(RangeError);
  });
  it('rejects invalid rates', () => {
    expect(() => quoteEnterprise(base, { targetGrossMargin: 1 })).toThrow(RangeError);
    expect(() => quoteEnterprise(base, { targetGrossMargin: -0.1 })).toThrow(RangeError);
    expect(() => quoteEnterprise(base, { voiceCostPerMinute: -1 })).toThrow(RangeError);
    expect(() => quoteEnterprise(base, { listPriceStepUsd: 0 })).toThrow(RangeError);
  });
});
