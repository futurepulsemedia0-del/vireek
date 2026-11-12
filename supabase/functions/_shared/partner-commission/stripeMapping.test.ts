import { describe, expect, it } from 'vitest';
import {
  chargeRefundToClawbackArgs,
  disputeToClawbackArgs,
  disputeToReinstatementArgs,
  idOf,
  invoiceToEarnArgs,
} from './stripeMapping';

const invoice = { id: 'in_1', customer: 'cus_1', subscription: 'sub_1', amount_paid: 9480, tax: 1580, currency: 'USD', created: 1_700_000_000 };

describe('invoiceToEarnArgs', () => {
  it('maps a paid subscription invoice, lower-casing the currency', () => {
    expect(invoiceToEarnArgs(invoice)).toEqual({
      p_customer_id: 'cus_1', p_invoice_id: 'in_1', p_amount_paid_cents: 9480, p_tax_cents: 1580,
      p_currency: 'usd', p_paid_at: new Date(1_700_000_000 * 1000).toISOString(),
    });
  });
  it('prefers status_transitions.paid_at and accepts expanded customer objects', () => {
    const r = invoiceToEarnArgs({ ...invoice, customer: { id: 'cus_9' }, status_transitions: { paid_at: 1_800_000_000 } });
    expect(r?.p_customer_id).toBe('cus_9');
    expect(r?.p_paid_at).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });
  it('ignores $0 invoices, one-off invoices and invoices without a customer', () => {
    expect(invoiceToEarnArgs({ ...invoice, amount_paid: 0 })).toBeNull();
    expect(invoiceToEarnArgs({ ...invoice, subscription: null })).toBeNull();
    expect(invoiceToEarnArgs({ ...invoice, customer: null })).toBeNull();
  });
  it('treats missing or negative tax as 0 and never lets tax exceed the amount', () => {
    expect(invoiceToEarnArgs({ ...invoice, tax: null })?.p_tax_cents).toBe(0);
    expect(invoiceToEarnArgs({ ...invoice, tax: -5 })?.p_tax_cents).toBe(0);
    expect(invoiceToEarnArgs({ ...invoice, tax: 99999 })?.p_tax_cents).toBe(9480);
  });
});

describe('refund / dispute mapping', () => {
  const charge = { id: 'ch_1', invoice: 'in_1', amount: 9480, amount_refunded: 4740 };
  it('maps a partial refund with the cumulative refunded amount', () => {
    expect(chargeRefundToClawbackArgs('evt_1', charge)).toEqual({
      p_event_id: 'evt_1', p_invoice_id: 'in_1', p_source_kind: 'refund', p_source_ref: 'ch_1',
      p_refunded_cents: 4740, p_charge_amount_cents: 9480, p_reason: 'refund',
    });
  });
  it('skips charges without an invoice or without a refund', () => {
    expect(chargeRefundToClawbackArgs('evt_1', { ...charge, invoice: null })).toBeNull();
    expect(chargeRefundToClawbackArgs('evt_1', { ...charge, amount_refunded: 0 })).toBeNull();
  });
  it('caps the refunded amount at the charge amount', () => {
    expect(chargeRefundToClawbackArgs('evt_1', { ...charge, amount_refunded: 99999 })?.p_refunded_cents).toBe(9480);
  });
  it('maps a dispute to a full clawback keyed by the dispute id', () => {
    const r = disputeToClawbackArgs('evt_2', { id: 'dp_1', charge: 'ch_1' }, charge);
    expect(r).toMatchObject({ p_source_kind: 'dispute', p_source_ref: 'dp_1', p_invoice_id: 'in_1' });
    expect(disputeToClawbackArgs('evt_2', { id: 'dp_1' }, null)).toBeNull();
  });
  it('reinstates only when the dispute was won', () => {
    expect(disputeToReinstatementArgs('evt_3', { id: 'dp_1', status: 'won' }, charge)).toEqual({
      p_event_id: 'evt_3', p_invoice_id: 'in_1', p_source_ref: 'dp_1', p_reason: 'dispute won',
    });
    expect(disputeToReinstatementArgs('evt_3', { id: 'dp_1', status: 'lost' }, charge)).toBeNull();
  });
  it('idOf handles strings, objects and empties', () => {
    expect(idOf('x')).toBe('x');
    expect(idOf({ id: 'y' })).toBe('y');
    expect(idOf('')).toBeNull();
    expect(idOf(undefined)).toBeNull();
  });
});
