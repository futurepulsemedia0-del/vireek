// @vitest-environment node
// bank-connect: Plaid link / exchange / reauth / disconnect. Real index.ts + real _shared/bank/http.ts;
// supabase-js = FakeDb; Plaid, token crypto and the sync engine are stubbed (their own logic is not under test here).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { get, jsonOf, loadHandler, options, type Handler } from '../_shared/testing/edgeHarness.ts';
import { authed, BASE_ENV, captureLogs, ID, seedUser } from '../_shared/testing/edgeKit.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));
const plaid = vi.hoisted(() => ({
  configured: true, linkToken: vi.fn(), exchange: vi.fn(), institution: vi.fn(), remove: vi.fn(), sync: vi.fn(),
}));
vi.mock('../_shared/bank/plaid.ts', () => ({
  plaidConfigured: () => plaid.configured,
  createLinkToken: (...a: unknown[]) => plaid.linkToken(...a),
  exchangePublicToken: (...a: unknown[]) => plaid.exchange(...a),
  getItemInstitution: (...a: unknown[]) => plaid.institution(...a),
  removeItem: (...a: unknown[]) => plaid.remove(...a),
}));
vi.mock('../_shared/bank/crypto.ts', () => ({
  encryptToken: async (t: string) => `enc(${t})`,
  decryptToken: async (t: string) => t.replace(/^enc\((.*)\)$/, '$1'),
}));
vi.mock('../_shared/bank/engine.ts', () => ({ syncConnection: (...a: unknown[]) => plaid.sync(...a) }));

let db: FakeDb;
let handler: Handler;
let logs: ReturnType<typeof captureLogs>;
const call = (body: unknown, token: string | null = 'tok-owner') => handler(authed(body, token));

beforeEach(async () => {
  db = new FakeDb();
  seedUser(db, 'tok-owner', ID.ownerA);
  seedUser(db, 'tok-admin', ID.admin, { ownerId: ID.ownerA, role: 'admin' });
  seedUser(db, 'tok-billing', ID.billing, { ownerId: ID.ownerA, role: 'member', permissions: { can_view_billing: true } });
  seedUser(db, 'tok-tech', ID.tech, { ownerId: ID.ownerA, role: 'technician' });
  sb.create = db.createClient;
  Object.assign(plaid, { configured: true });
  plaid.linkToken.mockReset().mockResolvedValue({ link_token: 'link-sandbox-1' });
  plaid.exchange.mockReset().mockResolvedValue({ access_token: 'access-secret-123', item_id: 'item-1' });
  plaid.institution.mockReset().mockResolvedValue({ id: 'ins_1', name: 'First Bank' });
  plaid.remove.mockReset().mockResolvedValue(undefined);
  plaid.sync.mockReset().mockResolvedValue({ added: 3 });
  logs = captureLogs();
  handler = await loadHandler(() => import('./index.ts'), { ...BASE_ENV });
});
afterEach(() => vi.restoreAllMocks());

describe('bank-connect: transport + auth', () => {
  it('answers CORS preflight and rejects non-POST', async () => {
    expect((await handler(options())).status).toBe(200);
    expect((await handler(get())).status).toBe(405);
  });
  it('401 without a token and with an unknown token, before touching Plaid', async () => {
    expect((await call({ action: 'link_token' }, null)).status).toBe(401);
    expect((await call({ action: 'link_token' }, 'tok-nobody')).status).toBe(401);
    expect(plaid.linkToken).not.toHaveBeenCalled();
  });
  it('403 for a technician and for a member without billing rights; Plaid is never called', async () => {
    expect((await call({ action: 'link_token' }, 'tok-tech')).status).toBe(403);
    expect(plaid.linkToken).not.toHaveBeenCalled();
    expect(db.calls('bank_connections').filter((c) => c.op !== 'select')).toHaveLength(0);
  });
  it('allows owner, admin and a member holding can_view_billing', async () => {
    for (const t of ['tok-owner', 'tok-admin', 'tok-billing']) expect((await call({ action: 'link_token' }, t)).status).toBe(200);
  });
  it('503 when Plaid is not configured', async () => {
    plaid.configured = false;
    const res = await call({ action: 'link_token' });
    expect(res.status).toBe(503);
    expect(plaid.linkToken).not.toHaveBeenCalled();
  });
  it('400 on an unknown action', async () => expect((await call({ action: 'nuke' })).status).toBe(400));
});

