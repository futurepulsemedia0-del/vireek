import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AFFILIATE_MAX_COMMISSION_PCT,
  AFFILIATE_MAX_MONTHS,
  AFFILIATE_MIN_PAYOUT_CENTS,
  AFFILIATE_MONTHS_SANITY_CEILING,
  AFFILIATE_OVERRIDE_MIN_REASON_CHARS,
  commissionBaseCents,
  commissionCents,
  isPayoutEligible,
  marginAfterCommission,
  validateCommissionTerms,
} from './affiliateCommission';

// ILLUSTRATIVE TEST FIXTURE ONLY — not a measured, sourced or quoted provider rate.
// Production code must use measuredCostPerMinute() / provider_cost_rates instead.
const ILLUSTRATIVE_COST_PER_MIN_USD = 0.1;

describe('limits stay in sync with the SQL migration', () => {
  const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20290303000000_affiliate_commission_guardrails.sql'), 'utf8');
  const sqlValue = (fn: string): number => {
    const m = new RegExp(`FUNCTION public\\.${fn}\\(\\)[\\s\\S]*?SELECT (\\d+)`).exec(sql);
    if (!m) throw new Error(`${fn} not found in migration`);
    return Number(m[1]);
  };
  it('matches every constant', () => {
    expect(sqlValue('affiliate_max_commission_pct')).toBe(AFFILIATE_MAX_COMMISSION_PCT);
    expect(sqlValue('affiliate_max_months')).toBe(AFFILIATE_MAX_MONTHS);
    expect(sqlValue('affiliate_min_payout_cents')).toBe(AFFILIATE_MIN_PAYOUT_CENTS);
    expect(sqlValue('affiliate_override_min_reason_chars')).toBe(AFFILIATE_OVERRIDE_MIN_REASON_CHARS);
    expect(sqlValue('affiliate_months_sanity_ceiling')).toBe(AFFILIATE_MONTHS_SANITY_CEILING);
  });
  it('proposed defaults are the agreed values', () => {
    expect([AFFILIATE_MAX_COMMISSION_PCT, AFFILIATE_MAX_MONTHS, AFFILIATE_MIN_PAYOUT_CENTS]).toEqual([20, 12, 5000]);
  });
});

