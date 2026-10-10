import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ supabase: { rpc, functions: { invoke } } }));

import {
  fetchPublicMembershipPlan,
  formatPlanPrice,
  intervalNoun,
  isSafeCheckoutUrl,
  isValidPlanSlug,
  monthlyEquivalentLabel,
  normalizePlanSlug,
  startMembershipCheckout,
  validateJoinForm,
  type JoinFormValues,
} from './membershipJoin';

const VALID: JoinFormValues = { name: 'Dana Smith', email: 'dana@example.com', phone: '(555) 123-4567' };
const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_123';

const PLAN = {
  slug: 'annual-maintenance-a1b2',
  business_name: 'Cool Air HVAC',
  name: 'Annual Maintenance',
  price_cents: 29900,
  billing_interval: 'yearly',
  benefits: ['2 tune-ups', ' Priority booking ', '', 7],
  visits_included_per_period: 2,
  service_type: 'HVAC',
  can_purchase: true,
};

describe('slug helpers', () => {
  it('normalizes case and whitespace', () => {
    expect(normalizePlanSlug('  Annual-Plan-1A2B ')).toBe('annual-plan-1a2b');
  });
  it('accepts url-safe slugs and rejects everything else', () => {
    expect(isValidPlanSlug('annual-maintenance-a1b2')).toBe(true);
    expect(isValidPlanSlug('abc')).toBe(true);
    expect(isValidPlanSlug('ab')).toBe(false);
    expect(isValidPlanSlug('Has Spaces')).toBe(false);
    expect(isValidPlanSlug('-leading')).toBe(false);
    expect(isValidPlanSlug('trailing-')).toBe(false);
    expect(isValidPlanSlug('double--dash')).toBe(false);
    expect(isValidPlanSlug('a'.repeat(61))).toBe(false);
    expect(isValidPlanSlug('../etc/passwd')).toBe(false);
  });
});

describe('validateJoinForm', () => {
  it('passes a complete form, with or without a phone', () => {
    expect(validateJoinForm(VALID)).toEqual({});
    expect(validateJoinForm({ ...VALID, phone: '' })).toEqual({});
  });
  it('flags a missing or too-short name', () => {
    expect(validateJoinForm({ ...VALID, name: ' ' }).name).toBeDefined();
    expect(validateJoinForm({ ...VALID, name: 'D' }).name).toBeDefined();
    expect(validateJoinForm({ ...VALID, name: 'x'.repeat(101) }).name).toBeDefined();
  });
  it('flags a missing or malformed email', () => {
    expect(validateJoinForm({ ...VALID, email: '' }).email).toBeDefined();
    expect(validateJoinForm({ ...VALID, email: 'nope' }).email).toBeDefined();
    expect(validateJoinForm({ ...VALID, email: 'a@b' }).email).toBeDefined();
    expect(validateJoinForm({ ...VALID, email: 'two words@x.com' }).email).toBeDefined();
  });
  it('flags an unusable phone but allows common formats', () => {
    expect(validateJoinForm({ ...VALID, phone: '123' }).phone).toBeDefined();
    expect(validateJoinForm({ ...VALID, phone: '1'.repeat(16) }).phone).toBeDefined();
    expect(validateJoinForm({ ...VALID, phone: '+1 555-123-4567' }).phone).toBeUndefined();
  });
});

describe('price formatting', () => {
  it('drops cents for whole dollars and keeps them otherwise', () => {
    expect(formatPlanPrice(4900)).toBe('$49');
    expect(formatPlanPrice(4999)).toBe('$49.99');
    expect(formatPlanPrice(120000)).toBe('$1,200');
  });
  it('names the billing interval', () => {
    expect(intervalNoun('monthly')).toBe('month');
    expect(intervalNoun('yearly')).toBe('year');
  });
  it('shows a monthly equivalent for yearly plans only', () => {
    expect(monthlyEquivalentLabel(29900, 'yearly')).toBe('about $24.92 / month');
    expect(monthlyEquivalentLabel(4900, 'monthly')).toBeNull();
  });
});

