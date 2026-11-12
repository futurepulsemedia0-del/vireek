import { describe, it, expect } from 'vitest';
import { normalizeInvoice, type StripeInvoiceLike } from './subscriptionInvoices';

const base: StripeInvoiceLike = {
  id: 'in_tax_1',
  number: 'VIREEK-0100',
  status: 'paid',
  created: 1_790_000_000,
  currency: 'usd',
  total: 11900,
  amount_due: 0,
  amount_paid: 11900,
  total_excluding_tax: 10000,
};

describe('normalizeInvoice — tax lines (fixture data only; no rate is assumed by the code)', () => {
  it('maps an expanded tax rate: label, percentage, amount and subtotal', () => {
    const dto = normalizeInvoice({
      ...base,
      total_tax_amounts: [{ amount: 1900, inclusive: false, taxability_reason: 'standard_rated', tax_rate: { display_name: 'VAT', percentage: 19, jurisdiction: 'DE' } }],
    });
    expect(dto?.totalExcludingTax).toBe(10000);
    expect(dto?.taxTotal).toBe(1900);
    expect(dto?.reverseCharge).toBe(false);
    expect(dto?.taxLines).toEqual([
      { label: 'VAT', percentage: 19, jurisdiction: 'DE', amount: 1900, inclusive: false, taxabilityReason: 'standard_rated' },
    ]);
  });

  it('sums several jurisdictions (US sales tax)', () => {
    const dto = normalizeInvoice({
      ...base,
      total: 10825,
      total_tax_amounts: [
        { amount: 625, tax_rate: { display_name: 'Sales tax', percentage: 6.25, jurisdiction: 'STATE' } },
        { amount: 200, tax_rate: { display_name: 'Sales tax', percentage: 2, jurisdiction: 'CITY' } },
      ],
    });
    expect(dto?.taxLines).toHaveLength(2);
    expect(dto?.taxTotal).toBe(825);
  });

  it('keeps working when tax_rate is only an id (not expanded)', () => {
    const dto = normalizeInvoice({ ...base, total_tax_amounts: [{ amount: 500, tax_rate: 'txr_123' }] });
    expect(dto?.taxLines[0]).toMatchObject({ label: null, percentage: null, amount: 500 });
  });

  it('has no tax data for an invoice issued before Stripe Tax was enabled', () => {
    const dto = normalizeInvoice({ ...base, total_excluding_tax: undefined });
    expect(dto?.taxLines).toEqual([]);
    expect(dto?.taxTotal).toBe(0);
    expect(dto?.totalExcludingTax).toBeNull();
    expect(dto?.reverseCharge).toBe(false);
    expect(dto?.customerTaxIds).toEqual([]);
  });
});

describe('normalizeInvoice — reverse charge (zero tax) and customer tax IDs', () => {
  const reverse: StripeInvoiceLike = {
    ...base,
    total: 10000,
    amount_paid: 10000,
    customer_tax_exempt: 'reverse',
    customer_tax_ids: [{ type: 'eu_vat', value: 'DE123456789' }],
    total_tax_amounts: [{ amount: 0, taxability_reason: 'reverse_charge', tax_rate: { display_name: 'VAT', percentage: 0 } }],
  };

  it('flags reverse charge, keeps the zero tax line and shows the tax ID', () => {
    const dto = normalizeInvoice(reverse);
    expect(dto?.reverseCharge).toBe(true);
    expect(dto?.taxTotal).toBe(0);
    expect(dto?.taxLines).toHaveLength(1);
    expect(dto?.total).toBe(dto?.totalExcludingTax);
    expect(dto?.customerTaxIds).toEqual([{ type: 'eu_vat', value: 'DE123456789' }]);
  });

  it('detects reverse charge from the taxability reason alone', () => {
    const dto = normalizeInvoice({ ...reverse, customer_tax_exempt: 'none' });
    expect(dto?.reverseCharge).toBe(true);
  });

  it('does not flag an ordinary taxed invoice as reverse charge', () => {
    const dto = normalizeInvoice({ ...base, customer_tax_exempt: 'none', total_tax_amounts: [{ amount: 1900, taxability_reason: 'standard_rated' }] });
    expect(dto?.reverseCharge).toBe(false);
  });
});

describe('normalizeInvoice — hostile or malformed tax data never throws', () => {
  it('ignores junk entries, trims text and caps tax IDs at five', () => {
    const dto = normalizeInvoice({
      ...base,
      total_tax_amounts: [null, { amount: Number.NaN }, { amount: 100, tax_rate: { display_name: 'x'.repeat(200) } }] as unknown as StripeInvoiceLike['total_tax_amounts'],
      customer_tax_ids: [
        { type: 'eu_vat', value: ' AB1 ' },
        { type: '', value: 'x' },
        ...Array.from({ length: 8 }, (_, i) => ({ type: 'gb_vat', value: `GB${i}` })),
      ],
    });
    expect(dto?.taxLines).toHaveLength(1);
    expect(dto?.taxLines[0].label).toHaveLength(40);
    expect(dto?.customerTaxIds).toHaveLength(5);
    expect(dto?.customerTaxIds[0].value).toBe('AB1');
  });
});
