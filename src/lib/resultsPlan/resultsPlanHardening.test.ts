import { describe, expect, it } from 'vitest';
import { RESULTS_PLAN_DEFAULTS, qualifyJob, type ContactFacts, type JobFacts, type RulesConfig } from '../../../supabase/functions/_shared/results-plan/qualification';
import { fairUseLevel, validateForApproval, type PricingTerms } from '../../../supabase/functions/_shared/results-plan/pricing';
import { UNIT_COST_DEFAULTS } from '../../../supabase/functions/_shared/results-plan/unitEconomics';

const T0 = '2026-03-01T10:00:00.000Z';
const iso = (h: number) => new Date(Date.parse(T0) + h * 3_600_000).toISOString();
const job = (o: Partial<JobFacts> = {}): JobFacts => ({ id: 'j1', customerKey: 'c1', addressKey: 'a1', createdAt: T0, source: 'sarah', status: 'in_progress', confirmedAt: iso(2), completedAt: null, paidAt: null, cancelledAt: null, ...o });
const contact: ContactFacts = { handledBySarah: true, channel: 'call', isSpam: false, isWrongNumber: false };
const cfg = (o: Partial<RulesConfig> = {}): RulesConfig => ({ ...RESULTS_PLAN_DEFAULTS, ...o });

describe('rework / callback visits are never billed', () => {
  it('rework job is rejected', () => { const r = qualifyJob(job({ isRework: true, completedAt: iso(30) }), contact, [], cfg(), iso(100)); expect(r.billable).toBe(false); expect(r.reasons).toContain('rework'); });
  it('non-rework job unaffected', () => expect(qualifyJob(job({ isRework: false, completedAt: iso(30) }), contact, [], cfg(), iso(100)).billable).toBe(true));
  it('rework is listed together with other exclusions', () => expect(qualifyJob(job({ isRework: true, source: 'owner' }), contact, [], cfg(), iso(100)).reasons).toEqual(['owner_created', 'rework']));
});

describe('confirmed fallback (owner never marks completion)', () => {
  const on = cfg({ confirmedFallbackDays: 14 });
  const at = (days: number) => iso(2 + days * 24);
  it('off by default: confirmed-only job is not billable', () => { const r = qualifyJob(job(), contact, [], cfg(), at(60)); expect(r.billable).toBe(false); expect(r.reasons).toEqual(['below_billing_level']); });
  it('not billable before the waiting period ends', () => expect(qualifyJob(job(), contact, [], on, at(13.9)).billable).toBe(false));
  it('billable exactly when the waiting period ends, billed at confirmed', () => {
    const r = qualifyJob(job(), contact, [], on, at(14));
    expect(r.billable).toBe(true); expect(r.viaFallback).toBe(true); expect(r.billedAtLevel).toBe('confirmed'); expect(r.billableAt).toBe(at(14));
  });
  it('a cancelled job never falls back', () => expect(qualifyJob(job({ cancelledAt: iso(500) }), contact, [], on, at(60)).billable).toBe(false));
  it('unconfirmed job never falls back', () => expect(qualifyJob(job({ confirmedAt: null }), contact, [], on, at(60)).billable).toBe(false));
  it('does not apply when billing level is confirmed or booked', () => {
    const r = qualifyJob(job(), contact, [], cfg({ billingLevel: 'confirmed', confirmedFallbackDays: 14 }), at(1));
    expect(r.billable).toBe(true); expect(r.viaFallback).toBe(false);
  });
  it('normal completion bills at the configured level, not as fallback', () => {
    const r = qualifyJob(job({ completedAt: iso(30) }), contact, [], on, at(60));
    expect(r.viaFallback).toBe(false); expect(r.billedAtLevel).toBe('completed'); expect(r.billableAt).toBe(iso(30));
  });
  it('excluded jobs never fall back', () => expect(qualifyJob(job({ source: 'owner' }), contact, [], on, at(60)).billable).toBe(false));
  it('a cancellation shortly after the fallback billing voids it', () => {
    const r = qualifyJob(job({ cancelledAt: at(15) }), contact, [], on, at(60));
    expect(r.billable).toBe(false); expect(r.reasons).toContain('cancelled_before_billing_event');
  });
});

const T: PricingTerms = { model: 'hybrid', baseFeeCents: 1000, perJobCents: 500, tierPriceCents: {}, monthlyFloorCents: 0, monthlyCapCents: 19900, neverExceedFlatCents: null, guaranteeDays: 30, guaranteeCapCents: 7900 };
describe('approval gate', () => {
  it('accepts complete terms', () => expect(validateForApproval(T)).toEqual([]));
  it('requires a monthly cap', () => expect(validateForApproval({ ...T, monthlyCapCents: null })).toContain('cap_required'));
  it('requires a guarantee cap when a guarantee exists', () => expect(validateForApproval({ ...T, guaranteeCapCents: null })).toContain('guarantee_cap_required'));
  it('guarantee cap not needed without a guarantee', () => expect(validateForApproval({ ...T, guaranteeDays: 0, guaranteeCapCents: null })).toEqual([]));
});

describe('fair-use minutes', () => {
  it('levels', () => { expect(fairUseLevel(0, 1500)).toBe(0); expect(fairUseLevel(1199, 1500)).toBe(0); expect(fairUseLevel(1200, 1500)).toBe(80); expect(fairUseLevel(1499, 1500)).toBe(80); expect(fairUseLevel(1500, 1500)).toBe(100); expect(fairUseLevel(9999, 1500)).toBe(100); });
  it('no limit or bad input is safe', () => { expect(fairUseLevel(500, null)).toBe(0); expect(fairUseLevel(500, 0)).toBe(0); expect(fairUseLevel(-1, 100)).toBe(0); expect(fairUseLevel(NaN, 100)).toBe(0); });
});

describe('unit-cost defaults reflect Stripe Billing', () => {
  it('payment fee includes the 0.7% Billing fee', () => expect(UNIT_COST_DEFAULTS.paymentPercentFee).toBeCloseTo(0.036, 5));
});
