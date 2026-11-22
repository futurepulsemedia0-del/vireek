// @vitest-environment node
// admin-sso: owner-only SAML SSO registration through the Supabase Management API.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { get, jsonOf, loadHandler, options, type Handler } from '../_shared/testing/edgeHarness.ts';
import { authed, BASE_ENV, captureLogs, ID, seedUser } from '../_shared/testing/edgeKit.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));

let db: FakeDb; let handler: Handler; let env: Record<string, string | undefined>; let fetchMock: ReturnType<typeof vi.fn>;
const call = (body: unknown, token: string | null = 'tok-owner') => handler(authed(body, token));

beforeEach(async () => {
  db = new FakeDb();
  seedUser(db, 'tok-owner', ID.ownerA);
  seedUser(db, 'tok-admin', ID.admin);
  seedUser(db, 'tok-tech', ID.tech);
  db.seed('profiles', [{ id: ID.ownerA, role: 'owner' }, { id: ID.admin, role: 'admin' }, { id: ID.tech, role: 'technician' }]);
  sb.create = db.createClient;
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'prov-1' }), { status: 201 }));
  vi.stubGlobal('fetch', fetchMock);
  captureLogs();
  env = { ...BASE_ENV, VIREK_MANAGEMENT_TOKEN: 'mgmt-secret', VIREK_PROJECT_REF: 'projref' };
  handler = await loadHandler(() => import('./index.ts'), env);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('admin-sso: access control', () => {
  it('preflight / method / 401', async () => {
    expect((await handler(options())).status).toBe(200);
    expect((await handler(get())).status).toBe(405);
    expect((await call({ action: 'register' }, null)).status).toBe(401);
    expect((await call({ action: 'register' }, 'tok-nobody')).status).toBe(401);
  });
  it('only role=owner passes: admin and technician get 403 and the Management API is never called', async () => {
    for (const t of ['tok-admin', 'tok-tech']) expect((await call({ action: 'register', domain: 'a.com', metadataUrl: 'https://idp.test/m' }, t)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.rows('sso_domains')).toHaveLength(0);
  });
  it('501 when the server has no management token / project ref', async () => {
    env.VIREK_MANAGEMENT_TOKEN = undefined;
    expect((await call({ action: 'register', domain: 'a.com', metadataUrl: 'https://idp.test/m' })).status).toBe(501);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('admin-sso: register / remove', () => {
  it('register validates input, calls the Management API with the server token and stores the domain for THIS owner', async () => {
    expect((await call({ action: 'register', domain: 'a.com' })).status).toBe(400);
    const res = await call({ action: 'register', domain: 'acme.com', metadataUrl: 'https://idp.test/m' });
    expect(await jsonOf(res)).toEqual({ success: true, providerId: 'prov-1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.supabase.com/v1/projects/projref/config/auth/sso/providers');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer mgmt-secret');
    expect(JSON.parse(init.body as string)).toEqual({ type: 'saml', metadata_url: 'https://idp.test/m', domains: ['acme.com'] });
    expect(db.rows('sso_domains')[0]).toMatchObject({ user_id: ID.ownerA, domain: 'acme.com', sso_provider_id: 'prov-1', status: 'active' });
    expect(db.rpcCalls('log_audit_event')[0].payload).toMatchObject({ p_user_id: ID.ownerA, p_action: 'sso_domain_registered', p_target_id: 'acme.com' });
  });
  it('an upstream failure is 502 and nothing is stored or audited', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'domain taken' }), { status: 409 }));
    const res = await call({ action: 'register', domain: 'acme.com', metadataUrl: 'https://idp.test/m' });
    expect(res.status).toBe(502);
    expect(db.rows('sso_domains')).toHaveLength(0);
    expect(db.rpcCalls('log_audit_event')).toHaveLength(0);
  });
  it('remove only deletes the CALLER\'s domain row and its provider; another owner\'s domain is untouched', async () => {
    db.seed('sso_domains', [{ id: 'd1', user_id: ID.ownerA, domain: 'acme.com', sso_provider_id: 'prov-1' }, { id: 'd2', user_id: ID.ownerB, domain: 'acme.com', sso_provider_id: 'prov-B' }]);
    expect((await call({ action: 'remove' })).status).toBe(400);
    expect((await call({ action: 'remove', domain: 'acme.com' })).status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toContain('/providers/prov-1');
    expect(db.rows('sso_domains').map((d) => d.id)).toEqual(['d2']);
    expect(db.rpcCalls('log_audit_event')[0].payload.p_action).toBe('sso_domain_removed');
  });
  it('unknown action is 400', async () => expect((await call({ action: 'wipe' })).status).toBe(400));
});
