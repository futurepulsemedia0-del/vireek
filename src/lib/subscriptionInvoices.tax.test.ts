import { describe, it, expect } from 'vitest';
import { formatTaxIdType, invoiceTaxView, type SubscriptionInvoice } from './subscriptionInvoices';

const inv = (over: Partial<SubscriptionInvoice> = {}): SubscriptionInvoice => ({
  id: 'in_1',
  number: 'VIREEK-0100',
  status: 'paid',
  createdAt: '2026-09-01T00:00:00.000Z',
  periodStart: null,
  periodEnd: null,
  description: null,
  currency: 'USD',
  total: 11900,
  amountDue: 0,
  amountPaid: 11900,
  pdfUrl: null,
  hostedUrl: null,
  attemptCount: 0,
  nextPaymentAttemptAt: null,
  ...over,
});

describe('formatTaxIdType', () => {
  it('reads Stripe tax-ID types naturally', () => {
    expect(formatTaxIdType('eu_vat')).toBe('EU VAT');
    expect(formatTaxIdType('us_ein')).toBe('US EIN');
    expect(formatTaxIdType('ca_gst_hst')).toBe('CA GST HST');
    expect(formatTaxIdType('')).toBe('');
  });
});

describe('invoiceTaxView', () => {
  it('shows nothing for invoices without tax information (older DTO or pre-Stripe-Tax)', () => {
    expect(invoiceTaxView(inv()).hasDetails).toBe(false);
    expect(invoiceTaxView(inv({ taxLines: [], reverseCharge: false, customerTaxIds: [] })).hasDetails).toBe(false);
  });

  it('shows the subtotal and the tax line with Stripe\'s label and rate', () => {
    const view = invoiceTaxView(inv({
      totalExcludingTax: 10000,
      taxTotal: 1900,
      taxLines: [{ label: 'VAT', percentage: 19, jurisdiction: 'DE', amount: 1900, inclusive: false, taxabilityReason: 'standard_rated' }],
    }));
    expect(view.hasDetails).toBe(true);
    expect(view.subtotalMinor).toBe(10000);
    expect(view.lines.map((l) => [l.label, l.amountMinor])).toEqual([['VAT (19%)', 1900]]);
  });

  it('falls back to a generic "Tax" label when the rate was not expanded', () => {
    const view = invoiceTaxView(inv({ taxLines: [{ label: null, percentage: null, jurisdiction: null, amount: 500, inclusive: false, taxabilityReason: null }] }));
    expect(view.lines[0].label).toBe('Tax');
  });

  it('reverse-charge (zero-tax) invoice: notice, zero line and customer tax ID are all present', () => {
    const view = invoiceTaxView(inv({
      total: 10000,
      totalExcludingTax: 10000,
      taxTotal: 0,
      reverseCharge: true,
      taxLines: [{ label: 'VAT', percentage: 0, jurisdiction: null, amount: 0, inclusive: false, taxabilityReason: 'reverse_charge' }],
      customerTaxIds: [{ type: 'eu_vat', value: 'DE123456789' }],
    }));
    expect(view.hasDetails).toBe(true);
    expect(view.reverseCharge).toBe(true);
    expect(view.lines.map((l) => [l.label, l.amountMinor])).toEqual([['VAT (0%)', 0]]);
    expect(view.taxIds.map((t) => [t.label, t.value])).toEqual([['EU VAT', 'DE123456789']]);
  });

  it('shows a tax ID even when no tax was charged and no tax line exists', () => {
    const view = invoiceTaxView(inv({ customerTaxIds: [{ type: 'gb_vat', value: 'GB999999973' }] }));
    expect(view.hasDetails).toBe(true);
    expect(view.lines).toEqual([]);
  });

  it('formats fractional rates without trailing noise', () => {
    const view = invoiceTaxView(inv({ taxLines: [{ label: 'Sales tax', percentage: 6.25, jurisdiction: 'STATE', amount: 625, inclusive: false, taxabilityReason: null }] }));
    expect(view.lines[0].label).toBe('Sales tax (6.25%)');
  });
});
