import { describe, it, expect } from 'vitest';
import {
  brandLabel,
  cardExpiryState,
  formatExpiry,
  formatInvoiceAmount,
  formatInvoiceDate,
  invoicePeriodLabel,
  mergeInvoices,
  summarizeInvoices,
  type SubscriptionInvoice,
} from './subscriptionInvoices';

const inv = (over: Partial<SubscriptionInvoice>): SubscriptionInvoice => ({
  id: 'in_1',
  number: 'VIREEK-0001',
  status: 'paid',
  createdAt: '2026-09-01T00:00:00.000Z',
  periodStart: null,
  periodEnd: null,
  description: null,
  currency: 'USD',
  total: 19900,
  amountDue: 0,
  amountPaid: 19900,
  pdfUrl: null,
  hostedUrl: null,
  attemptCount: 0,
  nextPaymentAttemptAt: null,
  ...over,
});

describe('formatInvoiceAmount', () => {
  it('converts cents to dollars', () => {
    expect(formatInvoiceAmount(19900, 'usd')).toBe('$199.00');
  });

  it('does not divide zero-decimal currencies such as JPY', () => {
    expect(formatInvoiceAmount(5000, 'JPY')).toContain('5,000');
  });

  it('falls back gracefully on an unknown currency code', () => {
    expect(formatInvoiceAmount(1250, 'zz!')).toBe('ZZ! 12.50');
  });
});

describe('dates', () => {
  it('formats in UTC so the day never shifts by timezone', () => {
    expect(formatInvoiceDate('2026-10-01T00:30:00.000Z')).toBe('Oct 1, 2026');
    expect(formatInvoiceDate('garbage')).toBe('—');
  });

  it('builds a period label only when both ends exist', () => {
    expect(invoicePeriodLabel({ periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z' })).toBe('Sep 1, 2026 – Oct 1, 2026');
    expect(invoicePeriodLabel({ periodStart: null, periodEnd: '2026-10-01T00:00:00.000Z' })).toBeNull();
  });
});

describe('mergeInvoices', () => {
  it('appends new invoices and ignores ones already loaded', () => {
    const merged = mergeInvoices([inv({ id: 'in_1' }), inv({ id: 'in_2' })], [inv({ id: 'in_2' }), inv({ id: 'in_3' })]);
    expect(merged.map((i) => i.id)).toEqual(['in_1', 'in_2', 'in_3']);
  });
});

describe('summarizeInvoices', () => {
  it('sums only open invoices as outstanding and finds the latest real payment', () => {
    const summary = summarizeInvoices([
      inv({ id: 'in_open', status: 'open', amountDue: 19900, amountPaid: 0, createdAt: '2026-10-01T00:00:00.000Z' }),
      inv({ id: 'in_old', createdAt: '2026-08-01T00:00:00.000Z' }),
      inv({ id: 'in_new', createdAt: '2026-09-01T00:00:00.000Z' }),
      inv({ id: 'in_trial', total: 0, amountPaid: 0, createdAt: '2026-09-15T00:00:00.000Z' }),
    ]);
    expect(summary.outstandingMinor).toBe(19900);
    expect(summary.outstandingCount).toBe(1);
    expect(summary.lastPaid?.id).toBe('in_new');
  });

  it('is safe on an empty list', () => {
    const summary = summarizeInvoices([]);
    expect(summary.outstandingMinor).toBe(0);
    expect(summary.lastPaid).toBeNull();
    expect(summary.currency).toBe('USD');
  });
});

describe('cards', () => {
  const now = new Date('2026-10-08T12:00:00.000Z');

  it('treats a card as valid through the end of its expiry month', () => {
    expect(cardExpiryState({ expMonth: 10, expYear: 2026 }, now)).toBe('expiring');
    expect(cardExpiryState({ expMonth: 9, expYear: 2026 }, now)).toBe('expired');
    expect(cardExpiryState({ expMonth: 11, expYear: 2026 }, now)).toBe('expiring');
    expect(cardExpiryState({ expMonth: 12, expYear: 2026 }, now)).toBe('valid');
  });

  it('formats expiry and brand labels', () => {
    expect(formatExpiry({ expMonth: 4, expYear: 2030 })).toBe('04/30');
    expect(brandLabel('amex')).toBe('American Express');
    expect(brandLabel('something-new')).toBe('Card');
  });
});
