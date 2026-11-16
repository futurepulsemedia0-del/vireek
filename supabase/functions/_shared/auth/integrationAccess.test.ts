import { describe, expect, it } from 'vitest';
import { checkIntegrationAccess, type CallerClient } from './integrationAccess';

const USER = '8f6a3c1e-0000-4000-8000-000000000001';
const OWNER = '8f6a3c1e-0000-4000-8000-000000000002';

function fakeCaller(opts: {
  user?: { id: string } | null;
  userErr?: unknown;
  owner?: unknown;
  ownerErr?: unknown;
  allowed?: unknown;
  permErr?: unknown;
}): CallerClient {
  return {
    auth: { getUser: async () => ({ data: { user: opts.user === undefined ? { id: USER } : opts.user }, error: opts.userErr ?? null }) },
    rpc: async (fn: string) => {
      if (fn === 'get_account_owner_id') return { data: opts.owner === undefined ? OWNER : opts.owner, error: opts.ownerErr ?? null };
      if (fn === 'can_manage_integrations') return { data: opts.allowed === undefined ? true : opts.allowed, error: opts.permErr ?? null };
      return { data: null, error: { message: 'unexpected rpc' } };
    },
  };
}

describe('checkIntegrationAccess', () => {
  it('allows a user with can_manage_integrations and returns the account owner', async () => {
    expect(await checkIntegrationAccess(fakeCaller({}), 'Jobber')).toEqual({ ok: true, userId: USER, ownerId: OWNER });
  });
  it('returns 401 for a missing/invalid session', async () => {
    expect(await checkIntegrationAccess(fakeCaller({ user: null }), 'Jobber')).toMatchObject({ ok: false, status: 401 });
    expect(await checkIntegrationAccess(fakeCaller({ userErr: { message: 'jwt expired' } }), 'Jobber')).toMatchObject({ ok: false, status: 401 });
  });
  it('returns 401 when the account owner cannot be resolved', async () => {
    expect(await checkIntegrationAccess(fakeCaller({ owner: null }), 'HubSpot')).toMatchObject({ ok: false, status: 401 });
  });
  it('returns 403 for a low-privilege team member (permission false)', async () => {
    const r = await checkIntegrationAccess(fakeCaller({ allowed: false }), 'HubSpot');
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect((r as { error: string }).error).toContain('HubSpot');
  });
  it('fails closed: RPC error or non-boolean-true result is 403', async () => {
    expect(await checkIntegrationAccess(fakeCaller({ permErr: { message: 'boom' } }), 'Google Calendar')).toMatchObject({ ok: false, status: 403 });
    expect(await checkIntegrationAccess(fakeCaller({ allowed: 'true' }), 'Google Calendar')).toMatchObject({ ok: false, status: 403 });
    expect(await checkIntegrationAccess(fakeCaller({ allowed: null }), 'Google Calendar')).toMatchObject({ ok: false, status: 403 });
  });
});
