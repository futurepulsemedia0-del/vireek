import { describe, it, expect } from 'vitest';
import {
  checkoutTaxParams,
  isAutomaticTaxEnabled,
  priceTaxVerdict,
  schedulePhaseTax,
  subscriptionHasAutomaticTax,
} from './stripeTax';

describe('isAutomaticTaxEnabled', () => {
  it('is true only for the exact string "true"', () => {
    expect(isAutomaticTaxEnabled('true')).toBe(true);
    for (const v of [undefined, null, '', 'TRUE', 'True', '1', 'yes', 'false', ' true']) {
      expect(isAutomaticTaxEnabled(v as string | null | undefined)).toBe(false);
    }
  });
});

describe('checkoutTaxParams — env unset keeps today\'s behaviour', () => {
  it('adds nothing when disabled (sites that never sent automatic_tax)', () => {
    expect(checkoutTaxParams(false, { hasCustomer: true })).toEqual({});
    expect(checkoutTaxParams(false, { hasCustomer: false })).toEqual({});
  });

  it('keeps the explicit automatic_tax:{enabled:false} for results-plan-enroll', () => {
    expect(checkoutTaxParams(false, { hasCustomer: false, explicitDisabled: true })).toEqual({ automatic_tax: { enabled: false } });
  });
});

describe('checkoutTaxParams — enabled', () => {
  it('turns on tax, tax-ID collection and required billing address, and saves them to an existing customer', () => {
    expect(checkoutTaxParams(true, { hasCustomer: true })).toEqual({
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      billing_address_collection: 'required',
      customer_update: { address: 'auto', name: 'auto' },
    });
  });

  it('never sends customer_update without a customer (Stripe rejects it)', () => {
    const params = checkoutTaxParams(true, { hasCustomer: false, explicitDisabled: true });
    expect(params).not.toHaveProperty('customer_update');
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.tax_id_collection).toEqual({ enabled: true });
  });

  it('contains no rates, percentages or jurisdictions', () => {
    expect(JSON.stringify(checkoutTaxParams(true, { hasCustomer: true }))).not.toMatch(/rate|percent|jurisdiction|\d/);
  });
});

describe('subscription schedules', () => {
  it('mirrors the subscription, not the env var', () => {
    expect(subscriptionHasAutomaticTax({ automatic_tax: { enabled: true } })).toBe(true);
    expect(subscriptionHasAutomaticTax({ automatic_tax: { enabled: false } })).toBe(false);
    expect(subscriptionHasAutomaticTax({ automatic_tax: null })).toBe(false);
    expect(subscriptionHasAutomaticTax({})).toBe(false);
    expect(subscriptionHasAutomaticTax(null)).toBe(false);
  });

  it('adds automatic_tax to a phase only when the subscription is taxed', () => {
    expect(schedulePhaseTax(true)).toEqual({ automatic_tax: { enabled: true } });
    expect(schedulePhaseTax(false)).toEqual({});
  });
});

describe('priceTaxVerdict', () => {
  it('classifies tax_behavior', () => {
    expect(priceTaxVerdict('exclusive')).toBe('exclusive');
    expect(priceTaxVerdict('inclusive')).toBe('inclusive');
    expect(priceTaxVerdict('unspecified')).toBe('unspecified');
    expect(priceTaxVerdict(null)).toBe('unspecified');
    expect(priceTaxVerdict(undefined)).toBe('unspecified');
  });
});
