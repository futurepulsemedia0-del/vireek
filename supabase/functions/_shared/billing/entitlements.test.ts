import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PLAN_TIERS, PLAN_LIMITS, FEATURE_MIN_PLAN, FEATURE_KEYS, COUNTED_KEYS, NUMERIC_KEYS,
  resolveTier, effectiveLimit, strictestLimit, checkAddition, evaluateAddition, upgradeTarget,
  hasFeature, featureDecision, safeExtra, isPlanLimitError, planLimitError, recordingsAllowed,
  type PlanTier,
} from './entitlements';
import { PLAN_LIMITS as FRAUD_LIMITS } from '../fraud/planLimits';

const EXPECTED: Record<PlanTier, Record<string, number | null | boolean>> = {
  free: { seats: 1, locations: 1, phoneNumbers: 1, concurrentCalls: 1, smsPerMonth: 20, transcriptRetentionDays: 7, recordingsEnabled: false },
  starter: { seats: 2, locations: 1, phoneNumbers: 1, concurrentCalls: 2, smsPerMonth: 300, transcriptRetentionDays: 30, recordingsEnabled: false },
  professional: { seats: 5, locations: 1, phoneNumbers: 2, concurrentCalls: 5, smsPerMonth: 900, transcriptRetentionDays: 365, recordingsEnabled: true },
  business: { seats: 15, locations: 3, phoneNumbers: 3, concurrentCalls: 10, smsPerMonth: 2500, transcriptRetentionDays: 730, recordingsEnabled: true },
  enterprise: { seats: null, locations: null, phoneNumbers: null, concurrentCalls: null, smsPerMonth: 8000, transcriptRetentionDays: null, recordingsEnabled: true },
};

describe('limit table', () => {
  it.each(PLAN_TIERS)('%s matches the product spec', (tier) => {
    expect(PLAN_LIMITS[tier]).toEqual(EXPECTED[tier]);
  });
  it('every numeric key x tier resolves with no extras', () => {
    for (const t of PLAN_TIERS) for (const k of NUMERIC_KEYS) expect(effectiveLimit(t, k)).toBe(PLAN_LIMITS[t][k]);
  });
  it('limits never decrease as the plan grows (null = unlimited counts as highest)', () => {
    for (const k of NUMERIC_KEYS) {
      let prev = 0;
      for (const t of PLAN_TIERS) {
        const v = PLAN_LIMITS[t][k];
        const n = v === null ? Infinity : v;
        expect(n).toBeGreaterThanOrEqual(prev);
        prev = n;
      }
    }
  });
});

describe('features', () => {
  it('emergencyDetectionSms is on every plan', () => {
    for (const t of PLAN_TIERS) expect(hasFeature(t, 'emergencyDetectionSms')).toBe(true);
  });
  it.each(FEATURE_KEYS)('%s is unlocked exactly from its minimum plan', (f) => {
    const min = FEATURE_MIN_PLAN[f];
    for (const t of PLAN_TIERS) expect(hasFeature(t, f)).toBe(PLAN_TIERS.indexOf(t) >= PLAN_TIERS.indexOf(min));
  });
  it('enterprise-only features are denied below enterprise with an upgrade target', () => {
    for (const f of ['franchise', 'fullApi', 'sso', 'auditLogs', 'customVoice'] as const) {
      const d = featureDecision('business', f);
      expect(d.allowed).toBe(false);
      expect(d.error).toEqual({ code: 'PLAN_LIMIT', key: f, limit: 0, current: 0, upgradeTo: 'enterprise' });
    }
  });
  it('recordings only from professional', () => {
    expect(PLAN_TIERS.map(recordingsAllowed)).toEqual([false, false, true, true, true]);
  });
});

describe('resolveTier', () => {
  it('starter without a Stripe subscription is the free trial', () => {
    expect(resolveTier({ plan: 'starter', stripeSubscriptionId: null })).toBe('free');
    expect(resolveTier({ plan: 'starter', stripeSubscriptionId: '  ' })).toBe('free');
    expect(resolveTier({ plan: 'starter' })).toBe('free');
  });
  it('paid starter and higher plans keep their tier', () => {
    expect(resolveTier({ plan: 'starter', stripeSubscriptionId: 'sub_1' })).toBe('starter');
    expect(resolveTier({ plan: 'business', stripeSubscriptionId: null })).toBe('business');
  });
  it('override wins; unknown or missing plan is free', () => {
    expect(resolveTier({ plan: 'starter', tierOverride: 'starter' })).toBe('starter');
    expect(resolveTier({ plan: 'enterprise', tierOverride: 'bogus' })).toBe('enterprise');
    expect(resolveTier({ plan: 'platinum' })).toBe('free');
    expect(resolveTier({ plan: null })).toBe('free');
  });
});

