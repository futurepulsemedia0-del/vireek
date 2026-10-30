import { describe, it, expect } from 'vitest';
import { quoteFee as serverQuoteFee, DEFAULT_PRICING } from '../../supabase/functions/_shared/instantPayouts/logic';
import { describeFeeSchedule, dollarsToCents, formatMoney, quoteInstantPayoutFee, validateInstantPayoutAmount } from '@/lib/instantPayouts';

const pricings = [
  DEFAULT_PRICING,
  { feeBps: 150, feeMinCents: 75, feeMaxCents: 2_500 },
  { feeBps: 0, feeMinCents: 0, feeMaxCents: null },
  { feeBps: 100, feeMinCents: 0, feeMaxCents: null },
];

describe('fee quote parity with the server', () => {
  it('matches the edge-function quote for a wide grid of amounts and fee schedules', () => {
    for (const p of pricings) {
      for (let cents = 0; cents <= 1_000_000; cents += cents < 5_000 ? 7 : 12_345) {
        expect(quoteInstantPayoutFee(cents, p)).toBe(serverQuoteFee(cents, p));
      }
    }
  });
});

describe('dollarsToCents', () => {
  it('parses plain amounts', () => {
    expect(dollarsToCents('250')).toBe(25_000);
    expect(dollarsToCents('250.5')).toBe(25_050);
    expect(dollarsToCents('$1,250.05')).toBe(125_005);
    expect(dollarsToCents(' 0.99 ')).toBe(99);
  });
  it('rejects junk', () => {
    for (const bad of ['', 'abc', '1.234', '-5', '1e3', '12345678', '1.']) expect(dollarsToCents(bad)).toBeNull();
  });
});

describe('validateInstantPayoutAmount', () => {
  const pricing = { feeBps: 100, feeMinCents: 50, feeMaxCents: null, minPayoutCents: 100, maxPayoutCents: 999_900 };
  it('enforces minimum, maximum and parse errors', () => {
    expect(validateInstantPayoutAmount(null, pricing, 50_000)).toMatch(/Enter an amount/);
    expect(validateInstantPayoutAmount(99, pricing, 50_000)).toMatch(/minimum/);
    expect(validateInstantPayoutAmount(50_001, pricing, 50_000)).toMatch(/up to \$500\.00/);
    expect(validateInstantPayoutAmount(50_000, pricing, 50_000)).toBeNull();
  });
});

describe('formatting', () => {
  it('describes the fee schedule', () => {
    expect(describeFeeSchedule(DEFAULT_PRICING)).toBe('1% (min $0.50)');
    expect(describeFeeSchedule({ feeBps: 150, feeMinCents: 75, feeMaxCents: 2_500 })).toBe('1.5% (min $0.75, max $25.00)');
    expect(describeFeeSchedule({ feeBps: 0, feeMinCents: 0, feeMaxCents: null })).toBe('No fee');
  });
  it('formats money', () => {
    expect(formatMoney(125_005)).toBe('$1,250.05');
  });
});
