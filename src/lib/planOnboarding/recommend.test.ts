import { describe, expect, it } from 'vitest';
import { PRICING_PLANS } from '@/lib/pricing';
import { ASSUMED_MINUTES_PER_CALL, SELF_SERVE_LIMITS, hasAnyAnswer, parseCount, planLimits, recommendPlan } from './recommend';

describe('parseCount / limits come from PRICING_PLANS (drift guard)', () => {
  it('parses display strings', () => {
    expect(parseCount('1,500 min')).toBe(1500);
    expect(parseCount('Up to 3 locations')).toBe(3);
    expect(parseCount('1 location')).toBe(1);
    expect(parseCount('Custom seats')).toBeNull();
    expect(parseCount(null)).toBeNull();
  });
  it('every self-serve plan has numeric minutes, seats, locations, monthly price', () => {
    expect(SELF_SERVE_LIMITS.map((l) => l.id)).toEqual(['starter', 'professional', 'business']);
    for (const l of SELF_SERVE_LIMITS) {
      expect(l.minutes).not.toBeNull();
      expect(l.seats).not.toBeNull();
      expect(l.locations).not.toBeNull();
      expect(l.monthly).not.toBeNull();
      expect(l.overageRate).not.toBeNull();
    }
    const ent = planLimits(PRICING_PLANS.find((p) => p.id === 'enterprise')!);
    expect(ent.custom).toBe(true);
  });
});

describe('recommendPlan', () => {
  it('returns null with no answers (all three are optional)', () => {
    expect(recommendPlan({})).toBeNull();
    expect(recommendPlan({ monthlyCalls: null, technicians: undefined, locations: Number.NaN })).toBeNull();
    expect(hasAnyAnswer({ technicians: 0 })).toBe(true);
  });
  it('solo owner with few calls -> Starter', () => {
    const r = recommendPlan({ monthlyCalls: 40, technicians: 0, locations: 1 })!;
    expect(r.planId).toBe('starter');
    expect(r.needs).toEqual({ minutes: 40 * ASSUMED_MINUTES_PER_CALL, seats: 1, locations: 1 });
    expect(r.overageMinutes).toBe(0);
    expect(r.reasons).toEqual(['fits_all']);
  });
  it('seats drive the plan: 5 technicians need 6 seats -> Business, not Professional (5 seats)', () => {
    const r = recommendPlan({ technicians: 5 })!;
    expect(r.planId).toBe('business');
    expect(r.reasons).toContain('seats');
  });
  it('locations drive the plan: 2 locations -> Business', () => {
    expect(recommendPlan({ locations: 2 })!.planId).toBe('business');
  });
  it('prefers a cheaper plan with overage over a bigger plan when total cost is lower', () => {
    // 70 calls * 3 = 210 min: Starter (200 included) + 10 min overage is far cheaper than Professional.
    const r = recommendPlan({ monthlyCalls: 70, technicians: 1 })!;
    expect(r.planId).toBe('starter');
    expect(r.overageMinutes).toBe(10);
    expect(r.reasons).toContain('minutes_overage');
    expect(r.estimatedMonthly).toBeCloseTo(99 + 10 * 0.25, 5);
  });
  it('moves up once overage costs more than the next plan', () => {
    // 330 calls * 3 = 990 min: Starter = 99 + 790*0.25 = 296.5, Professional = 249 + 390*0.25 = 346.5 -> Starter still cheaper;
    // 600 calls * 3 = 1800 min: Business = 549 + 300*.25 = 624 vs Professional = 249 + 1200*.25 = 549 -> Professional.
    expect(recommendPlan({ monthlyCalls: 600, technicians: 3 })!.planId).toBe('professional');
  });
  it('points to Enterprise (sales) beyond self-serve limits, never a made-up plan', () => {
    expect(recommendPlan({ locations: 4 })).toMatchObject({ planId: 'enterprise', estimatedMonthly: null, reasons: ['beyond_self_serve'] });
    expect(recommendPlan({ technicians: 40 })!.planId).toBe('enterprise');
  });
  it('sanitises junk input instead of throwing', () => {
    expect(recommendPlan({ monthlyCalls: -5, technicians: Number.POSITIVE_INFINITY })).toBeNull();
    expect(() => recommendPlan({ monthlyCalls: 1e12, technicians: 1 })).not.toThrow();
  });
});
