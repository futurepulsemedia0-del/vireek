import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { requireIntegrationManager } from './integrationConnectGuard';

type Tm = { id: string; account_owner_id: string; role: string; permissions: Record<string, unknown> };
type Chain = {
  select: () => Chain;
  eq: () => Chain;
  limit: () => Promise<{ data: Tm[] }>;
  maybeSingle: () => Promise<{ data: { id: string } | null }>;
};

function fakeAdmin(o: { user?: { id: string; email?: string } | null; tm?: Tm[]; profile?: { id: string } | null }) {
  return {
    auth: {
      getUser: async () =>
        o.user ? { data: { user: o.user }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } },
    },
    from(table: string): Chain {
      const chain: Chain = {
        select: () => chain,
        eq: () => chain,
        limit: async () => ({ data: table === 'team_members' ? (o.tm ?? []) : [] }),
        maybeSingle: async () => ({ data: table === 'profiles' ? (o.profile ?? null) : null }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

describe('requireIntegrationManager', () => {
  it('401 on invalid JWT', async () => {
    const r = await requireIntegrationManager(fakeAdmin({ user: null }), 'x');
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('401 when the user has neither a profile nor a team row', async () => {
    const r = await requireIntegrationManager(fakeAdmin({ user: { id: 'u1' } }), 'x');
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('owner is allowed and is its own tenant', async () => {
    const r = await requireIntegrationManager(fakeAdmin({ user: { id: 'o1' }, profile: { id: 'o1' } }), 'x');
    expect(r).toEqual({ ok: true, userId: 'o1', accountOwnerId: 'o1' });
  });

  it('admin member is allowed and resolves to the owner tenant', async () => {
    const tm: Tm = { id: 't1', account_owner_id: 'o1', role: 'admin', permissions: {} };
    const r = await requireIntegrationManager(fakeAdmin({ user: { id: 'a1' }, tm: [tm] }), 'x');
    expect(r).toEqual({ ok: true, userId: 'a1', accountOwnerId: 'o1' });
  });

  it('plain technician is forbidden (403)', async () => {
    const tm: Tm = { id: 't2', account_owner_id: 'o1', role: 'technician', permissions: {} };
    const r = await requireIntegrationManager(fakeAdmin({ user: { id: 'x1' }, tm: [tm] }), 'x');
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it('technician with can_manage_team is allowed', async () => {
    const tm: Tm = { id: 't3', account_owner_id: 'o1', role: 'technician', permissions: { can_manage_team: true } };
    const r = await requireIntegrationManager(fakeAdmin({ user: { id: 'x2' }, tm: [tm] }), 'x');
    expect(r).toMatchObject({ ok: true, accountOwnerId: 'o1' });
  });
});
