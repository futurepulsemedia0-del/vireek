import { describe, it, expect } from 'vitest';
import {
  buildPricingDisclosure,
  buildReceiptLines,
  cashDiscountCents,
  cashDiscountForBps,
  checkoutPricing,
  computeCardFee,
  decideFeeOutcome,
  DEFAULT_PRICING_SETTINGS,
  itemizedDescription,
  percentToBps,
  settingsFromRow,
  stateRule,
  validatePricingSettings,
  type PricingSettings,
} from './pricing';

const surcharge = (over: Partial<PricingSettings> = {}): PricingSettings => ({
  ...DEFAULT_PRICING_SETTINGS,
  mode: 'surcharge',
  surchargeBps: 300,
  businessState: 'TX',
  ...over,
});
const cashMode = (bps = 300): PricingSettings => ({ ...DEFAULT_PRICING_SETTINGS, mode: 'cash_discount', cashDiscountBps: bps });

describe('computeCardFee', () => {
  it('charges nothing when pricing is off', () => {
    expect(computeCardFee(10000, DEFAULT_PRICING_SETTINGS).feeCents).toBe(0);
  });

  it('computes a 3% surcharge and rounds DOWN so it never exceeds the stated rate', () => {
    expect(computeCardFee(10000, surcharge()).feeCents).toBe(300);
    expect(computeCardFee(10050, surcharge()).feeCents).toBe(301); // 301.5 -> 301
    expect(computeCardFee(33, surcharge()).feeCents).toBe(0); // 0.99 -> no fee line at all
  });

  it('never charges a fee under an unlawful or invalid configuration (fail-safe)', () => {
    expect(computeCardFee(10000, surcharge({ businessState: 'MA' })).feeCents).toBe(0);
    expect(computeCardFee(10000, surcharge({ businessState: 'CT' })).feeCents).toBe(0);
    expect(computeCardFee(10000, surcharge({ surchargeBps: 301 })).feeCents).toBe(0);
    expect(computeCardFee(10000, surcharge({ businessState: null })).feeCents).toBe(0);
    expect(computeCardFee(10000, surcharge({ businessState: 'CO', surchargeBps: 250 })).feeCents).toBe(0);
    expect(computeCardFee(10000, surcharge({ businessState: 'CO', surchargeBps: 200 })).feeCents).toBe(200);
  });

  it('applies a flat convenience fee', () => {
    const s: PricingSettings = { ...DEFAULT_PRICING_SETTINGS, mode: 'convenience_fee', flatFeeCents: 495, businessState: 'TX' };
    expect(computeCardFee(10000, s)).toMatchObject({ feeCents: 495, mode: 'convenience_fee', label: 'Convenience fee' });
  });

  it('rejects bad inputs', () => {
    expect(computeCardFee(0, surcharge()).feeCents).toBe(0);
    expect(computeCardFee(-5, surcharge()).feeCents).toBe(0);
    expect(computeCardFee(10.5, surcharge()).feeCents).toBe(0);
  });
});

describe('cash discount (dual pricing)', () => {
  it('rounds half-up on the cent and never discounts the full amount', () => {
    expect(cashDiscountForBps(10000, 300)).toBe(300);
    expect(cashDiscountForBps(10050, 300)).toBe(302); // 301.5 -> 302
    expect(cashDiscountForBps(1, 300)).toBe(0);
  });

  it('only applies in cash_discount mode with valid settings', () => {
    expect(cashDiscountCents(20000, cashMode(300))).toBe(600);
    expect(cashDiscountCents(20000, surcharge())).toBe(0);
    expect(cashDiscountCents(20000, cashMode(600))).toBe(0); // over the 5% ceiling
  });
});

describe('validatePricingSettings', () => {
  it('blocks surcharges in prohibited states but allows a cash discount there', () => {
    expect(validatePricingSettings(surcharge({ businessState: 'CT' })).errors.mode).toMatch(/prohibited/i);
    expect(validatePricingSettings({ ...cashMode(), businessState: 'MA' }).ok).toBe(true);
  });

  it('requires a state for surcharges and caps by state', () => {
    expect(validatePricingSettings(surcharge({ businessState: null })).errors.state).toBeDefined();
    expect(validatePricingSettings(surcharge({ businessState: 'CO', surchargeBps: 300 })).errors.surcharge).toMatch(/2%/);
    expect(stateRule('CO')).toEqual({ kind: 'capped', capBps: 200 });
    expect(stateRule('ca').kind).toBe('restricted');
  });

  it('validates the flat fee range', () => {
    const base: PricingSettings = { ...DEFAULT_PRICING_SETTINGS, mode: 'convenience_fee', businessState: 'TX' };
    expect(validatePricingSettings({ ...base, flatFeeCents: 0 }).errors.flat).toBeDefined();
    expect(validatePricingSettings({ ...base, flatFeeCents: 5001 }).errors.flat).toBeDefined();
    expect(validatePricingSettings({ ...base, flatFeeCents: 500 }).ok).toBe(true);
  });
});

describe('percentToBps', () => {
  it('parses clean percentages only', () => {
    expect(percentToBps('3')).toBe(300);
    expect(percentToBps('2.5')).toBe(250);
    expect(percentToBps('0.75')).toBe(75);
    expect(percentToBps('-1')).toBeNull();
    expect(percentToBps('3.001')).toBeNull();
    expect(percentToBps('abc')).toBeNull();
    expect(percentToBps('')).toBeNull();
  });
});

