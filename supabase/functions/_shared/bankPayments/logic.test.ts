import { describe, it, expect } from 'vitest';
import {
  addBusinessDays, buildBankIntentExtras, buildBankOffer, classifyBankFailure, classifyBankReturn, estimateFeeCents,
  estimateSettlementDate, isBankEligible, mergeIntentParams, planBankEligible, suggestRail, STRIPE_CAPABILITIES,
  type BankSettings, type ProviderCapabilities,
} from './logic';

const on: BankSettings = { enabled: true, routing_mode: 'offer', min_amount_cents: 5000, max_amount_cents: 2_500_000, capability_status: 'active' };

describe('estimateFeeCents (parity with public.bank_fee_estimate)', () => {
  it('matches the SQL function values', () => {
    expect(estimateFeeCents('card', 50000)).toBe(1480);
    expect(estimateFeeCents('ach_debit', 50000)).toBe(400);
    expect(estimateFeeCents('instant_bank', 50000)).toBe(1300);
    expect(estimateFeeCents('rtp', 50000)).toBe(0);
  });
  it('caps ACH at $5 and ignores junk amounts', () => {
    expect(estimateFeeCents('ach_debit', 10_000_000)).toBe(500);
    expect(estimateFeeCents('card', 0)).toBe(0);
    expect(estimateFeeCents('card', Number.NaN)).toBe(0);
  });
});

describe('isBankEligible / planBankEligible', () => {
  it('requires enabled + active capability + amount window', () => {
    expect(isBankEligible(on, 5000)).toBe(true);
    expect(isBankEligible(on, 4999)).toBe(false);
    expect(isBankEligible(on, 2_500_001)).toBe(false);
    expect(isBankEligible({ ...on, enabled: false }, 10000)).toBe(false);
    expect(isBankEligible({ ...on, capability_status: 'pending' }, 10000)).toBe(false);
    expect(isBankEligible(null, 10000)).toBe(false);
    expect(isBankEligible(on, 100.5)).toBe(false);
  });
  it('a plan needs every amount inside the window', () => {
    expect(planBankEligible(on, [10000, 20000])).toBe(true);
    expect(planBankEligible(on, [10000, 100])).toBe(false);
    expect(planBankEligible(on, [])).toBe(false);
  });
});

describe('suggestRail', () => {
  it('recommends ACH over card when eligible and says why', () => {
    const r = suggestRail({ amountCents: 100000, settings: on });
    expect(r.rail).toBe('ach_debit');
    expect(r.offerBank).toBe(true);
    expect(r.savingsCents).toBe(estimateFeeCents('card', 100000) - estimateFeeCents('ach_debit', 100000));
    expect(r.preferBank).toBe(false); // offer mode never reorders
    expect(r.ranked.at(-1)?.rail).toBe('card');
  });
  it('prefer mode puts the bank first only when the saving is meaningful', () => {
    const p = { ...on, routing_mode: 'prefer' as const };
    expect(suggestRail({ amountCents: 100000, settings: p }).preferBank).toBe(true);
    expect(suggestRail({ amountCents: 5000, settings: p }).preferBank).toBe(true); // 175c saving
    expect(suggestRail({ amountCents: 5000, settings: { ...p, min_amount_cents: 50 } }).savingsCents).toBeGreaterThan(0);
  });
  it('falls back to card with a reason', () => {
    expect(suggestRail({ amountCents: 100000, settings: { ...on, enabled: false } })).toMatchObject({ rail: 'card', offerBank: false });
    expect(suggestRail({ amountCents: 100000, settings: { ...on, capability_status: 'pending' } }).reasons[0]).toMatch(/activated/);
    expect(suggestRail({ amountCents: 10, settings: on }).reasons[0]).toMatch(/window/);
  });
  it('never selects RTP / FedNow through Stripe, even if the flags are on', () => {
    const r = suggestRail({ amountCents: 100000, settings: { ...on, rtp_enabled: true, fednow_enabled: true } });
    expect(r.ranked.map((x) => x.rail)).toEqual(['ach_debit', 'card']);
  });
  it('uses RTP when a provider supports it and the owner enabled it (faster wins a fee tie)', () => {
    const provider: ProviderCapabilities = {
      id: 'future',
      rails: { ...STRIPE_CAPABILITIES.rails, rtp: { supported: true, selectable: true, confirmation: 'instant', maxAmountCents: 100_000_00 } },
    };
    const withRtp = suggestRail({ amountCents: 100000, settings: { ...on, rtp_enabled: true }, provider });
    expect(withRtp.rail).toBe('rtp'); // fee unknown (0) is cheapest until the adapter prices it
    const noFlag = suggestRail({ amountCents: 100000, settings: on, provider });
    expect(noFlag.rail).toBe('ach_debit');
    const tooBig = suggestRail({ amountCents: 200_000_00, settings: { ...on, rtp_enabled: true, max_amount_cents: 300_000_00 }, provider });
    expect(tooBig.ranked.some((x) => x.rail === 'rtp')).toBe(false);
  });
});

