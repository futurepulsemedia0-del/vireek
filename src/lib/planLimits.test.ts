import { describe, it, expect } from 'vitest';
import { PlanLimitException, parsePlanLimitError, planLimitMessage, featureLabel, PLAN_LIMITS, PLAN_TIERS } from './planLimits';

const e = { code: 'PLAN_LIMIT' as const, key: 'seats', limit: 2, current: 2, upgradeTo: 'professional' as const };

describe('parsePlanLimitError', () => {
  it('reads the PostgREST error raised by the database trigger', () => {
    expect(parsePlanLimitError({ code: 'P0001', message: 'PLAN_LIMIT', details: JSON.stringify(e), hint: 'professional' })).toEqual(e);
  });
  it('reads an edge-function body and a PlanLimitException', () => {
    expect(parsePlanLimitError({ error: e })).toEqual(e);
    expect(parsePlanLimitError(new PlanLimitException(e))).toEqual(e);
  });
  it('ignores unrelated or malformed errors', () => {
    expect(parsePlanLimitError(new Error('boom'))).toBeNull();
    expect(parsePlanLimitError({ message: 'PLAN_LIMIT', details: '{not json' })).toBeNull();
    expect(parsePlanLimitError({ message: 'PLAN_LIMIT', details: JSON.stringify({ code: 'PLAN_LIMIT', key: 'seats' }) })).toBeNull();
    expect(parsePlanLimitError(null)).toBeNull();
    expect(parsePlanLimitError({ error: { error: { error: e } } })).toBeNull();
  });
});

describe('messages', () => {
  it('names the limit and the upgrade', () => {
    expect(planLimitMessage(e)).toBe('Your plan allows 2 team seats. Upgrade to Professional to continue.');
    expect(planLimitMessage({ ...e, limit: 1, upgradeTo: null })).toBe('Your plan allows 1 team seat. Contact us to raise this limit.');
  });
  it('explains a locked feature', () => {
    expect(planLimitMessage({ code: 'PLAN_LIMIT', key: 'advancedAnalytics', limit: 0, current: 0, upgradeTo: 'business' })).toBe('Advanced analytics is not included in your plan. Upgrade to Business to continue.');
    expect(featureLabel('sso')).toBe('Sso');
  });
});

describe('client mirror', () => {
  it('re-exports the shared table unchanged', () => {
    expect(PLAN_TIERS).toHaveLength(5);
    expect(PLAN_LIMITS.business.locations).toBe(3);
  });
});
