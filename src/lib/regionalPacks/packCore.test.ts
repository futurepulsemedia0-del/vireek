import { describe, it, expect } from 'vitest';
import { COUNTRY_PROFILES, EU_COUNTRY_CODES, PACKS, billingCurrencies, countriesInPack, packForCountry, paymentMethodsFor } from './packData';
import { eInvoicingStatus, validateInvoiceDocument } from './packDocuments';
import { PACK_CODES } from './packTypes';

describe('pack data', () => {
  it('covers 27 EU states and every pack country has a profile', () => {
    expect(EU_COUNTRY_CODES).toHaveLength(27);
    for (const code of PACK_CODES) {
      for (const c of PACKS[code].countries) expect(COUNTRY_PROFILES[c]?.pack).toBe(code);
    }
    expect(packForCountry('de')).toBe('EU');
    expect(packForCountry('JP')).toBeNull();
    expect(countriesInPack('GB')).toHaveLength(1);
  });
  it('has sane per-country rules', () => {
    for (const c of Object.values(COUNTRY_PROFILES)) {
      expect(c.phone.minLen).toBeLessThanOrEqual(c.phone.maxLen);
      expect(c.postal.regex.test(c.postal.example)).toBe(true);
      expect(/^[A-Z]{3}$/.test(c.currency)).toBe(true);
    }
  });
  it('lists billing currencies per enabled pack', () => {
    expect(billingCurrencies(['US', 'CA', 'GB', 'AU'])).toEqual(['AUD', 'CAD', 'GBP', 'USD']);
    expect(billingCurrencies(['EU'])).toContain('PLN');
  });
  it('offers direct debit only in the matching currency', () => {
    expect(paymentMethodsFor('DE', 'EUR').map((m) => m.type)).toEqual(['card', 'sepa_debit']);
    expect(paymentMethodsFor('DE', 'USD').map((m) => m.type)).toEqual(['card']);
    expect(paymentMethodsFor('CA', 'CAD').map((m) => m.type)).toContain('acss_debit');
    expect(paymentMethodsFor('GB', 'GBP').map((m) => m.type)).toContain('bacs_debit');
    expect(paymentMethodsFor('AU', 'AUD').map((m) => m.type)).toContain('au_becs_debit');
    expect(paymentMethodsFor('PL', 'PLN').map((m) => m.type)).toEqual(['card', 'blik', 'p24']);
  });
});

describe('invoice documents', () => {
  const full = { number: 'INV-1', issueDate: '2026-10-20', seller: { name: 'Acme', address: '1 St', taxId: 'GB980780684' }, buyer: { name: 'Bob', address: '2 St' }, lines: [{ description: 'Boiler service' }], grossMinor: 12000, taxMinor: 2000, showsTaxBreakdown: true };
  it('accepts a complete UK VAT invoice and flags gaps', () => {
    expect(validateInvoiceDocument('GB', full).valid).toBe(true);
    const bad = validateInvoiceDocument('GB', { ...full, seller: { name: 'Acme' }, showsTaxBreakdown: false });
    expect(bad.missing.map((m) => m.field)).toEqual(expect.arrayContaining(['seller.address', 'seller.taxId', 'tax']));
  });
  it('requires reverse-charge wording', () => {
    const r = validateInvoiceDocument('DE', { ...full, taxMinor: 0, reverseCharge: true, buyer: { name: 'B', address: 'x' } });
    expect(r.missing.map((m) => m.field)).toEqual(expect.arrayContaining(['buyer.taxId', 'reverseChargeNote']));
  });
  it('applies Canadian value tiers', () => {
    const ca = { ...full, seller: { name: 'Acme', taxId: '123456789RT0001' }, buyer: {}, grossMinor: 2000, taxMinor: 100 };
    expect(validateInvoiceDocument('CA', ca).valid).toBe(true);
    expect(validateInvoiceDocument('CA', { ...ca, grossMinor: 20000 }).missing.map((m) => m.field)).toEqual(expect.arrayContaining(['buyer.name', 'termsOfPayment']));
    expect(validateInvoiceDocument('CA', { ...ca, taxCodes: ['QST'], grossMinor: 5000 }).missing.map((m) => m.field)).toContain('seller.qstNumber');
  });
  it('applies Australian tax-invoice rules', () => {
    expect(validateInvoiceDocument('AU', { ...full, grossMinor: 5000, taxMinor: 455 }).valid).toBe(true);
    const r = validateInvoiceDocument('AU', { ...full, grossMinor: 20000, showsTaxBreakdown: false });
    expect(r.missing.map((m) => m.field)).toEqual(expect.arrayContaining(['title', 'tax']));
    expect(validateInvoiceDocument('AU', { ...full, title: 'Tax Invoice', seller: { name: 'A', taxId: '51824753556' }, grossMinor: 150000, buyer: {} }).missing.map((m) => m.field)).toContain('buyer');
  });
  it('reports e-invoicing status', () => {
    expect(eInvoicingStatus('IT').status).toBe('mandatory_b2b');
    expect(eInvoicingStatus('SE').status).toBe('none');
  });
});
