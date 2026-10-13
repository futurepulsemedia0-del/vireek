import { describe, it, expect } from 'vitest';
import { PRICING_PLANS } from './pricing';
import {
  PlanChangeError,
  changeActionLabel,
  classifyPlanChange,
  computeUsageImpact,
  formatCardBrand,
  formatLongDate,
  formatMinor,
  isSelfServePlan,
  isStalePreviewError,
  parseOverageRate,
  parsePlanMinutes,
} from './planChange';

const plan = (id: string) => PRICING_PLANS.find((p) => p.id === id)!;

describe('classifyPlanChange', () => {
  it('is "new" without a subscription, whatever the profile says', () => {
    expect(classifyPlanChange('professional', 'starter', false)).toBe('new');
  });

  it('detects upgrade, downgrade and same plan', () => {
    expect(classifyPlanChange('starter', 'professional', true)).toBe('upgrade');
    expect(classifyPlanChange('business', 'professional', true)).toBe('downgrade');
    expect(classifyPlanChange('starter', 'starter', true)).toBe('same');
  });
});

describe('plan parsing', () => {
  it('parses included minutes and overage from the pricing source of truth', () => {
    expect(parsePlanMinutes(plan('professional').minutes)).toBe(1500);
    expect(parsePlanMinutes(plan('enterprise').minutes)).toBeNull();
    expect(parseOverageRate(plan('starter').overage)).toBe(0.2);
    expect(parseOverageRate(null)).toBeNull();
  });

  it('only exposes Starter/Professional/Business as self-serve', () => {
    expect(isSelfServePlan('business')).toBe(true);
    expect(isSelfServePlan('enterprise')).toBe(false);
    expect(isSelfServePlan('free')).toBe(false);
  });
});

describe('formatting', () => {
  it('formats Stripe minor units per currency', () => {
    expect(formatMinor(19900, 'usd')).toBe('$199.00');
    expect(formatMinor(1500, 'jpy')).toContain('1,500');
  });

  it('handles bad dates and brands without throwing', () => {
    expect(formatLongDate(null)).toBe('—');
    expect(formatLongDate('not-a-date')).toBe('—');
    expect(formatCardBrand('amex')).toBe('American Express');
    expect(formatCardBrand('elo')).toBe('Elo');
  });
});

describe('computeUsageImpact', () => {
  it('flags a downgrade that would put already-used minutes into overage', () => {
    const impact = computeUsageImpact(1000, plan('starter'));
    expect(impact.exceedsTarget).toBe(true);
    expect(impact.overageMinutes).toBe(600);
    expect(impact.estimatedOverageUsd).toBe(120);
  });

  it('reports no impact when usage fits, or the target is unmetered', () => {
    expect(computeUsageImpact(100, plan('starter')).exceedsTarget).toBe(false);
    expect(computeUsageImpact(99999, plan('enterprise')).exceedsTarget).toBe(false);
  });
});

describe('labels and errors', () => {
  it('shows the exact amount due on the upgrade button', () => {
    expect(changeActionLabel('upgrade', 'Professional', 4250, 'usd')).toBe('Pay $42.50 & upgrade');
    expect(changeActionLabel('upgrade', 'Professional', 0, 'usd')).toBe('Upgrade to Professional');
    expect(changeActionLabel('downgrade', 'Starter')).toBe('Schedule downgrade to Starter');
    expect(changeActionLabel('new', 'Starter')).toBe('Subscribe to Starter');
  });

  it('treats changed/expired previews as recoverable', () => {
    expect(isStalePreviewError(new PlanChangeError('x', 'PRICE_CHANGED'))).toBe(true);
    expect(isStalePreviewError(new PlanChangeError('x', 'PREVIEW_EXPIRED'))).toBe(true);
    expect(isStalePreviewError(new PlanChangeError('x', 'CARD_DECLINED'))).toBe(false);
    expect(isStalePreviewError(new Error('x'))).toBe(false);
  });
});
