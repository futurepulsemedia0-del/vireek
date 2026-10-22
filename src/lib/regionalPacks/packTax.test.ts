import { describe, it, expect } from 'vitest';
import { allocate, applyRate, toMinor } from './packMoney';
import { computeTax, taxComponentsFor, combinedRatePct } from './packTax';
import type { TaxContext, TaxRegistration } from './packTypes';

const reg = (scheme: TaxRegistration['scheme'], country: string, sub?: string): TaxRegistration => ({ scheme, number: 'X123456', country, subdivision: sub ?? null });
const base = (o: Partial<TaxContext>): TaxContext => ({
  currency: 'EUR', sellerCountry: 'DE', siteCountry: 'DE', registrations: [reg('VAT', 'DE')], supplyDate: '2026-10-20', ...o,
});
const line = (net: number, id = 'a') => ({ id, netMinor: net });

describe('money', () => {
  it('rounds half away from zero with integer maths', () => {
    expect(applyRate(2000, 9.975)).toBe(200); // 199.5 -> 200
    expect(applyRate(-2000, 9.975)).toBe(-200);
    expect(applyRate(1000, 20)).toBe(200);
    expect(toMinor(1.005, 'USD')).toBe(101);
  });
  it('allocates without losing a cent', () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(allocate(-100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(-100);
  });
});

describe('rates', () => {
  it('uses 2026 rates', () => {
    expect(taxComponentsFor('EE', null, 'standard').components[0].ratePct).toBe(24);
    expect(taxComponentsFor('SK', null, 'standard', 0, '2026-01-01').components[0].ratePct).toBe(23);
    expect(taxComponentsFor('SK', null, 'standard', 0, '2024-06-01').components[0].ratePct).toBe(20);
    expect(combinedRatePct(taxComponentsFor('CA', 'QC', 'standard').components)).toBe(14.975);
    expect(combinedRatePct(taxComponentsFor('CA', 'NS', 'standard', 0, '2026-01-01').components)).toBe(14);
    expect(combinedRatePct(taxComponentsFor('CA', 'NS', 'standard', 0, '2025-01-01').components)).toBe(15);
    expect(combinedRatePct(taxComponentsFor('CA', 'BC', 'standard').components)).toBe(12);
    expect(taxComponentsFor('FR', null, 'reduced', 2).components[0].ratePct).toBe(10);
  });
  it('rejects unknown jurisdictions', () => {
    expect(() => taxComponentsFor('JP', null, 'standard')).toThrow();
    expect(() => taxComponentsFor('CA', null, 'standard')).toThrow();
  });
});

describe('computeTax', () => {
  it('charges domestic VAT when registered', () => {
    const r = computeTax(base({}), [line(10000)]);
    expect(r.status).toBe('ok');
    expect(r.taxMinor).toBe(1900);
    expect(r.grossMinor).toBe(11900);
  });
  it('charges nothing and warns when not registered', () => {
    const r = computeTax(base({ registrations: [] }), [line(10000)]);
    expect(r.status).toBe('no_registration');
    expect(r.taxMinor).toBe(0);
    expect(r.warnings.some((w) => w.code === 'NOT_REGISTERED')).toBe(true);
  });
  it('taxes where the property is, not where the seller is', () => {
    const r = computeTax(base({ sellerCountry: 'DE', siteCountry: 'FR', registrations: [reg('VAT', 'DE'), reg('VAT', 'FR')] }), [line(10000)]);
    expect(r.taxMinor).toBe(2000);
    expect(r.placeOfSupply.country).toBe('FR');
  });
  it('applies reverse charge for cross-border B2B with a matching VAT id', () => {
    const r = computeTax(base({ siteCountry: 'FR', customerIsBusiness: true, customerTaxId: 'FR12345678901' }), [line(10000)]);
    expect(r.reverseCharge).toBe(true);
    expect(r.taxMinor).toBe(0);
  });
  it('flags a foreign supplier without local registration (B2C)', () => {
    const r = computeTax(base({ siteCountry: 'FR' }), [line(10000)]);
    expect(r.status).toBe('no_registration');
    expect(r.warnings.some((w) => w.code === 'FOREIGN_SUPPLIER')).toBe(true);
  });
  it('supports zero, exempt and reduced lines', () => {
    const r = computeTax(base({ sellerCountry: 'IE', siteCountry: 'IE', registrations: [reg('VAT', 'IE')] }), [
      { id: 'a', netMinor: 10000, category: 'reduced', reducedIndex: 2 }, { id: 'b', netMinor: 5000, category: 'zero' },
    ]);
    expect(r.lines[0].taxMinor).toBe(1350);
    expect(r.lines[1].taxMinor).toBe(0);
  });
  it('splits GST and PST in British Columbia', () => {
    const r = computeTax(base({ currency: 'CAD', sellerCountry: 'CA', sellerSubdivision: 'BC', siteCountry: 'CA', siteSubdivision: 'BC', registrations: [reg('GST_HST', 'CA'), reg('PST_BC', 'CA', 'BC')] }), [line(10000)]);
    expect(r.breakdown.map((b) => b.code).sort()).toEqual(['GST', 'PST']);
    expect(r.taxMinor).toBe(1200);
  });
  it('charges only GST when PST is not registered and asks for review', () => {
    const r = computeTax(base({ currency: 'CAD', sellerCountry: 'CA', siteCountry: 'CA', siteSubdivision: 'BC', registrations: [reg('GST_HST', 'CA')] }), [line(10000)]);
    expect(r.taxMinor).toBe(500);
    expect(r.status).toBe('needs_review');
  });
  it('charges QST on the pre-GST price', () => {
    const r = computeTax(base({ currency: 'CAD', sellerCountry: 'CA', siteCountry: 'CA', siteSubdivision: 'QC', registrations: [reg('GST_HST', 'CA'), reg('QST', 'CA')] }), [line(10000)]);
    expect(r.taxMinor).toBe(500 + 998);
  });
  it('applies AU GST', () => {
    const r = computeTax(base({ currency: 'AUD', sellerCountry: 'AU', siteCountry: 'AU', siteSubdivision: 'NSW', registrations: [reg('AU_GST', 'AU')] }), [line(8000)]);
    expect(r.taxMinor).toBe(800);
  });
  it('keeps line taxes summing to the invoice tax (per-rate rounding)', () => {
    const lines = [line(333, 'a'), line(333, 'b'), line(334, 'c')];
    const r = computeTax(base({}), lines);
    expect(r.lines.reduce((a, l) => a + l.taxMinor, 0)).toBe(r.taxMinor);
    expect(r.taxMinor).toBe(applyRate(1000, 19));
  });
  it('handles credit notes symmetrically', () => {
    const r = computeTax(base({}), [line(-10000)]);
    expect(r.taxMinor).toBe(-1900);
  });
  it('delegates US sales tax to externalComponents', () => {
    const us: TaxContext = { currency: 'USD', sellerCountry: 'US', siteCountry: 'US', siteSubdivision: 'TX', registrations: [] };
    expect(computeTax(us, [line(10000)]).status).toBe('needs_rate');
    const r = computeTax({ ...us, externalComponents: [{ code: 'SALES_TAX', label: 'TX', ratePct: 8.25, scheme: 'US_SALES_TAX' }] }, [line(10000)]);
    expect(r.taxMinor).toBe(825);
  });
  it('is out of scope for countries without a pack', () => {
    expect(computeTax(base({ siteCountry: 'JP' }), [line(100)]).status).toBe('out_of_scope');
  });
  it('rejects non-integer minor units', () => {
    expect(() => computeTax(base({}), [line(10.5)])).toThrow();
  });
  it('honours a domestic reverse charge only with a tax id', () => {
    const ctx = base({ sellerCountry: 'GB', siteCountry: 'GB', currency: 'GBP', registrations: [reg('VAT', 'GB')], customerIsBusiness: true, domesticReverseCharge: true });
    expect(computeTax(ctx, [line(10000)]).taxMinor).toBe(2000);
    expect(computeTax({ ...ctx, customerTaxId: 'GB980780684' }, [line(10000)]).reverseCharge).toBe(true);
  });
});
