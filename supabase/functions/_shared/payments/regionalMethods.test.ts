import { describe, it, expect } from 'vitest';
import {
  CHARGE_CURRENCIES, DELAYED_METHODS, buildRegionalPaymentMethodOptions, isDelayedMethod, minChargeMinor, normalizeChargeCurrency,
} from './regionalMethods';
import { PAYMENT_METHODS, billingCurrencies } from '../../../../src/lib/regionalPacks/packData';

describe('normalizeChargeCurrency', () => {
  it('lower-cases, defaults and rejects', () => {
    expect(normalizeChargeCurrency('EUR')).toBe('eur');
    expect(normalizeChargeCurrency(' gbp ')).toBe('gbp');
    expect(normalizeChargeCurrency(null)).toBe('usd');
    expect(normalizeChargeCurrency('', 'cad')).toBe('cad');
    expect(() => normalizeChargeCurrency('jpy')).toThrow();
    expect(() => normalizeChargeCurrency(42)).toThrow();
  });
});

describe('regional methods', () => {
  it('knows the minimum charge per currency', () => {
    expect(minChargeMinor('gbp')).toBe(30);
    expect(minChargeMinor('usd')).toBe(50);
  });
  it('flags only direct debits as delayed', () => {
    for (const t of ['sepa_debit', 'bacs_debit', 'acss_debit', 'au_becs_debit', 'us_bank_account']) expect(isDelayedMethod(t)).toBe(true);
    expect(isDelayedMethod('card')).toBe(false);
    expect(isDelayedMethod(undefined)).toBe(false);
  });
  it('builds PAD mandate options only when opted in and CAD/USD', () => {
    expect(buildRegionalPaymentMethodOptions('cad')).toBeUndefined();
    expect(buildRegionalPaymentMethodOptions('eur', { acssEnabled: true })).toBeUndefined();
    const o = buildRegionalPaymentMethodOptions('cad', { acssEnabled: true, businessCustomer: true }) as any;
    expect(o.acss_debit.mandate_options.transaction_type).toBe('business');
  });
  it('stays in sync with the pack data', () => {
    expect(DELAYED_METHODS.slice().sort()).toEqual(Object.values(PAYMENT_METHODS).filter((m) => m.delayed).map((m) => m.type).sort());
    const packCurrencies = billingCurrencies(['US', 'CA', 'GB', 'EU', 'AU']).map((c) => c.toLowerCase()).sort();
    expect(CHARGE_CURRENCIES.slice().sort()).toEqual(packCurrencies);
  });
});
