import { describe, expect, it } from 'vitest';
import { parseRequest } from './cancellationLogic';
import {
  carryDiscounts,
  couponMatches,
  denialFor,
  ledgerActionFor,
  offerFeasibility,
  riskFromRow,
  saveCouponId,
  signalsFromRow,
  termsOf,
  toOfferView,
  type LiveSubscription,
  type SaveOfferRow,
} from './churnSaveLogic';

const base: SaveOfferRow = { id: 'o1', kind: 'discount', name: 'x', pause_months: null, downgrade_plan: null, discount_percent: 20, discount_months: 3 };
const live: LiveSubscription = { status: 'active', cancelAtPeriodEnd: false, paused: false, discountCount: 0, hasSchedule: false };
const ok = { currentPlan: 'professional', targetPriceConfigured: true };

describe('termsOf', () => {
  it('accepts valid terms (numeric strings from PostgREST too)', () => {
    expect(termsOf({ ...base, discount_percent: '20.00' })).toEqual({ kind: 'discount', percentOff: 20, months: 3 });
    expect(termsOf({ ...base, kind: 'pause', pause_months: 2, discount_percent: null, discount_months: null })).toEqual({ kind: 'pause', months: 2 });
    expect(termsOf({ ...base, kind: 'downgrade', downgrade_plan: 'starter', discount_percent: null, discount_months: null })).toEqual({ kind: 'downgrade', plan: 'starter' });
  });
  it('rejects values above the hard ceilings', () => {
    expect(termsOf({ ...base, discount_percent: 51 })).toBeNull();
    expect(termsOf({ ...base, discount_months: 7 })).toBeNull();
    expect(termsOf({ ...base, kind: 'pause', pause_months: 4 })).toBeNull();
    expect(termsOf({ ...base, kind: 'downgrade', downgrade_plan: 'business' })).toBeNull();
    expect(termsOf({ ...base, kind: 'nope' })).toBeNull();
  });
});

describe('offerFeasibility (live Stripe state)', () => {
  const discount = termsOf(base);
  it('allows a clean subscription', () => expect(offerFeasibility(discount, live, ok)).toBeNull());
  it('blocks when already cancelling or paused', () => {
    expect(offerFeasibility(discount, { ...live, cancelAtPeriodEnd: true }, ok)).toBe('not_modifiable');
    expect(offerFeasibility(discount, { ...live, paused: true }, ok)).toBe('not_modifiable');
  });
  it('never stacks a discount on an existing discount', () => {
    expect(offerFeasibility(discount, { ...live, discountCount: 1 }, ok)).toBe('already_discounted');
  });
  it('downgrade must go to a strictly lower, configured plan with no pending schedule', () => {
    const dg = termsOf({ ...base, kind: 'downgrade', downgrade_plan: 'professional', discount_percent: null, discount_months: null });
    expect(offerFeasibility(dg, live, ok)).toBe('plan_not_lower');
    expect(offerFeasibility(dg, live, { currentPlan: 'business', targetPriceConfigured: false })).toBe('plan_not_configured');
    expect(offerFeasibility(dg, { ...live, hasSchedule: true }, { currentPlan: 'business', targetPriceConfigured: true })).toBe('schedule_exists');
    expect(offerFeasibility(dg, live, { currentPlan: 'business', targetPriceConfigured: true })).toBeNull();
    expect(offerFeasibility(dg, live, { currentPlan: 'mystery', targetPriceConfigured: true })).toBe('plan_not_lower');
  });
  it('rejects invalid terms', () => expect(offerFeasibility(null, live, ok)).toBe('invalid_terms'));
});