describe('classifyBankFailure', () => {
  it('only insufficient funds is retryable', () => {
    expect(classifyBankFailure('insufficient_funds')).toMatchObject({ retryable: true, invalidatesMethod: false });
    for (const c of ['account_closed', 'no_account', 'invalid_account_number', 'bank_account_restricted', 'debit_not_authorized']) {
      expect(classifyBankFailure(c)).toMatchObject({ retryable: false, invalidatesMethod: true });
    }
  });
  it('treats microdeposit failures as verification problems', () => {
    expect(classifyBankFailure('payment_method_microdeposit_verification_timeout').category).toBe('verification');
  });
  it('never retries an unknown code', () => {
    expect(classifyBankFailure('something_new')).toMatchObject({ retryable: false, invalidatesMethod: false, category: 'unknown' });
    expect(classifyBankFailure(null).retryable).toBe(false);
  });
});

describe('classifyBankReturn', () => {
  it('splits bank returns from customer disputes', () => {
    expect(classifyBankReturn('insufficient_funds')).toEqual({ status: 'returned', invalidatesMethod: false });
    expect(classifyBankReturn('incorrect_account_details').status).toBe('returned');
    expect(classifyBankReturn('debit_not_authorized')).toEqual({ status: 'disputed', invalidatesMethod: true });
    expect(classifyBankReturn(null).status).toBe('disputed');
  });
});

describe('settlement estimate', () => {
  it('skips weekends', () => {
    expect(addBusinessDays(new Date('2026-10-23T12:00:00Z'), 1)).toBe('2026-10-26'); // Fri -> Mon
    expect(addBusinessDays(new Date('2026-10-23T12:00:00Z'), 4)).toBe('2026-10-29');
    expect(addBusinessDays(new Date('2026-10-24T12:00:00Z'), 0)).toBe('2026-10-24');
  });
  it('is T+4 for ACH and same day for instant rails', () => {
    expect(estimateSettlementDate(new Date('2026-10-26T12:00:00Z'), 'ach_debit')).toBe('2026-10-30');
    expect(estimateSettlementDate(new Date('2026-10-26T12:00:00Z'), 'rtp')).toBe('2026-10-26');
  });
});

describe('PaymentIntent policy', () => {
  it('excludes ACH unless the platform AND the owner allow it for this base amount', () => {
    expect(buildBankIntentExtras({ platformEnabled: false, settings: on, baseCents: 10000 })).toEqual({ excluded_payment_method_types: ['us_bank_account'] });
    expect(buildBankIntentExtras({ platformEnabled: true, settings: { ...on, enabled: false }, baseCents: 10000 }).excluded_payment_method_types).toEqual(['us_bank_account']);
    expect(buildBankIntentExtras({ platformEnabled: true, settings: on, baseCents: 100 }).excluded_payment_method_types).toEqual(['us_bank_account']);
  });
  it('requests instant verification when allowed', () => {
    const e = buildBankIntentExtras({ platformEnabled: true, settings: on, baseCents: 10000 });
    expect(e.excluded_payment_method_types).toBeUndefined();
    expect(e.payment_method_options).toEqual({ us_bank_account: { verification_method: 'automatic', financial_connections: { permissions: ['payment_method'] } } });
  });
  it('merges without clobbering existing options or mutating the input', () => {
    const base = { amount: 1, payment_method_options: { acss_debit: { x: 1 } } };
    const out = mergeIntentParams(base, buildBankIntentExtras({ platformEnabled: true, settings: on, baseCents: 10000 }));
    expect(Object.keys(out.payment_method_options as object).sort()).toEqual(['acss_debit', 'us_bank_account']);
    expect(Object.keys(base.payment_method_options)).toEqual(['acss_debit']);
    expect(mergeIntentParams({ a: 1 }, { excluded_payment_method_types: ['us_bank_account'] })).toEqual({ a: 1, excluded_payment_method_types: ['us_bank_account'] });
  });
  it('builds a public offer only when bank is usable', () => {
    expect(buildBankOffer({ platformEnabled: true, settings: on, baseCents: 100000, amountCents: 100000 })).toMatchObject({ offered: true, confirmationDays: 4 });
    expect(buildBankOffer({ platformEnabled: false, settings: on, baseCents: 100000, amountCents: 100000 })).toBeNull();
    expect(buildBankOffer({ platformEnabled: true, settings: null, baseCents: 100000, amountCents: 100000 })).toBeNull();
  });
});
