import { describe, it, expect } from 'vitest';
import { collectPricingDrift } from '../../supabase/functions/_shared/billing/pricingInvariants';
import { PURCHASABLE_PLANS, FREE_MINUTES_INCLUDED, TRIAL_MINUTES } from '../../supabase/functions/_shared/billing/planCatalog';
import { FREE_MINUTES, PLAN_PRICE_CENTS } from '../../supabase/functions/_shared/fraud/planLimits';
import { PLAN_MONTHLY_CENTS } from '../../supabase/functions/_shared/value-scoreboard/engine';
import { PRICING_PLANS } from './pricing';

describe('pricing single source of truth', () => {
  it('has no drift between pricingCatalog and every copy of a price / allowance', () => {
    const drift = collectPricingDrift({
      purchasable: PURCHASABLE_PLANS,
      freeMinutes: FREE_MINUTES_INCLUDED,
      trialMinutes: TRIAL_MINUTES,
      fraudFreeMinutes: FREE_MINUTES,
      planPriceCents: PLAN_PRICE_CENTS,
      scoreboardMonthlyCents: PLAN_MONTHLY_CENTS,
      displayPlans: PRICING_PLANS,
    });
    expect(drift).toEqual([]);
  });

  it('detects a drifted copy (the detector itself works)', () => {
    const drift = collectPricingDrift({
      purchasable: PURCHASABLE_PLANS.map((p) => (p.id === 'starter' ? { ...p, minutesIncluded: 400 } : p)),
      freeMinutes: FREE_MINUTES_INCLUDED,
      trialMinutes: TRIAL_MINUTES,
      fraudFreeMinutes: FREE_MINUTES,
      planPriceCents: { ...PLAN_PRICE_CENTS, starter: 7900 },
      scoreboardMonthlyCents: PLAN_MONTHLY_CENTS,
      displayPlans: PRICING_PLANS,
    });
    expect(drift.length).toBeGreaterThanOrEqual(2);
  });
});
