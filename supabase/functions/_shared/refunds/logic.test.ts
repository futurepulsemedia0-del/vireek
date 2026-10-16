import { describe, it, expect } from 'vitest';
import {
  parseIssueInput,
  stripeReasonFor,
  mapStripeRefundStatus,
  isAmbiguousStripeFailure,
  formatMoney,
  MAX_REFUND_CENTS,
} from './logic';

const valid = {
  payment_request_id: '0b9f2b5e-7c1d-4a52-9d0e-3f1f6c2a8b11',
  amount_cents: 12500,
  reason_code: 'quality_issue',
  idempotency_key: 'a1b2c3d4-e5f6-7890',
};

describe('parseIssueInput', () => {
  it('accepts a valid payload and applies defaults', () => {
    const r = parseIssueInput(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.amountCents).toBe(12500);
      expect(r.value.notifyCustomer).toBe(true);
      expect(r.value.reasonNote).toBeNull();
    }
  });

  it('rejects fractional, zero, negative, and oversized amounts', () => {
    for (const amount_cents of [12.5, 0, -100, MAX_REFUND_CENTS + 1, '100', null]) {
      expect(parseIssueInput({ ...valid, amount_cents }).ok).toBe(false);
    }
  });

  it('rejects unknown reasons, bad ids, and weak idempotency keys', () => {
    expect(parseIssueInput({ ...valid, reason_code: 'because' }).ok).toBe(false);
    expect(parseIssueInput({ ...valid, payment_request_id: 'nope' }).ok).toBe(false);
    expect(parseIssueInput({ ...valid, idempotency_key: 'short' }).ok).toBe(false);
    expect(parseIssueInput(null).ok).toBe(false);
  });

  it('requires a note for "other" and strips control characters', () => {
    expect(parseIssueInput({ ...valid, reason_code: 'other' }).ok).toBe(false);
    const r = parseIssueInput({ ...valid, reason_code: 'other', reason_note: 'Line1\nLine2\u0007' });
    expect(r.ok && r.value.reasonNote).toBe('Line1 Line2');
  });

  it('honours an explicit notify_customer=false and caps note length', () => {
    const r = parseIssueInput({ ...valid, notify_customer: false });
    expect(r.ok && r.value.notifyCustomer).toBe(false);
    expect(parseIssueInput({ ...valid, reason_note: 'x'.repeat(501) }).ok).toBe(false);
  });
});

describe('stripe mapping', () => {
  it('maps our reason codes onto the three Stripe reasons', () => {
    expect(stripeReasonFor('duplicate_charge')).toBe('duplicate');
    expect(stripeReasonFor('fraudulent')).toBe('fraudulent');
    expect(stripeReasonFor('goodwill')).toBe('requested_by_customer');
  });

  it('treats unknown Stripe statuses as pending', () => {
    expect(mapStripeRefundStatus('succeeded')).toBe('succeeded');
    expect(mapStripeRefundStatus('failed')).toBe('failed');
    expect(mapStripeRefundStatus('requires_action')).toBe('pending');
    expect(mapStripeRefundStatus(undefined)).toBe('pending');
  });

  it('only releases the reservation on a definite 4xx', () => {
    expect(isAmbiguousStripeFailure({ status: 400 })).toBe(false);
    expect(isAmbiguousStripeFailure({ status: 402 })).toBe(false);
    expect(isAmbiguousStripeFailure({ status: 429 })).toBe(false);
    expect(isAmbiguousStripeFailure({ status: 500 })).toBe(true);
    expect(isAmbiguousStripeFailure({ status: 409 })).toBe(true);
    expect(isAmbiguousStripeFailure(new TypeError('fetch failed'))).toBe(true);
  });
});

describe('formatMoney', () => {
  it('formats cents and survives a bad currency code', () => {
    expect(formatMoney(12345)).toBe('$123.45');
    expect(formatMoney(100, 'nonsense!')).toBe('$1.00');
  });
});
