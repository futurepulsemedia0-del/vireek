import { describe, it, expect } from 'vitest';
import {
  classifyPlanChange,
  isPurchasablePlan,
  minutesForPlan,
  planIdFromPriceId,
  planRank,
} from './planCatalog';

const env: Record<string, string> = {
  STRIPE_PRICE_STARTER: 'price_s',
  STRIPE_PRICE_PROFESSIONAL: 'price_p',
  STRIPE_PRICE_BUSINESS: 'price_b',
};
const readEnv = (key: string) => env[key];

describe('classifyPlanChange', () => {
  it('treats any purchase without a subscription as new', () => {
    expect(classifyPlanChange('free', 'professional', false)).toBe('new');
  });

  it('detects upgrades, downgrades and no-ops', () => {
    expect(classifyPlanChange('starter', 'business', true)).toBe('upgrade');
    expect(classifyPlanChange('business', 'starter', true)).toBe('downgrade');
    expect(classifyPlanChange('professional', 'professional', true)).toBe('same');
  });

  it('treats an unknown current plan as an upgrade (never a silent downgrade)', () => {
    expect(classifyPlanChange('legacy-gold', 'starter', true)).toBe('upgrade');
  });
});

describe('plan catalog helpers', () => {
  it('only allows self-serve plans to be purchased', () => {
    expect(isPurchasablePlan('starter')).toBe(true);
    expect(isPurchasablePlan('enterprise')).toBe(false);
    expect(isPurchasablePlan('free')).toBe(false);
    expect(isPurchasablePlan(undefined)).toBe(false);
  });

  it('ranks plans in ascending order and flags unknown ids', () => {
    expect(planRank('free')).toBeLessThan(planRank('starter'));
    expect(planRank('business')).toBeLessThan(planRank('enterprise'));
    expect(planRank('nope')).toBe(-1);
  });

  it('maps a Stripe price id back to its plan', () => {
    expect(planIdFromPriceId('price_p', readEnv)).toBe('professional');
    expect(planIdFromPriceId('price_unknown', readEnv)).toBeNull();
    expect(planIdFromPriceId(null, readEnv)).toBeNull();
  });

  it('returns included minutes per plan', () => {
    expect(minutesForPlan('starter')).toBe(400);
    expect(minutesForPlan('business')).toBe(4000);
    expect(minutesForPlan('free')).toBe(50);
    expect(minutesForPlan('enterprise')).toBeNull();
  });
});
