import { describe, it, expect } from 'vitest';
import { COMPARE_VALUES, PRICING_PLANS, type PlanId } from './pricing';
import {
  AT_RISK_FRACTION, PLAN_SUPPORT_TIER, SUPPORT_TIERS, SUPPORT_TIER_IDS, publicFirstResponseText,
  resolveSupportTier, supportTierForPlan, tierClockState,
} from './supportTiers';

const T0 = Date.parse('2026-11-26T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

describe('plan -> tier mapping', () => {
  it('covers every catalog plan with a known tier', () => {
    for (const p of PRICING_PLANS) expect(SUPPORT_TIER_IDS).toContain(PLAN_SUPPORT_TIER[p.id]);
  });
  it('maps each plan to its tier', () => {
    expect(resolveSupportTier('free')).toBe('community');
    expect(resolveSupportTier('starter')).toBe('standard');
    expect(resolveSupportTier('professional')).toBe('priority');
    expect(resolveSupportTier('business')).toBe('dedicated');
    expect(resolveSupportTier('enterprise')).toBe('enterprise');
  });
  it('accepts legacy spellings and ignores case/space', () => {
    expect(resolveSupportTier('pro')).toBe('priority');
    expect(resolveSupportTier(' Trial ')).toBe('community');
    expect(resolveSupportTier('BUSINESS')).toBe('dedicated');
  });
  it('falls back to the most restrictive tier for unknown input, incl. prototype keys', () => {
    for (const v of [null, undefined, '', 'gold', 'constructor', '__proto__', 'toString']) {
      expect(resolveSupportTier(v)).toBe('community');
    }
  });
});

describe('public label stays in sync with the pricing page', () => {
  for (const p of PRICING_PLANS) {
    it(`${p.id}: COMPARE_VALUES.support equals the tier label`, () => {
      expect(COMPARE_VALUES.support?.[p.id as PlanId]).toBe(supportTierForPlan(p.id).label);
    });
  }
});

describe('no response-time promise without owner + counsel sign-off', () => {
  it('ships with every target unset', () => {
    for (const id of SUPPORT_TIER_IDS) {
      expect(SUPPORT_TIERS[id].firstResponseMinutes).toBeNull();
      expect(SUPPORT_TIERS[id].resolutionMinutes).toBeNull();
    }
  });
  it('never renders public target text while unpublished', () => {
    for (const id of SUPPORT_TIER_IDS) expect(publicFirstResponseText(SUPPORT_TIERS[id])).toBeNull();
    expect(publicFirstResponseText({ ...SUPPORT_TIERS.priority, firstResponseMinutes: 60 })).toBeNull();
  });
  it('pricing labels contain no digits (claims gate stays quiet)', () => {
    for (const id of SUPPORT_TIER_IDS) expect(SUPPORT_TIERS[id].label).not.toMatch(/\d/);
  });
});

describe('tierClockState', () => {
  const base = { startedAt: iso(T0), minutes: 100, stoppedAt: null as string | null };
  it('is untracked without a target or with bad input', () => {
    expect(tierClockState({ ...base, minutes: null })).toBe('untracked');
    expect(tierClockState({ ...base, minutes: 0 })).toBe('untracked');
    expect(tierClockState({ ...base, minutes: Number.NaN })).toBe('untracked');
    expect(tierClockState({ ...base, startedAt: 'nope' })).toBe('untracked');
    expect(tierClockState({ ...base, stoppedAt: 'nope' })).toBe('untracked');
  });
  it('runs on_track -> at_risk -> overdue', () => {
    expect(tierClockState({ ...base, nowMs: T0 + 10 * MIN })).toBe('on_track');
    expect(tierClockState({ ...base, nowMs: T0 + 100 * MIN * (1 - AT_RISK_FRACTION) })).toBe('at_risk');
    expect(tierClockState({ ...base, nowMs: T0 + 100 * MIN })).toBe('at_risk'); // exactly due is not yet overdue
    expect(tierClockState({ ...base, nowMs: T0 + 100 * MIN + 1 })).toBe('overdue');
  });
  it('stops at the reply time: met on time, missed when late', () => {
    expect(tierClockState({ ...base, stoppedAt: iso(T0 + 100 * MIN), nowMs: T0 + 999 * MIN })).toBe('met');
    expect(tierClockState({ ...base, stoppedAt: iso(T0 + 100 * MIN + 1), nowMs: T0 })).toBe('missed');
  });
  it('pauses (without moving the deadline) while waiting on the customer', () => {
    expect(tierClockState({ ...base, paused: true, nowMs: T0 + 500 * MIN })).toBe('paused');
    expect(tierClockState({ ...base, paused: true, stoppedAt: iso(T0 + 5 * MIN) })).toBe('met');
  });
});