describe('checkoutPricing', () => {
  it('totals invoice + tip + fee and leaves the fee off non-eligible payments', () => {
    const p = checkoutPricing(20000, 3000, surcharge());
    expect(p).toMatchObject({ feeCents: 600, totalCents: 23600, cashPriceCents: null });
    expect(checkoutPricing(20000, 0, surcharge(), false).totalCents).toBe(20000);
  });

  it('reports the cash price for dual pricing without changing the card total', () => {
    const p = checkoutPricing(20000, 0, cashMode(300));
    expect(p).toMatchObject({ feeCents: 0, totalCents: 20000, cashPriceCents: 19400, cashDiscountCents: 600 });
  });
});

describe('decideFeeOutcome (what happens after the money lands)', () => {
  const base = { feeCents: 300, mode: 'surcharge', excludeDebit: true };

  it('keeps a surcharge on a credit card', () => {
    expect(decideFeeOutcome({ ...base, methodType: 'card', funding: 'credit' })).toEqual({ keepCents: 300, refundCents: 0, reason: 'kept' });
  });

  it('refunds the surcharge on debit, prepaid, unknown funding and non-card methods', () => {
    expect(decideFeeOutcome({ ...base, methodType: 'card', funding: 'debit' })).toMatchObject({ keepCents: 0, refundCents: 300, reason: 'debit_card' });
    expect(decideFeeOutcome({ ...base, methodType: 'card', funding: 'prepaid' })).toMatchObject({ refundCents: 300, reason: 'prepaid_card' });
    expect(decideFeeOutcome({ ...base, methodType: 'card', funding: 'unknown' })).toMatchObject({ refundCents: 300, reason: 'unknown_funding' });
    expect(decideFeeOutcome({ ...base, methodType: 'us_bank_account', funding: null })).toMatchObject({ refundCents: 300, reason: 'not_card' });
  });

  it('can keep the fee on debit when the owner turned the exclusion off', () => {
    expect(decideFeeOutcome({ ...base, excludeDebit: false, methodType: 'card', funding: 'debit' }).keepCents).toBe(300);
  });

  it('keeps a convenience fee on any method and refunds a fee with a missing or unknown mode', () => {
    expect(decideFeeOutcome({ feeCents: 495, mode: 'convenience_fee', excludeDebit: true, methodType: 'us_bank_account', funding: null }).keepCents).toBe(495);
    expect(decideFeeOutcome({ feeCents: 300, mode: null, excludeDebit: true, methodType: 'card', funding: 'credit' })).toMatchObject({ refundCents: 300, reason: 'invalid_mode' });
  });

  it('does nothing when there was no fee', () => {
    expect(decideFeeOutcome({ ...base, feeCents: 0, methodType: 'card', funding: 'debit' })).toEqual({ keepCents: 0, refundCents: 0, reason: 'none' });
  });
});

describe('receipts', () => {
  it('itemises invoice, fee, refunded fee and tip, and the total equals what the card was charged', () => {
    const r = buildReceiptLines({ baseCents: 20000, tipCents: 3000, feeCents: 600, feeRefundedCents: 0, feeLabel: 'Credit card surcharge' });
    expect(r.lines.map((l) => l.key)).toEqual(['invoice', 'fee', 'tip']);
    expect(r.totalCents).toBe(23600);
  });

  it('shows a refunded fee as its own negative line so the receipt still adds up', () => {
    const r = buildReceiptLines({ baseCents: 20000, tipCents: 0, feeCents: 600, feeRefundedCents: 600, feeLabel: 'Credit card surcharge' });
    expect(r.lines.find((l) => l.key === 'fee_refund')?.cents).toBe(-600);
    expect(r.totalCents).toBe(20000);
    expect(r.lines.reduce((s, l) => s + l.cents, 0)).toBe(r.totalCents);
  });

  it('never refunds more than was charged', () => {
    expect(buildReceiptLines({ baseCents: 1000, tipCents: 0, feeCents: 30, feeRefundedCents: 999, feeLabel: '' }).totalCents).toBe(1000);
  });

  it('writes the same breakdown into the Stripe description', () => {
    expect(itemizedDescription('Furnace repair', { baseCents: 20000, tipCents: 3000, feeCents: 600, feeLabel: 'Credit card surcharge' })).toBe(
      'Furnace repair ($200.00 invoice + $6.00 credit card surcharge + $30.00 tip)',
    );
    expect(itemizedDescription('Furnace repair', { baseCents: 20000, tipCents: 0, feeCents: 0, feeLabel: '' })).toBe('Furnace repair');
  });
});

describe('settingsFromRow + disclosure', () => {
  it('is defensive about null, junk and missing columns', () => {
    expect(settingsFromRow(null)).toEqual(DEFAULT_PRICING_SETTINGS);
    expect(settingsFromRow({ mode: 'hack', surcharge_bps: -5, business_state: 'tx ' }).mode).toBe('off');
    expect(settingsFromRow({ mode: 'surcharge', surcharge_bps: 300, business_state: 'tx' })).toMatchObject({ mode: 'surcharge', surchargeBps: 300, businessState: 'TX' });
  });

  it('writes an honest disclosure for each mode', () => {
    expect(buildPricingDisclosure(surcharge())).toMatch(/3% credit card surcharge is added to credit card payments/);
    expect(buildPricingDisclosure(surcharge())).toMatch(/not charged on debit cards/);
    expect(buildPricingDisclosure(cashMode(300))).toMatch(/save 3%/);
    expect(buildPricingDisclosure(DEFAULT_PRICING_SETTINGS)).toBe('');
  });
});