describe('extras and custom limits', () => {
  it('adds extras to the base', () => {
    expect(effectiveLimit('starter', 'seats', { extras: { extraUsers: 3 } })).toBe(5);
    expect(effectiveLimit('business', 'locations', { extras: { extraLocations: 2 } })).toBe(5);
    expect(effectiveLimit('professional', 'phoneNumbers', { extras: { extraNumbers: 1 } })).toBe(3);
    expect(effectiveLimit('professional', 'concurrentCalls', { extras: { extraConcurrent: 5 } })).toBe(10);
  });
  it('ignores corrupt extras and never lets them reduce a limit', () => {
    for (const bad of [-4, NaN, Infinity, '3', null, undefined]) expect(safeExtra(bad)).toBe(0);
    expect(effectiveLimit('starter', 'seats', { extras: { extraUsers: -9 } })).toBe(2);
  });
  it('extras do not apply to rate/retention keys', () => {
    expect(effectiveLimit('starter', 'smsPerMonth', { extras: { extraUsers: 9 } })).toBe(300);
  });
  it('null base stays unlimited even with extras', () => {
    expect(effectiveLimit('enterprise', 'seats', { extras: { extraUsers: 5 } })).toBeNull();
  });
  it('enterprise custom_limits override, including explicit null', () => {
    expect(effectiveLimit('enterprise', 'seats', { customLimits: { seats: 40 } })).toBe(40);
    expect(effectiveLimit('enterprise', 'seats', { customLimits: { seats: null } })).toBeNull();
    expect(effectiveLimit('enterprise', 'smsPerMonth', { customLimits: { smsPerMonth: 20000 } })).toBe(20000);
    expect(effectiveLimit('enterprise', 'seats', { customLimits: { seats: -1 } })).toBeNull();
    expect(effectiveLimit('enterprise', 'seats', { customLimits: { seats: 'x' as unknown as number } })).toBeNull();
  });
  it('custom_limits is ignored on non-enterprise plans', () => {
    expect(effectiveLimit('business', 'seats', { customLimits: { seats: 999 } })).toBe(15);
  });
  it('strictestLimit handles null', () => {
    expect(strictestLimit(null, null)).toBeNull();
    expect(strictestLimit(null, 200)).toBe(200);
    expect(strictestLimit(3, null)).toBe(3);
    expect(strictestLimit(3, 200)).toBe(3);
  });
});

describe('addition + grandfathering', () => {
  it('allows up to the limit and blocks the next one', () => {
    expect(checkAddition(2, 1)).toEqual({ allowed: true, grandfathered: false });
    expect(checkAddition(2, 2)).toEqual({ allowed: false, grandfathered: false });
  });
  it('an account over its limit is grandfathered and only new additions are refused', () => {
    expect(checkAddition(2, 5)).toEqual({ allowed: false, grandfathered: true });
  });
  it('null limit always allows', () => {
    expect(checkAddition(null, 10_000)).toEqual({ allowed: true, grandfathered: false });
  });
  it('typed error carries limit, current and the cheapest plan that fits', () => {
    const r = evaluateAddition({ tier: 'free', key: 'seats', current: 1 });
    expect(r.allowed).toBe(false);
    expect(r.error).toEqual({ code: 'PLAN_LIMIT', key: 'seats', limit: 1, current: 1, upgradeTo: 'starter' });
    expect(isPlanLimitError(r.error)).toBe(true);
  });
  it('upgradeTo skips plans that still would not fit, and is null when only a contract can', () => {
    expect(upgradeTarget('locations', 2, 'free')).toBe('business');
    expect(upgradeTarget('seats', 16, 'business')).toBe('enterprise');
    expect(upgradeTarget('seats', 1, 'enterprise')).toBeNull();
    expect(evaluateAddition({ tier: 'business', key: 'seats', current: 15 }).error?.upgradeTo).toBe('enterprise');
  });
  it('fraud cap applies to phone numbers (stricter wins)', () => {
    const r = evaluateAddition({ tier: 'enterprise', key: 'phoneNumbers', current: 200, externalCap: FRAUD_LIMITS.enterprise.maxNumbers });
    expect(r.allowed).toBe(false);
    expect(r.limit).toBe(200);
  });
  it('every counted key x plan: exactly limit units fit, one more does not', () => {
    for (const t of PLAN_TIERS) for (const k of COUNTED_KEYS) {
      const lim = effectiveLimit(t, k);
      if (lim === null) { expect(evaluateAddition({ tier: t, key: k, current: 9999 }).allowed).toBe(true); continue; }
      expect(evaluateAddition({ tier: t, key: k, current: lim - 1 }).allowed).toBe(true);
      expect(evaluateAddition({ tier: t, key: k, current: lim }).allowed).toBe(false);
    }
  });
  it('isPlanLimitError rejects malformed values', () => {
    expect(isPlanLimitError(null)).toBe(false);
    expect(isPlanLimitError({ code: 'PLAN_LIMIT', key: 'seats', limit: '1', current: 1, upgradeTo: null })).toBe(false);
    expect(isPlanLimitError({ code: 'PLAN_LIMIT', key: 'seats', limit: 1, current: 1, upgradeTo: 'gold' })).toBe(false);
    expect(isPlanLimitError(planLimitError('seats', 1, 1, null))).toBe(true);
  });
});

describe('SQL mirror (20290303000000_plan_entitlements.sql)', () => {
  const sql = readFileSync(new URL('../../../migrations/20290303000000_plan_entitlements.sql', import.meta.url), 'utf8');
  const literal = /SELECT '(\{.*\})'::jsonb/.exec(sql)?.[1];
  it('plan_limit_table() equals the TypeScript tables', () => {
    expect(literal).toBeTruthy();
    const parsed = JSON.parse(literal as string);
    expect(parsed.limits).toEqual(PLAN_LIMITS);
    expect(parsed.features).toEqual(FEATURE_MIN_PLAN);
    expect(parsed.fraudMaxNumbers).toEqual(Object.fromEntries(PLAN_TIERS.map((t) => [t, FRAUD_LIMITS[t].maxNumbers])));
  });
  it('is idempotent and guarded', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS extra_users/);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS trg_plan_limit_team_members/);
    expect(sql).toMatch(/trg_protect_profile_entitlements/);
  });
});