describe('bank-connect: link / exchange', () => {
  it('link_token is created for the ACCOUNT OWNER (not the acting admin) with the webhook URL', async () => {
    const res = await call({ action: 'link_token' }, 'tok-admin');
    expect(await jsonOf(res)).toEqual({ link_token: 'link-sandbox-1' });
    expect(plaid.linkToken).toHaveBeenCalledWith(ID.ownerA, 'http://db.test/functions/v1/bank-webhook');
  });
  it('exchange without a public_token is 400', async () => {
    expect((await call({ action: 'exchange' })).status).toBe(400);
    expect(plaid.exchange).not.toHaveBeenCalled();
  });
  it('exchange stores the connection under the owner, keeps the token only encrypted, and syncs once', async () => {
    const res = await call({ action: 'exchange', public_token: 'public-1' }, 'tok-admin');
    const body = await jsonOf(res);
    expect(res.status).toBe(200);
    expect(body.institution_name).toBe('First Bank');
    const [row] = db.rows('bank_connections');
    expect(row).toMatchObject({ user_id: ID.ownerA, provider: 'plaid', provider_item_id: 'item-1', created_by: ID.admin });
    expect(db.rows('bank_connection_secrets')[0]).toMatchObject({ connection_id: row.id, access_token_enc: 'enc(access-secret-123)' });
    expect(JSON.stringify(body)).not.toContain('access-secret-123');
    expect(plaid.sync).toHaveBeenCalledTimes(1);
  });
  it('a failed first sync does not fail the connection, and the log carries no token', async () => {
    plaid.sync.mockRejectedValueOnce(new Error('boom access-secret-123'));
    const res = await call({ action: 'exchange', public_token: 'public-1' });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).summary).toBeNull();
    expect(logs.text()).toContain('bank_first_sync_failed');
  });
  it('409 when the same bank login already belongs to ANOTHER account; nothing is written', async () => {
    db.seed('bank_connections', [{ id: 'c-b', user_id: ID.ownerB, provider: 'plaid', provider_item_id: 'item-1' }]);
    const res = await call({ action: 'exchange', public_token: 'public-1' });
    expect(res.status).toBe(409);
    expect(db.rows('bank_connection_secrets')).toHaveLength(0);
    expect(plaid.sync).not.toHaveBeenCalled();
  });
  it('re-linking the same item for the same owner updates, never duplicates', async () => {
    db.seed('bank_connections', [{ id: 'c-a', user_id: ID.ownerA, provider: 'plaid', provider_item_id: 'item-1', status: 'error' }]);
    expect((await call({ action: 'exchange', public_token: 'public-1' })).status).toBe(200);
    expect(db.rows('bank_connections')).toHaveLength(1);
    expect(db.rows('bank_connections')[0].status).toBe('active');
  });
});

describe('bank-connect: tenant isolation on reauth / disconnect', () => {
  beforeEach(() => {
    db.seed('bank_connections', [
      { id: 'c-a', user_id: ID.ownerA, status: 'active' },
      { id: 'c-b', user_id: ID.ownerB, status: 'active' },
    ]);
    db.seed('bank_connection_secrets', [{ connection_id: 'c-a', access_token_enc: 'enc(tok-a)' }, { connection_id: 'c-b', access_token_enc: 'enc(tok-b)' }]);
  });
  it("reauth_token for another tenant's connection is 404 and never reaches Plaid", async () => {
    expect((await call({ action: 'reauth_token', connection_id: 'c-b' })).status).toBe(404);
    expect(plaid.linkToken).not.toHaveBeenCalled();
  });
  it('reauth_token for an own connection decrypts the stored token for update mode', async () => {
    expect((await call({ action: 'reauth_token', connection_id: 'c-a' })).status).toBe(200);
    expect(plaid.linkToken).toHaveBeenCalledWith(ID.ownerA, expect.any(String), 'tok-a');
  });
  it('reauth_done is scoped by user_id: the other tenant row is untouched', async () => {
    await call({ action: 'reauth_done', connection_id: 'c-b' });
    expect(db.rows('bank_connections').find((r) => r.id === 'c-b')!.status).toBe('active');
    const upd = db.calls('bank_connections', 'update')[0];
    expect(db.has(upd, 'user_id', ID.ownerA)).toBe(true);
  });
  it("disconnect of another tenant's connection is 404: nothing removed or deleted", async () => {
    expect((await call({ action: 'disconnect', connection_id: 'c-b' })).status).toBe(404);
    expect(plaid.remove).not.toHaveBeenCalled();
    expect(db.rows('bank_connection_secrets')).toHaveLength(2);
  });
  it('disconnect revokes upstream, deletes the secret and marks disconnected', async () => {
    const res = await call({ action: 'disconnect', connection_id: 'c-a' });
    expect(res.status).toBe(200);
    expect(plaid.remove).toHaveBeenCalledWith('tok-a');
    expect(db.rows('bank_connection_secrets').map((r) => r.connection_id)).toEqual(['c-b']);
    expect(db.rows('bank_connections').find((r) => r.id === 'c-a')!.status).toBe('disconnected');
  });
  it('disconnect still completes when the provider already revoked the item', async () => {
    plaid.remove.mockRejectedValueOnce(new Error('ITEM_NOT_FOUND'));
    expect((await call({ action: 'disconnect', connection_id: 'c-a' })).status).toBe(200);
    expect(db.rows('bank_connections').find((r) => r.id === 'c-a')!.status).toBe('disconnected');
  });
});

describe('bank-connect: failure handling', () => {
  it('unexpected errors return a generic 500 and never echo internals', async () => {
    plaid.linkToken.mockRejectedValueOnce(new Error('plaid secret sk_live_ABC leaked'));
    const res = await call({ action: 'link_token' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await jsonOf(res))).not.toContain('sk_live_ABC');
    expect(logs.text()).toContain('bank_connect_failed');
  });
  it('a database outage during exchange is a 500, not a half-written connection with a secret', async () => {
    db.failOn({ table: 'bank_connections', op: 'insert' });
    expect((await call({ action: 'exchange', public_token: 'public-1' })).status).toBe(500);
    expect(db.rows('bank_connection_secrets')).toHaveLength(0);
  });
});
