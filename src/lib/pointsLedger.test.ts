import { describe, expect, it } from 'vitest';
import { centsToPoints, estimateEarn, maxRedeemable, parsePoints, pointsToCents, summarizeAccounts } from '@/lib/pointsLedger';

describe('loyalty conversions', () => {
  it('converts points to cents at 100 points = $1', () => {
    expect(pointsToCents(600, 100)).toBe(600);
    expect(pointsToCents(250, 200)).toBe(125);
    expect(pointsToCents(1, 200)).toBe(0);
  });
  it('rounds points up when covering an amount', () => {
    expect(centsToPoints(125, 200)).toBe(250);
    expect(centsToPoints(1, 150)).toBe(2);
  });
  it('rejects invalid input', () => {
    expect(pointsToCents(-5, 100)).toBe(0);
    expect(pointsToCents(100, 0)).toBe(0);
    expect(centsToPoints(Number.NaN, 100)).toBe(0);
  });
});

describe('maxRedeemable', () => {
  const base = { balancePoints: 5000, remainingDueCents: 2000, invoiceTotalCents: 2000, alreadyRedeemedCents: 0, maxPct: 100, pointsPerDollar: 100 };
  it('never exceeds the amount still due', () => {
    expect(maxRedeemable(base)).toEqual({ cents: 2000, points: 2000 });
  });
  it('never exceeds the balance', () => {
    expect(maxRedeemable({ ...base, balancePoints: 300 })).toEqual({ cents: 300, points: 300 });
  });
  it('honours the percentage cap and earlier redemptions', () => {
    expect(maxRedeemable({ ...base, maxPct: 50 })).toEqual({ cents: 1000, points: 1000 });
    expect(maxRedeemable({ ...base, maxPct: 50, alreadyRedeemedCents: 1000 })).toEqual({ cents: 0, points: 0 });
  });
  it('is never negative', () => {
    expect(maxRedeemable({ ...base, remainingDueCents: 0 }).cents).toBe(0);
  });
});

describe('estimateEarn', () => {
  it('earns per dollar and applies the member multiplier', () => {
    expect(estimateEarn({ baseCents: 10000, pointsPerDollar: 1 })).toBe(100);
    expect(estimateEarn({ baseCents: 10000, pointsPerDollar: 1, multiplier: 1.5 })).toBe(150);
  });
  it('adds a flat bonus and floors fractions', () => {
    expect(estimateEarn({ baseCents: 999, pointsPerDollar: 1, flatPoints: 10 })).toBe(19);
  });
  it('earns nothing on a zero or negative base', () => {
    expect(estimateEarn({ baseCents: -50, pointsPerDollar: 2 })).toBe(0);
  });
});

describe('parsePoints / summarizeAccounts', () => {
  it('parses whole positive numbers only', () => {
    expect(parsePoints('1,250')).toBe(1250);
    expect(parsePoints('12.5')).toBeNull();
    expect(parsePoints('0')).toBeNull();
    expect(parsePoints('-3')).toBeNull();
  });
  it('sums balances and counts members with points', () => {
    const s = summarizeAccounts([
      { balance_points: 100, lifetime_earned: 300, lifetime_redeemed: 200 },
      { balance_points: 0, lifetime_earned: 50, lifetime_redeemed: 50 },
    ]);
    expect(s).toEqual({ outstandingPoints: 100, earnedPoints: 350, redeemedPoints: 250, members: 1 });
  });
});
