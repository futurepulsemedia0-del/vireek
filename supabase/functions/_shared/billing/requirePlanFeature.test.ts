import { describe, it, expect } from 'vitest';
import { requirePlanFeature } from './requirePlanFeature';

function client(map: Record<string, { data: unknown; error: { message: string } | null }>) {
  return { rpc: (fn: string) => Promise.resolve(map[fn] ?? { data: null, error: { message: 'missing' } }) };
}

describe('requirePlanFeature', () => {
  it('returns null when the feature is allowed', async () => {
    const c = client({ plan_feature_allowed: { data: true, error: null }, plan_effective_tier: { data: 'business', error: null } });
    expect(await requirePlanFeature(c, 'owner', 'accountingSync')).toBeNull();
  });
  it('402 with the typed error when denied', async () => {
    const c = client({ plan_feature_allowed: { data: false, error: null }, plan_effective_tier: { data: 'starter', error: null } });
    const res = await requirePlanFeature(c, 'owner', 'accountingSync', { 'X-Test': '1' });
    expect(res?.status).toBe(402);
    expect(res?.headers.get('X-Test')).toBe('1');
    expect(await res?.json()).toEqual({ error: { code: 'PLAN_LIMIT', key: 'accountingSync', limit: 0, current: 0, upgradeTo: 'business' } });
  });
  it('fails closed (503) when the check errors, returns a non-boolean, or throws', async () => {
    expect((await requirePlanFeature(client({ plan_feature_allowed: { data: null, error: { message: 'x' } } }), 'o', 'sso'))?.status).toBe(503);
    expect((await requirePlanFeature(client({ plan_feature_allowed: { data: 'yes', error: null } }), 'o', 'sso'))?.status).toBe(503);
    const boom = { rpc: () => { throw new Error('net'); } };
    expect((await requirePlanFeature(boom as never, 'o', 'sso'))?.status).toBe(503);
  });
});
