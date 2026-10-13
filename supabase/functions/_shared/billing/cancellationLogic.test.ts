import { describe, it, expect } from 'vitest';
import {
  addMonthsClamped,
  canModifySubscription,
  isOfferEligible,
  offerTermsFromCoupon,
  parseRequest,
  STRIPE_FEEDBACK,
  CANCEL_REASONS,
} from './cancellationLogic';

describe('parseRequest', () => {
  it('accepts context and resume with no payload', () => {
    expect(parseRequest({ action: 'context' })).toEqual({ ok: true, request: { action: 'context' } });
    expect(parseRequest({ action: 'resume' })).toEqual({ ok: true, request: { action: 'resume' } });
  });

  it('requires a reason to cancel', () => {
    expect(parseRequest({ action: 'cancel' }).ok).toBe(false);
    const ok = parseRequest({ action: 'cancel', reason: 'too_expensive', detail: '  pricey  ' });
    expect(ok).toEqual({ ok: true, request: { action: 'cancel', reason: 'too_expensive', detail: 'pricey' } });
  });

  it('rejects unknown actions, reasons and malformed bodies', () => {
    expect(parseRequest(null).ok).toBe(false);
    expect(parseRequest('x').ok).toBe(false);
    expect(parseRequest({ action: 'delete_everything' }).ok).toBe(false);
    expect(parseRequest({ action: 'cancel', reason: 'because' }).ok).toBe(false);
  });

  it('rejects oversized or non-string feedback', () => {
    expect(parseRequest({ action: 'cancel', reason: 'other', detail: 'x'.repeat(1001) }).ok).toBe(false);
    expect(parseRequest({ action: 'cancel', reason: 'other', detail: 42 }).ok).toBe(false);
    expect(parseRequest({ action: 'cancel', reason: 'other', detail: 'x'.repeat(1000) }).ok).toBe(true);
  });

  it('validates pause length strictly', () => {
    expect(parseRequest({ action: 'pause', months: 2 }).ok).toBe(true);
    for (const bad of [0, 4, '2', 1.5, null, undefined]) {
      expect(parseRequest({ action: 'pause', months: bad }).ok).toBe(false);
    }
  });

  it('allows pause and offer without a reason', () => {
    expect(parseRequest({ action: 'accept_offer' })).toEqual({ ok: true, request: { action: 'accept_offer', reason: null, detail: '' } });
  });
});

describe('addMonthsClamped', () => {
  it('adds months and clamps to the end of shorter months', () => {
    expect(addMonthsClamped(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonthsClamped(new Date('2028-01-31T10:00:00Z'), 1).toISOString()).toBe('2028-02-29T10:00:00.000Z');
    expect(addMonthsClamped(new Date('2026-11-15T00:00:00Z'), 3).toISOString()).toBe('2027-02-15T00:00:00.000Z');
  });
});

describe('offerTermsFromCoupon', () => {
  it('accepts bounded percent-off coupons', () => {
    expect(offerTermsFromCoupon({ valid: true, percent_off: 30, duration: 'repeating', duration_in_months: 3 })).toEqual({ percentOff: 30, months: 3 });
    expect(offerTermsFromCoupon({ valid: true, percent_off: 50, duration: 'once' })).toEqual({ percentOff: 50, months: 1 });
  });

  it('never offers forever, amount-off, invalid or missing coupons', () => {
    expect(offerTermsFromCoupon({ valid: true, percent_off: 30, duration: 'forever' })).toBeNull();
    expect(offerTermsFromCoupon({ valid: true, percent_off: null, duration: 'once' })).toBeNull();
    expect(offerTermsFromCoupon({ valid: false, percent_off: 30, duration: 'once' })).toBeNull();
    expect(offerTermsFromCoupon({ valid: true, percent_off: 120, duration: 'once' })).toBeNull();
    expect(offerTermsFromCoupon(null)).toBeNull();
  });
});

describe('eligibility', () => {
  const healthy = { status: 'active', cancelAtPeriodEnd: false, paused: false };
  const terms = { percentOff: 30, months: 3 };

  it('only healthy, unmodified subscriptions can be changed', () => {
    expect(canModifySubscription(healthy)).toBe(true);
    expect(canModifySubscription({ ...healthy, status: 'trialing' })).toBe(true);
    expect(canModifySubscription({ ...healthy, status: 'past_due' })).toBe(false);
    expect(canModifySubscription({ ...healthy, cancelAtPeriodEnd: true })).toBe(false);
    expect(canModifySubscription({ ...healthy, paused: true })).toBe(false);
  });

  it('offer needs terms, an unused offer and a healthy subscription', () => {
    expect(isOfferEligible({ ...healthy, terms, alreadyUsedOffer: false })).toBe(true);
    expect(isOfferEligible({ ...healthy, terms, alreadyUsedOffer: true })).toBe(false);
    expect(isOfferEligible({ ...healthy, terms: null, alreadyUsedOffer: false })).toBe(false);
    expect(isOfferEligible({ ...healthy, status: 'past_due', terms, alreadyUsedOffer: false })).toBe(false);
  });
});

describe('STRIPE_FEEDBACK', () => {
  it('maps every reason to a Stripe feedback value', () => {
    for (const r of CANCEL_REASONS) expect(STRIPE_FEEDBACK[r]).toBeTruthy();
  });
});
