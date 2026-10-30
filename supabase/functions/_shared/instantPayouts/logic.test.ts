import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PRICING,
  MAX_PAYOUT_CENTS,
  MIN_PAYOUT_CENTS,
  evaluateEligibility,
  friendlyFailureMessage,
  isAmbiguousStripeFailure,
  isPricingInSync,
  loadPricing,
  mapStripePayoutStatus,
  parseRequestInput,
  pickDestination,
  quoteFee,
  type EligibilityInput,
  type ExternalAccountSummary,
} from './logic';

const card: ExternalAccountSummary = {
  id: 'card_1',
  type: 'card',
  label: 'Visa debit •••• 4242',
  last4: '4242',
  currency: 'usd',
  defaultForCurrency: true,
  instantCapable: true,
  usable: true,
};

const ok: EligibilityInput = {
  canManage: true,
  stripeAccountId: 'acct_1',
  detailsSubmitted: true,
  payoutsEnabled: true,
  hasOpenDispute: false,
  accountAgeDays: 30,
  minAccountAgeDays: 0,
  destinations: [card],
  balance: { currency: 'usd', grossCents: 50_500, netByDestination: { card_1: 50_000 } },
};

describe('quoteFee', () => {
  it('charges 1% with a 50¢ minimum by default', () => {
    expect(quoteFee(10_000, DEFAULT_PRICING)).toBe(100); // $100 -> $1.00
    expect(quoteFee(1_000, DEFAULT_PRICING)).toBe(50); // 10¢ -> clamped to 50¢
    expect(quoteFee(100, DEFAULT_PRICING)).toBe(50);
    expect(quoteFee(50_000, DEFAULT_PRICING)).toBe(500);
  });
  it('rounds half up and honours a maximum', () => {
    expect(quoteFee(12_350, { feeBps: 100, feeMinCents: 0, feeMaxCents: null })).toBe(124); // 123.5 -> 124
    expect(quoteFee(500_000, { feeBps: 100, feeMinCents: 50, feeMaxCents: 2_000 })).toBe(2_000);
  });
  it('returns 0 for zero pricing and for non-positive amounts', () => {
    expect(quoteFee(10_000, { feeBps: 0, feeMinCents: 0, feeMaxCents: null })).toBe(0);
    expect(quoteFee(0, DEFAULT_PRICING)).toBe(0);
    expect(quoteFee(-5, DEFAULT_PRICING)).toBe(0);
    expect(quoteFee(Number.NaN, DEFAULT_PRICING)).toBe(0);
  });
});

describe('loadPricing', () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  it('uses defaults when unset or invalid (never throws)', () => {
    expect(loadPricing(env({}))).toEqual(DEFAULT_PRICING);
    expect(loadPricing(env({ INSTANT_PAYOUT_FEE_BPS: 'abc', INSTANT_PAYOUT_FEE_MIN_CENTS: '-4', INSTANT_PAYOUT_FEE_MAX_CENTS: 'x' }))).toEqual(DEFAULT_PRICING);
  });
  it('reads valid overrides, including free (0/0)', () => {
    expect(loadPricing(env({ INSTANT_PAYOUT_FEE_BPS: '150', INSTANT_PAYOUT_FEE_MIN_CENTS: '75', INSTANT_PAYOUT_FEE_MAX_CENTS: '2500' }))).toEqual({ feeBps: 150, feeMinCents: 75, feeMaxCents: 2500 });
    expect(loadPricing(env({ INSTANT_PAYOUT_FEE_BPS: '0', INSTANT_PAYOUT_FEE_MIN_CENTS: '0' }))).toMatchObject({ feeBps: 0, feeMinCents: 0 });
  });
});

describe('isPricingInSync', () => {
  it('accepts a gap that matches the configured fee (±1¢) and rejects a mismatch', () => {
    expect(isPricingInSync(50_500, 50_000, DEFAULT_PRICING)).toBe(true);
    expect(isPricingInSync(50_000, 50_000, DEFAULT_PRICING)).toBe(false); // Stripe charges no fee but we display one
    expect(isPricingInSync(50_000, 50_000, { feeBps: 0, feeMinCents: 0, feeMaxCents: null })).toBe(true);
    expect(isPricingInSync(49_000, 50_000, DEFAULT_PRICING)).toBe(false);
  });
});

