import { describe, it, expect } from 'vitest';
import {
  getPlanHref,
  isExternalLink,
  buildEnterpriseMailto,
  parseOverageRate,
  STRIPE_CHECKOUT_LINKS,
  PRICING_PLANS,
  PRICING_ADDONS,
} from './pricing';

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

describe('PRICING_PLANS new price table', () => {
  const byId = (id: string) => PRICING_PLANS.find((p) => p.id === id)!;

  it('keeps the internal ids and order (free is displayed as Trial)', () => {
    expect(PRICING_PLANS.map((p) => p.id)).toEqual(['free', 'starter', 'professional', 'business', 'enterprise']);
    expect(byId('free').name).toBe('Trial');
  });

  it('Trial: $0, 60 min, no overage, card-required trial CTA', () => {
    expect(byId('free')).toMatchObject({
      monthly: 0, annual: 0, minutes: '60 min', overage: null, seats: '1 seat', locations: '1 location',
      ctaLabel: 'Start 14-day trial', ctaHint: 'Card required. Cancel anytime before day 14',
    });
  });

  it('paid plans: monthly, annual (= 10 x monthly), minutes, overage, seats, locations', () => {
    expect(byId('starter')).toMatchObject({ monthly: 99, annual: 990, minutes: '200 min', overage: '$0.25/min after', seats: '2 seats', locations: '1 location' });
    expect(byId('professional')).toMatchObject({ monthly: 249, annual: 2490, minutes: '600 min', overage: '$0.25/min after', seats: '5 seats', locations: '1 location', recommended: true });
    expect(byId('business')).toMatchObject({ monthly: 549, annual: 5490, minutes: '1,500 min', overage: '$0.25/min after', seats: '15 seats', locations: 'Up to 3 locations' });
    for (const id of ['starter', 'professional', 'business']) {
      expect(byId(id).annual).toBe(byId(id).monthly! * 10);
    }
  });

  it('enterprise: custom price from $1,799, 6,000 committed min, $0.20 overage, no "Unlimited" wording', () => {
    const e = byId('enterprise');
    expect(e).toMatchObject({ monthly: null, annual: null, startingAt: 1799, minutes: '6,000 min committed', overage: '$0.20/min after committed minutes' });
    expect(parseOverageRate(e.overage)).toBe(0.2);
    expect(`${e.minutes} ${e.overage} ${e.seats} ${e.locations}`).not.toContain('Unlimited');
    expect(e.seats).toContain('Custom');
    expect(e.locations).toContain('Custom');
  });

  it('no plan still references a plan name that no longer exists', () => {
    const allFeatures = PRICING_PLANS.flatMap((p) => p.features).join('|');
    expect(allFeatures).not.toContain('Everything in Free');
  });

  it('did not touch the live Stripe payment links', () => {
    expect(Object.keys(STRIPE_CHECKOUT_LINKS).sort()).toEqual(['business', 'professional', 'starter']);
    expect(STRIPE_CHECKOUT_LINKS.starter!.monthly).toBe('https://buy.stripe.com/fZu4gyfNI4CFbda3YI5wI01');
  });
});

describe('PRICING_ADDONS (US cents)', () => {
  it('has the agreed add-on prices', () => {
    expect(PRICING_ADDONS).toEqual({
      extraUser: { starter: 2500, professional: 2500, business: 2000 },
      extraLocation: 7900,
      extraPhoneNumber: 500,
      topUp100Minutes: 2900,
      smsOveragePerSegment: 3,
      enterpriseOnboardingFrom: 250000,
      proOnboardingSuggested: 49900,
    });
  });

  it('every amount is a positive integer number of cents', () => {
    const amounts = [
      ...Object.values(PRICING_ADDONS.extraUser),
      PRICING_ADDONS.extraLocation,
      PRICING_ADDONS.extraPhoneNumber,
      PRICING_ADDONS.topUp100Minutes,
      PRICING_ADDONS.smsOveragePerSegment,
      PRICING_ADDONS.enterpriseOnboardingFrom,
      PRICING_ADDONS.proOnboardingSuggested,
    ];
    for (const a of amounts) {
      expect(Number.isInteger(a)).toBe(true);
      expect(a).toBeGreaterThan(0);
    }
  });
});
