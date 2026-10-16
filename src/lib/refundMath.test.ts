import { describe, it, expect } from 'vitest';
import {
  dollarsToCents,
  validateRefundAmount,
  refundStateOf,
  needsAttention,
  summarizeRefunds,
  formatMoney,
  type Refund,
} from './refundMath';

const NOW = Date.parse('2026-10-08T12:00:00Z');

function refund(over: Partial<Refund> = {}): Refund {
  return {
    id: 'r1', user_id: 'u1', payment_request_id: 'p1', job_id: null, customer_name: 'Ana', customer_email: null,
    customer_phone: null, amount_cents: 5000, currency: 'usd', reason_code: 'goodwill', reason_note: null,
    status: 'succeeded', stripe_refund_id: 're_1', failure_reason: null, notify_customer: true, notice_status: 'sent',
    notice_sent_at: null, credit_memo_number: 'CM-202610-0001', journal_entry_id: 'j1', accounting_status: 'posted',
    accounting_error: null, created_by_email: null, created_at: '2026-10-07T12:00:00Z', completed_at: null, ...over,
  };
}

describe('dollarsToCents', () => {
  it('parses plain, decimal, and formatted amounts exactly', () => {
    expect(dollarsToCents('25')).toBe(2500);
    expect(dollarsToCents('25.5')).toBe(2550);
    expect(dollarsToCents('$1,250.00')).toBe(125000);
    expect(dollarsToCents('0.07')).toBe(7);
  });
  it('rejects zero, negatives, extra decimals, and junk', () => {
    for (const bad of ['', '0', '0.00', '-5', '1.234', 'abc', '1e3', '12.', '.5']) expect(dollarsToCents(bad)).toBeNull();
  });
});

describe('validateRefundAmount / refundStateOf', () => {
  it('blocks amounts above the refundable balance', () => {
    expect(validateRefundAmount(null, 1000)).toMatch(/Enter an amount/);
    expect(validateRefundAmount(1001, 1000)).toBe('Maximum refundable is $10.00');
    expect(validateRefundAmount(1000, 1000)).toBeNull();
  });
  it('classifies none / partial / full', () => {
    expect(refundStateOf({ amount_cents: 1000, refunded_cents: 0 })).toBe('none');
    expect(refundStateOf({ amount_cents: 1000, refunded_cents: 400 })).toBe('partial');
    expect(refundStateOf({ amount_cents: 1000, refunded_cents: 1000 })).toBe('full');
  });
});

describe('needsAttention / summarizeRefunds', () => {
  it('flags failed accounting, failed notices, and stuck requests only', () => {
    expect(needsAttention(refund(), NOW)).toBe(false);
    expect(needsAttention(refund({ accounting_status: 'failed' }), NOW)).toBe(true);
    expect(needsAttention(refund({ notice_status: 'failed' }), NOW)).toBe(true);
    expect(needsAttention(refund({ notify_customer: false, notice_status: 'failed' }), NOW)).toBe(false);
    const stuck = { status: 'pending' as const, stripe_refund_id: null, created_at: new Date(NOW - 5 * 60_000).toISOString() };
    expect(needsAttention(refund(stuck), NOW)).toBe(true);
    expect(needsAttention(refund({ ...stuck, created_at: new Date(NOW - 30_000).toISOString() }), NOW)).toBe(false);
  });

  it('sums the last 30 days, excluding failed and old refunds', () => {
    const s = summarizeRefunds(
      [
        refund({ amount_cents: 5000 }),
        refund({ id: 'r2', amount_cents: 2500, status: 'pending' }),
        refund({ id: 'r3', amount_cents: 9999, status: 'failed' }),
        refund({ id: 'r4', amount_cents: 7777, created_at: '2026-08-01T00:00:00Z' }),
      ],
      NOW,
    );
    expect(s.refundedCents).toBe(7500);
    expect(s.count).toBe(2);
    expect(s.processing).toBe(1);
  });
});

describe('formatMoney', () => {
  it('formats cents', () => expect(formatMoney(123456)).toBe('$1,234.56'));
});