describe('parseRequestInput', () => {
  const valid = { action: 'request', amount_cents: 12_500, expected_fee_cents: 125, idempotency_key: 'a1b2c3d4-e5f6-7890' };
  it('defaults to eligibility and accepts the simple actions', () => {
    expect(parseRequestInput(undefined)).toEqual({ ok: true, value: { action: 'eligibility' } });
    expect(parseRequestInput({ action: 'dashboard_link' })).toEqual({ ok: true, value: { action: 'dashboard_link' } });
  });
  it('accepts a valid request', () => {
    const r = parseRequestInput(valid);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.action === 'request') {
      expect(r.value.amountCents).toBe(12_500);
      expect(r.value.expectedFeeCents).toBe(125);
    }
  });
  it('rejects fractional, tiny, huge, and non-number amounts', () => {
    for (const amount_cents of [12.5, 0, -1, MIN_PAYOUT_CENTS - 1, MAX_PAYOUT_CENTS + 1, '100', null]) {
      expect(parseRequestInput({ ...valid, amount_cents }).ok).toBe(false);
    }
  });
  it('requires the fee the user saw and a well-formed idempotency key', () => {
    expect(parseRequestInput({ ...valid, expected_fee_cents: undefined }).ok).toBe(false);
    expect(parseRequestInput({ ...valid, expected_fee_cents: -1 }).ok).toBe(false);
    expect(parseRequestInput({ ...valid, idempotency_key: 'short' }).ok).toBe(false);
    expect(parseRequestInput({ ...valid, idempotency_key: 'has spaces in it!' }).ok).toBe(false);
  });
  it('validates resume ids and rejects unknown actions', () => {
    expect(parseRequestInput({ action: 'resume', payout_id: 'nope' }).ok).toBe(false);
    expect(parseRequestInput({ action: 'resume', payout_id: '0b9f2b5e-7c1d-4a52-9d0e-3f1f6c2a8b11' }).ok).toBe(true);
    expect(parseRequestInput({ action: 'drop_tables' }).ok).toBe(false);
  });
});

describe('evaluateEligibility', () => {
  it('is eligible with a debit card and a balance, capped at the net amount', () => {
    const e = evaluateEligibility(ok);
    expect(e.eligible).toBe(true);
    expect(e.destination?.id).toBe('card_1');
    expect(e.availableCents).toBe(50_500);
    expect(e.maxPayoutCents).toBe(50_000);
  });
  it('caps the payout at the per-payout maximum', () => {
    const e = evaluateEligibility({ ...ok, balance: { currency: 'usd', grossCents: 5_000_000, netByDestination: { card_1: 4_950_000 } } });
    expect(e.maxPayoutCents).toBe(MAX_PAYOUT_CENTS);
  });
  it.each([
    ['forbidden', { canManage: false }],
    ['not_connected', { stripeAccountId: null }],
    ['onboarding_incomplete', { detailsSubmitted: false }],
    ['payouts_disabled', { payoutsEnabled: false }],
    ['open_dispute', { hasOpenDispute: true }],
    ['account_too_new', { accountAgeDays: 1, minAccountAgeDays: 3 }],
    ['no_instant_destination', { destinations: [{ ...card, instantCapable: false }] }],
    ['no_instant_balance', { balance: { currency: 'usd', grossCents: 40, netByDestination: { card_1: 39 } } }],
    ['no_instant_balance', { balance: null }],
  ] as const)('is blocked with reason %s', (reason, patch) => {
    const e = evaluateEligibility({ ...ok, ...patch } as EligibilityInput);
    expect(e.eligible).toBe(false);
    expect(e.reason).toBe(reason);
    expect(e.message).toBeTruthy();
    expect(e.maxPayoutCents).toBe(0);
  });
  it('ignores prepaid/errored/non-USD destinations', () => {
    for (const bad of [{ usable: false }, { currency: 'eur' }]) {
      expect(evaluateEligibility({ ...ok, destinations: [{ ...card, ...bad }] }).reason).toBe('no_instant_destination');
    }
  });
});

describe('pickDestination', () => {
  const second = { ...card, id: 'card_2', defaultForCurrency: false };
  it('prefers the default destination, else the one with the most room', () => {
    const bal = { currency: 'usd', grossCents: 0, netByDestination: { card_1: 100, card_2: 900 } };
    expect(pickDestination([second, card], bal)?.id).toBe('card_1');
    expect(pickDestination([second, { ...card, defaultForCurrency: false }], bal)?.id).toBe('card_2');
    expect(pickDestination([], bal)).toBeNull();
  });
});

describe('Stripe mapping helpers', () => {
  it('maps payout statuses', () => {
    expect(mapStripePayoutStatus('paid')).toBe('paid');
    expect(mapStripePayoutStatus('failed')).toBe('failed');
    expect(mapStripePayoutStatus('canceled')).toBe('canceled');
    expect(mapStripePayoutStatus('in_transit')).toBe('in_transit');
    expect(mapStripePayoutStatus('pending')).toBe('in_transit');
    expect(mapStripePayoutStatus('something_new')).toBe('in_transit');
  });
  it('turns failure codes into plain language', () => {
    expect(friendlyFailureMessage('account_closed')).toMatch(/closed/);
    expect(friendlyFailureMessage('weird_code', 'Raw message')).toBe('Raw message');
    expect(friendlyFailureMessage(null, null)).toMatch(/could not complete/i);
  });
  it('treats only 4xx (except 409) as a definite failure', () => {
    expect(isAmbiguousStripeFailure({ status: 400 })).toBe(false);
    expect(isAmbiguousStripeFailure({ status: 402 })).toBe(false);
    expect(isAmbiguousStripeFailure({ status: 409 })).toBe(true);
    expect(isAmbiguousStripeFailure({ status: 500 })).toBe(true);
    expect(isAmbiguousStripeFailure(new TypeError('network'))).toBe(true);
  });
});