describe('validateCommissionTerms', () => {
  it('accepts terms at or below the limits without an override', () => {
    expect(validateCommissionTerms({ ratePct: 20, months: 12 })).toEqual({ ok: true, override: false });
    expect(validateCommissionTerms({ ratePct: 0, months: 1 })).toEqual({ ok: true, override: false });
  });
  it('rejects a rate above the limit without a reason, with a clear message', () => {
    const r = validateCommissionTerms({ ratePct: 20.01, months: 12 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/override reason/i);
  });
  it('rejects a term above the limit without a reason', () => {
    expect(validateCommissionTerms({ ratePct: 10, months: 13 }).ok).toBe(false);
  });
  it('rejects a blank or too-short reason', () => {
    expect(validateCommissionTerms({ ratePct: 25, months: 12, overrideReason: '   ' }).ok).toBe(false);
    expect(validateCommissionTerms({ ratePct: 25, months: 12, overrideReason: 'short' }).ok).toBe(false);
  });
  it('accepts an override with an explicit reason', () => {
    expect(validateCommissionTerms({ ratePct: 25, months: 24, overrideReason: 'Signed agency deal, approved by finance' })).toEqual({ ok: true, override: true });
  });
  it('rejects nonsense values even with a reason', () => {
    const reason = 'long enough reason text';
    for (const bad of [
      { ratePct: -1, months: 6 }, { ratePct: 101, months: 6 }, { ratePct: Number.NaN, months: 6 },
      { ratePct: 10, months: 0 }, { ratePct: 10, months: 1.5 }, { ratePct: 10, months: AFFILIATE_MONTHS_SANITY_CEILING + 1 },
    ]) {
      expect(validateCommissionTerms({ ...bad, overrideReason: reason }).ok).toBe(false);
    }
  });
});

describe('commission base and payout', () => {
  it('base = collected minus tax minus refunds, never negative', () => {
    expect(commissionBaseCents({ collectedCents: 9480, taxCents: 1580, refundedCents: 0 })).toBe(7900);
    expect(commissionBaseCents({ collectedCents: 9480, taxCents: 1580, refundedCents: 7900 })).toBe(0);
    expect(commissionBaseCents({ collectedCents: 1000, taxCents: 0, refundedCents: 5000 })).toBe(0);
  });
  it('rejects negative or fractional cents', () => {
    expect(() => commissionBaseCents({ collectedCents: -1, taxCents: 0, refundedCents: 0 })).toThrow(RangeError);
    expect(() => commissionBaseCents({ collectedCents: 100.5, taxCents: 0, refundedCents: 0 })).toThrow(RangeError);
  });
  it('computes commission cents like the SQL round()', () => {
    expect(commissionCents(7900, 20)).toBe(1580);
    expect(commissionCents(7905, 20)).toBe(1581);
    expect(() => commissionCents(100, 101)).toThrow(RangeError);
  });
  it('enforces the minimum payout', () => {
    expect(isPayoutEligible(AFFILIATE_MIN_PAYOUT_CENTS - 1)).toBe(false);
    expect(isPayoutEligible(AFFILIATE_MIN_PAYOUT_CENTS)).toBe(true);
    expect(isPayoutEligible(Number.NaN)).toBe(false);
  });
});

describe('marginAfterCommission — 20% commission, ILLUSTRATIVE cost of $0.10/min', () => {
  const COMMISSION = AFFILIATE_MAX_COMMISSION_PCT;
  // [plan, utilisation, margin % before, margin % after]. Hand-computed from list prices
  // (Starter $79/400 min, Professional $199/1,500 min, Business $399/4,000 min).
  const table: Array<[string, number, number, number]> = [
    ['starter', 0.55, 72.1519, 52.1519],
    ['starter', 1, 49.3671, 29.3671],
    ['professional', 0.55, 58.5427, 38.5427],
    ['professional', 1, 24.6231, 4.6231],
    ['business', 0.55, 44.8622, 24.8622],
    ['business', 1, -0.2506, -20.2506],
  ];
  it.each(table)('%s at %d utilisation', (plan, util, before, after) => {
    const r = marginAfterCommission(plan, util, COMMISSION, ILLUSTRATIVE_COST_PER_MIN_USD);
    expect(r.marginBeforePct).toBeCloseTo(before, 3);
    expect(r.marginAfterPct).toBeCloseTo(after, 3);
    expect(r.exceedsGuardrail).toBe(false);
  });
  it('a commission of X% of revenue always removes exactly X margin points', () => {
    for (const [plan, util] of table.map((t) => [t[0], t[1]] as const)) {
      const r = marginAfterCommission(plan, util, COMMISSION, ILLUSTRATIVE_COST_PER_MIN_USD);
      expect((r.marginBeforePct ?? 0) - (r.marginAfterPct ?? 0)).toBeCloseTo(COMMISSION, 9);
      expect(r.marginBeforeUsd - r.marginAfterUsd).toBeCloseTo(r.commissionUsd, 9);
    }
  });
  it('break-even commission equals the margin before commission', () => {
    const r = marginAfterCommission('professional', 1, 0, ILLUSTRATIVE_COST_PER_MIN_USD);
    const atBreakEven = marginAfterCommission('professional', 1, r.breakEvenCommissionPct ?? 0, ILLUSTRATIVE_COST_PER_MIN_USD);
    expect(atBreakEven.marginAfterUsd).toBeCloseTo(0, 9);
  });
  it('includes metered overage in revenue above 100% utilisation', () => {
    const r = marginAfterCommission('starter', 1.5, COMMISSION, ILLUSTRATIVE_COST_PER_MIN_USD);
    expect(r.minutes).toBe(600);
    expect(r.revenueUsd).toBeCloseTo(79 + 200 * 0.2, 9);
  });
  it('flags what-ifs above the guardrail', () => {
    expect(marginAfterCommission('starter', 0.55, 30, ILLUSTRATIVE_COST_PER_MIN_USD).exceedsGuardrail).toBe(true);
  });
  it('rejects plans without a list price and invalid inputs', () => {
    expect(() => marginAfterCommission('enterprise', 1, 20, 0.1)).toThrow(RangeError);
    expect(() => marginAfterCommission('free', 1, 20, 0.1)).toThrow(RangeError);
    expect(() => marginAfterCommission('nope', 1, 20, 0.1)).toThrow(RangeError);
    expect(() => marginAfterCommission('starter', -1, 20, 0.1)).toThrow(RangeError);
    expect(() => marginAfterCommission('starter', 1, 101, 0.1)).toThrow(RangeError);
    expect(() => marginAfterCommission('starter', 1, 20, Number.NaN)).toThrow(RangeError);
  });
});
