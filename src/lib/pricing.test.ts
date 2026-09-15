import { describe, it, expect } from 'vitest';
import { getPlanHref, isExternalLink, buildEnterpriseMailto, STRIPE_CHECKOUT_LINKS, PRICING_PLANS } from './pricing';

describe('getPlanHref', () => {
  it('sends the free plan to login, not Stripe', () => {
    expect(getPlanHref('free', 'monthly')).toBe('/login');
  });

  it('sends enterprise to the contact page', () => {
    expect(getPlanHref('enterprise', 'annual')).toBe('/enterprise');
  });

  it('returns the correct Stripe Payment Link for a paid plan + cycle', () => {
    expect(getPlanHref('professional', 'monthly')).toBe(STRIPE_CHECKOUT_LINKS.professional!.monthly);
    expect(getPlanHref('professional', 'annual')).toBe(STRIPE_CHECKOUT_LINKS.professional!.annual);
  });
});

describe('isExternalLink', () => {
  it('free and enterprise are in-app links', () => {
    expect(isExternalLink('free')).toBe(false);
    expect(isExternalLink('enterprise')).toBe(false);
  });

  it('paid plans link out to Stripe', () => {
    expect(isExternalLink('starter')).toBe(true);
    expect(isExternalLink('business')).toBe(true);
  });
});

describe('buildEnterpriseMailto', () => {
  it('produces a mailto: link with an encoded subject', () => {
    const href = buildEnterpriseMailto();
    expect(href).toMatch(/^mailto:/);
    expect(href).toContain('subject=Enterprise%20plan%20inquiry');
  });
});

describe('PRICING_PLANS data integrity', () => {
  it('every non-enterprise plan has numeric monthly/annual prices', () => {
    for (const plan of PRICING_PLANS) {
      if (plan.id === 'enterprise') continue;
      expect(typeof plan.monthly).toBe('number');
      expect(typeof plan.annual).toBe('number');
    }
  });

  it('exactly one plan is marked recommended', () => {
    expect(PRICING_PLANS.filter((p) => p.recommended).length).toBe(1);
  });
});