describe('risk reuses computeHealth', () => {
  const row = {
    id: 'a', status: 'active', subscription_status: 'active', dunning_stage: 0, onboarding_completed: true, minutes_used: 0, minutes_included: 100,
    created_at: '2025-01-01T00:00:00Z', last_sign_in_at: null, last_call_at: null, calls_30d: 0, calls_prev_30d: 20, bookings_30d: 0, team_count: 1, numbers_count: 1,
  };
  it('maps rows and scores a silent old account as unhealthy', () => {
    expect(signalsFromRow(row)?.callsPrev30d).toBe(20);
    const r = riskFromRow(row, new Date('2026-06-01T00:00:00Z'));
    expect(['at_risk', 'critical', 'watch']).toContain(r?.band);
  });
  it('returns null for malformed rows (fail closed)', () => {
    expect(riskFromRow(null)).toBeNull();
    expect(riskFromRow({ id: 1 })).toBeNull();
  });
});

describe('views, errors, stripe helpers', () => {
  it('builds a customer view without internal fields', () => {
    expect(toOfferView(base)).toEqual({ id: 'o1', kind: 'discount', name: 'x', discount_percent: 20, discount_months: 3 });
    expect(toOfferView({ ...base, kind: 'downgrade', downgrade_plan: 'starter', discount_percent: null, discount_months: null }, { priceCents: 9900, currency: 'USD' })).toMatchObject({
      downgrade_plan: 'starter', downgrade_price_cents: 9900, downgrade_minutes: 200,
    });
    expect(toOfferView({ ...base, discount_percent: 99 })).toBeNull();
  });
  it('maps cap denials without leaking which cap was hit', () => {
    expect(denialFor('account_cap')).toMatchObject({ status: 409, code: 'offer_used' });
    expect(denialFor('cooldown').code).toBe('offer_used');
    for (const c of ['total_cap', 'not_targeted', 'disabled', 'ended', 'whatever']) expect(denialFor(c).code).toBe('offer_unavailable');
    expect(JSON.stringify(denialFor('total_cap'))).not.toMatch(/total|cap/i);
  });
  it('derives a deterministic coupon id and verifies terms', () => {
    expect(saveCouponId(12.5, 3)).toBe('vireek_save_12p5_3m');
    expect(couponMatches({ valid: true, percent_off: 20, duration: 'repeating', duration_in_months: 3 }, 20, 3)).toBe(true);
    expect(couponMatches({ valid: true, percent_off: 30, duration: 'repeating', duration_in_months: 3 }, 20, 3)).toBe(false);
    expect(couponMatches({ valid: true, percent_off: 20, duration: 'forever' }, 20, 3)).toBe(false);
    expect(couponMatches({ valid: false, percent_off: 20, duration: 'repeating', duration_in_months: 3 }, 20, 3)).toBe(false);
  });
  it('carries existing discounts into the downgrade schedule', () => {
    expect(carryDiscounts([{ discount: 'di_1' }, { coupon: { id: 'c1' } }, {}])).toEqual([{ discount: 'di_1' }, { coupon: 'c1' }]);
    expect(carryDiscounts(null)).toEqual([]);
  });
  it('maps kinds to ledger actions', () => {
    expect(ledgerActionFor('pause').action).toBe('paused');
    expect(ledgerActionFor('discount').action).toBe('offer_accepted');
    expect(ledgerActionFor('downgrade').action).toBe('downgrade_scheduled');
  });
});

describe('parseRequest: new actions', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  it('accepts offers / accept_save_offer with a reason', () => {
    expect(parseRequest({ action: 'offers', reason: 'too_expensive' })).toMatchObject({ ok: true });
    expect(parseRequest({ action: 'accept_save_offer', offer_id: id.toUpperCase(), reason: 'other', detail: ' hi ' })).toEqual({
      ok: true, request: { action: 'accept_save_offer', offer_id: id, reason: 'other', detail: 'hi' },
    });
  });
  it('rejects missing reason, bad ids and oversize detail', () => {
    expect(parseRequest({ action: 'offers' })).toMatchObject({ ok: false });
    expect(parseRequest({ action: 'accept_save_offer', offer_id: 'nope', reason: 'other' })).toMatchObject({ ok: false });
    expect(parseRequest({ action: 'accept_save_offer', offer_id: id, reason: 'bogus' })).toMatchObject({ ok: false });
    expect(parseRequest({ action: 'offers', reason: 'other', detail: 'x'.repeat(1001) })).toMatchObject({ ok: false });
  });
});
