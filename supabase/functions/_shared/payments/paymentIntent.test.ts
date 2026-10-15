import { describe, it, expect } from 'vitest';
import {
  MIN_CHARGE_CENTS,
  buildIntentMetadata,
  buildPaymentIntentParams,
  isReusableIntentStatus,
  walletFromCharge,
} from './paymentIntent';

const BASE = { requestId: 'req_1', userId: 'user_1', baseCents: 10000, tipCents: 0 };

describe('buildIntentMetadata', () => {
  it('uses the tip_v1 keys the webhook and finalize RPC already understand', () => {
    expect(buildIntentMetadata({ ...BASE, jobId: 'job_1' })).toEqual({
      flow: 'tip_v1',
      payment_request_id: 'req_1',
      user_id: 'user_1',
      base_cents: '10000',
      tip_cents: '0',
      job_id: 'job_1',
    });
  });

  it('only attributes a tip to the technician when a tip exists', () => {
    expect(buildIntentMetadata({ ...BASE, technicianId: 'tech_1' }).technician_id).toBeUndefined();
    expect(buildIntentMetadata({ ...BASE, tipCents: 1500, technicianId: 'tech_1' }).technician_id).toBe('tech_1');
  });

  it('flags a first-time membership signup but not a renewal', () => {
    const signup = buildIntentMetadata({ ...BASE, membershipId: 'mem_1', membershipSignup: true });
    expect(signup.membership_id).toBe('mem_1');
    expect(signup.membership_signup).toBe('true');
    const renewal = buildIntentMetadata({ ...BASE, membershipId: 'mem_1', membershipSignup: false });
    expect(renewal.membership_id).toBe('mem_1');
    expect(renewal.membership_signup).toBeUndefined();
  });

  it('never emits undefined values (Stripe metadata must be strings)', () => {
    const meta = buildIntentMetadata(BASE);
    expect(Object.values(meta).every((v) => typeof v === 'string')).toBe(true);
  });
});

describe('buildPaymentIntentParams', () => {
  const input = { baseCents: 10000, tipCents: 1800, destinationAccountId: 'acct_123', description: 'AC repair', metadata: { a: 'b' } };

  it('charges invoice + tip as a destination charge with dynamic payment methods (wallets included)', () => {
    const params = buildPaymentIntentParams(input);
    expect(params.amount).toBe(11800);
    expect(params.currency).toBe('usd');
    expect(params.transfer_data).toEqual({ destination: 'acct_123' });
    expect(params.automatic_payment_methods).toEqual({ enabled: true });
    expect(params.metadata).toEqual({ a: 'b' });
  });

  it('omits receipt_email when the customer has none', () => {
    expect(buildPaymentIntentParams(input).receipt_email).toBeUndefined();
    expect(buildPaymentIntentParams({ ...input, receiptEmail: 'dana@example.com' }).receipt_email).toBe('dana@example.com');
  });

  it('rejects non-integer, non-positive and negative amounts', () => {
    expect(() => buildPaymentIntentParams({ ...input, baseCents: 100.5 })).toThrow();
    expect(() => buildPaymentIntentParams({ ...input, baseCents: 0 })).toThrow();
    expect(() => buildPaymentIntentParams({ ...input, tipCents: -1 })).toThrow();
  });

  it('rejects totals below the Stripe minimum', () => {
    expect(() => buildPaymentIntentParams({ ...input, baseCents: MIN_CHARGE_CENTS - 1, tipCents: 0 })).toThrow(/minimum/);
    expect(buildPaymentIntentParams({ ...input, baseCents: MIN_CHARGE_CENTS, tipCents: 0 }).amount).toBe(MIN_CHARGE_CENTS);
  });

  it('requires a connected account to pay out to', () => {
    expect(() => buildPaymentIntentParams({ ...input, destinationAccountId: '' })).toThrow();
  });

  it('caps the description length', () => {
    expect(String(buildPaymentIntentParams({ ...input, description: 'x'.repeat(900) }).description)).toHaveLength(500);
  });
});

describe('isReusableIntentStatus', () => {
  it('re-uses only intents that have not been paid or are not mid-processing', () => {
    expect(isReusableIntentStatus('requires_payment_method')).toBe(true);
    expect(isReusableIntentStatus('requires_confirmation')).toBe(true);
    expect(isReusableIntentStatus('requires_action')).toBe(true);
    expect(isReusableIntentStatus('processing')).toBe(false);
    expect(isReusableIntentStatus('succeeded')).toBe(false);
    expect(isReusableIntentStatus('canceled')).toBe(false);
    expect(isReusableIntentStatus(undefined)).toBe(false);
  });
});

describe('walletFromCharge', () => {
  it('detects Apple Pay and Google Pay', () => {
    expect(walletFromCharge({ payment_method_details: { card: { wallet: { type: 'apple_pay' } } } })).toBe('apple_pay');
    expect(walletFromCharge({ payment_method_details: { card: { wallet: { type: 'google_pay' } } } })).toBe('google_pay');
  });

  it('returns null for plain cards, other wallets and missing data', () => {
    expect(walletFromCharge({ payment_method_details: { card: { wallet: null } } })).toBeNull();
    expect(walletFromCharge({ payment_method_details: { card: { wallet: { type: 'samsung_pay' } } } })).toBeNull();
    expect(walletFromCharge(null)).toBeNull();
  });
});
