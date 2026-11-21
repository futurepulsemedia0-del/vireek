import { describe, expect, it } from 'vitest';
import {
  DEEP_LINK_KEY,
  DEEP_LINK_TTL_MS,
  SELECTABLE_PLAN_IDS,
  buildSignupPath,
  deepLinkFromMetadata,
  deepLinkFromSearch,
  parseBillingParam,
  parsePlanParam,
  readDeepLink,
  resolveInitialSelection,
  safeSource,
  saveDeepLink,
  signupMetadata,
  type StorageLike,
} from './intent';

function memory(): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => void (data[k] = v),
    removeItem: (k) => void delete data[k],
  };
}

describe('plan params', () => {
  it('derives selectable plans from PRICING_PLANS and excludes the legacy free teaser', () => {
    expect(SELECTABLE_PLAN_IDS).toEqual(['starter', 'professional', 'business', 'enterprise']);
  });
  it('accepts only whitelisted values (case/space tolerant) and rejects everything else', () => {
    expect(parsePlanParam(' Professional ')).toBe('professional');
    for (const bad of ['free', 'admin', '../x', '', null, undefined, 3, 'starter;drop']) expect(parsePlanParam(bad)).toBeNull();
    expect(parseBillingParam('ANNUAL')).toBe('annual');
    expect(parseBillingParam('weekly')).toBeNull();
    expect(safeSource('pricing_page')).toBe('pricing_page');
    expect(safeSource('<script>')).toBe('plan_step');
  });
  it('builds /signup links that keep plan and billing, defaulting to monthly (no pre-selected upsell)', () => {
    expect(buildSignupPath('professional', 'annual')).toBe('/signup?plan=professional&billing=annual');
    expect(buildSignupPath('professional', undefined)).toBe('/signup?plan=professional&billing=monthly');
    expect(buildSignupPath('nope', 'annual')).toBe('/signup');
  });
});

describe('redirect preservation (pricing -> signup -> verification)', () => {
  it('captures ?plan=&billing= from the sign-up URL', () => {
    expect(deepLinkFromSearch('?plan=business&billing=annual')).toEqual({ plan: 'business', billing: 'annual', source: 'pricing_page' });
    expect(deepLinkFromSearch('?plan=hacker')).toBeNull();
    expect(deepLinkFromSearch('')).toBeNull();
  });
  it('survives a reload in the same browser and expires after the TTL', () => {
    const s = memory();
    saveDeepLink({ plan: 'starter', billing: 'monthly', source: 'pricing_page' }, s, 1_000);
    expect(readDeepLink(s, 2_000)).toEqual({ plan: 'starter', billing: 'monthly', source: 'pricing_page' });
    expect(readDeepLink(s, 1_000 + DEEP_LINK_TTL_MS + 1)).toBeNull();
    expect(s.data[DEEP_LINK_KEY]).toBeUndefined();
  });
  it('ignores tampered or corrupt storage', () => {
    const s = memory();
    s.data[DEEP_LINK_KEY] = JSON.stringify({ plan: 'free', billing: 'annual', savedAt: Date.now() });
    expect(readDeepLink(s)).toBeNull();
    s.data[DEEP_LINK_KEY] = '{not json';
    expect(readDeepLink(s)).toBeNull();
    expect(readDeepLink(null)).toBeNull();
  });
  it('travels in the account metadata so verification on another device keeps the plan', () => {
    const meta = signupMetadata({ plan: 'professional', billing: 'annual', source: 'pricing_page' });
    expect(meta).toEqual({ signup_plan: 'professional', signup_billing: 'annual', signup_plan_source: 'pricing_page' });
    expect(deepLinkFromMetadata(meta)).toEqual({ plan: 'professional', billing: 'annual', source: 'pricing_page' });
    expect(deepLinkFromMetadata({ signup_plan: 'free' })).toBeNull();
    expect(signupMetadata(null)).toEqual({});
  });
});

describe('resolveInitialSelection precedence', () => {
  const dl = { plan: 'starter', billing: 'annual', source: 'pricing_page' } as const;
  const md = { plan: 'business', billing: 'monthly', source: 'pricing_page' } as const;
  it('url beats server beats browser deep link beats metadata', () => {
    expect(resolveInitialSelection({ urlPlan: 'business', urlBilling: 'annual', server: { plan: 'starter', billing: 'monthly' }, deepLink: dl, metadata: md })).toEqual({ plan: 'business', billing: 'annual', origin: 'url' });
    expect(resolveInitialSelection({ server: { plan: 'starter', billing: 'annual' }, deepLink: dl, metadata: md }).origin).toBe('server');
    expect(resolveInitialSelection({ deepLink: dl, metadata: md }).origin).toBe('deep_link');
    expect(resolveInitialSelection({ metadata: md }).origin).toBe('metadata');
  });
  it('falls back to no plan and monthly billing', () => {
    expect(resolveInitialSelection({})).toEqual({ plan: null, billing: 'monthly', origin: 'none' });
    expect(resolveInitialSelection({ urlBilling: 'annual' })).toEqual({ plan: null, billing: 'annual', origin: 'none' });
  });
  it('never trusts an invalid server value', () => {
    expect(resolveInitialSelection({ server: { plan: 'free', billing: 'x' }, metadata: md }).origin).toBe('metadata');
  });
});