describe('isSafeCheckoutUrl', () => {
  it('accepts only https Stripe-hosted pages', () => {
    expect(isSafeCheckoutUrl(CHECKOUT_URL)).toBe(true);
    expect(isSafeCheckoutUrl('http://checkout.stripe.com/c/pay/x')).toBe(false);
    expect(isSafeCheckoutUrl('https://evilstripe.com/pay')).toBe(false);
    expect(isSafeCheckoutUrl('https://stripe.com.evil.com/pay')).toBe(false);
    expect(isSafeCheckoutUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeCheckoutUrl('')).toBe(false);
    expect(isSafeCheckoutUrl(null)).toBe(false);
    expect(isSafeCheckoutUrl(undefined)).toBe(false);
  });
});

describe('fetchPublicMembershipPlan', () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it('does not call the server for an invalid slug', async () => {
    expect(await fetchPublicMembershipPlan('Not A Slug')).toEqual({ state: 'not_found' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns the plan with cleaned benefits', async () => {
    rpc.mockResolvedValue({ data: PLAN, error: null });
    const result = await fetchPublicMembershipPlan('Annual-Maintenance-A1B2');
    expect(rpc).toHaveBeenCalledWith('get_public_membership_plan', { p_slug: 'annual-maintenance-a1b2' });
    expect(result.state).toBe('ok');
    if (result.state === 'ok') expect(result.plan.benefits).toEqual(['2 tune-ups', 'Priority booking']);
  });

  it('returns not_found when the plan is missing or not public', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await fetchPublicMembershipPlan('annual-maintenance-a1b2')).toEqual({ state: 'not_found' });
  });

  it('returns error when the request fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await fetchPublicMembershipPlan('annual-maintenance-a1b2')).toEqual({ state: 'error' });
  });
});

describe('startMembershipCheckout', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('rejects an invalid form without calling the server', async () => {
    expect(await startMembershipCheckout('annual-maintenance-a1b2', { ...VALID, email: 'bad' })).toEqual({ ok: false, reason: 'invalid' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sends trimmed values and returns the checkout url', async () => {
    invoke.mockResolvedValue({ data: { checkout_url: CHECKOUT_URL }, error: null });
    const result = await startMembershipCheckout('Annual-Maintenance-A1B2', { name: ' Dana Smith ', email: ' dana@example.com ', phone: '' });
    expect(result).toEqual({ ok: true, url: CHECKOUT_URL });
    expect(invoke).toHaveBeenCalledWith('membership-join-checkout', {
      body: { plan_slug: 'annual-maintenance-a1b2', customer_name: 'Dana Smith', customer_email: 'dana@example.com', customer_phone: undefined, website: '' },
    });
  });

  it('refuses a non-Stripe or missing checkout url', async () => {
    invoke.mockResolvedValue({ data: { checkout_url: 'https://evil.example.com/pay' }, error: null });
    expect(await startMembershipCheckout('annual-maintenance-a1b2', VALID)).toEqual({ ok: false, reason: 'error' });
    invoke.mockResolvedValue({ data: {}, error: null });
    expect(await startMembershipCheckout('annual-maintenance-a1b2', VALID)).toEqual({ ok: false, reason: 'error' });
  });

  it('maps known server reasons from a non-2xx reply', async () => {
    invoke.mockResolvedValue({ data: null, error: { context: { json: async () => ({ reason: 'already_member' }) } } });
    expect(await startMembershipCheckout('annual-maintenance-a1b2', VALID)).toEqual({ ok: false, reason: 'already_member' });
    invoke.mockResolvedValue({ data: null, error: { context: { json: async () => ({ reason: 'rate_limited' }) } } });
    expect(await startMembershipCheckout('annual-maintenance-a1b2', VALID)).toEqual({ ok: false, reason: 'rate_limited' });
  });

  it('falls back to a generic error for unknown reasons or unreadable bodies', async () => {
    invoke.mockResolvedValue({ data: null, error: { context: { json: async () => ({ reason: 'weird' }) } } });
    expect(await startMembershipCheckout('annual-maintenance-a1b2', VALID)).toEqual({ ok: false, reason: 'error' });
    invoke.mockResolvedValue({ data: null, error: new Error('network') });
    expect(await startMembershipCheckout('annual-maintenance-a1b2', VALID)).toEqual({ ok: false, reason: 'error' });
  });
});
