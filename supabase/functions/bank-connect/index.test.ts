// @vitest-environment node
// pay-card-manage: issue / freeze / limits / sandbox simulate. Manager-only, tenant-scoped, fail-closed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { get, jsonOf, loadHandler, options, type Handler } from '../_shared/testing/edgeHarness.ts';
import { authed, BASE_ENV, captureLogs, ID, seedUser } from '../_shared/testing/edgeKit.ts';
import { ProviderBoundaryError } from '../_shared/pay/types.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));
const m = vi.hoisted(() => ({ issuer: {} as Record<string, any>, authorize: vi.fn() }));
vi.mock('../_shared/pay/registry.ts', () => ({ getCardIssuer: () => m.issuer.current }));
vi.mock('../_shared/pay/cardAuth.ts', () => ({ CARD_COLUMNS: 'id, user_id, status, sandbox', processCardAuthorization: (...a: unknown[]) => m.authorize(...a) }));

const LIMITS = { per_txn_limit_cents: 10000, daily_limit_cents: 20000, monthly_limit_cents: 100000 };
let db: FakeDb; let handler: Handler;
let state: Record<string, unknown>;
const call = (body: unknown, token: string | null = 'tok-owner') => handler(authed(body, token));
const cards = () => db.rows('spend_cards');

beforeEach(async () => {
  db = new FakeDb();
  seedUser(db, 'tok-owner', ID.ownerA);
  seedUser(db, 'tok-admin', ID.admin, { ownerId: ID.ownerA, role: 'admin' });
  seedUser(db, 'tok-tech', ID.tech, { ownerId: ID.ownerA, role: 'technician' });
  db.seed('profiles', [{ id: ID.ownerA, role: 'owner' }]);
  db.seed('team_members', [{ id: 'tm-holder', account_owner_id: ID.ownerA, member_name: 'Hana', member_email: 'h@x.test' }, { id: 'tm-other', account_owner_id: ID.ownerB, member_name: 'Otto' }]);
  state = { available: true, product: 'spend_cards', mode: 'sandbox', reason: null, max_single_cents: 50000 };
  db.rpcHandlers.pay_product_state = () => state;
  db.rpcHandlers.pay_disclosure_accepted = () => 3;
  m.issuer.current = {
    id: 'sandbox', isConfigured: () => true, setCardStatus: vi.fn(async () => {}),
    issueCard: vi.fn(async () => ({ externalCardId: 'ec-new', brand: 'visa', last4: '4242', sandbox: true })),
  };
  m.authorize.mockReset().mockResolvedValue({ decision: { approved: true, receiptRequired: true }, replayed: false, transactionId: 't' });
  sb.create = db.createClient;
  captureLogs();
  handler = await loadHandler(() => import('./index.ts'), { ...BASE_ENV });
});

describe('pay-card-manage: access', () => {
  it('preflight / method / 401 / 403', async () => {
    expect((await handler(options())).status).toBe(200);
    expect((await handler(get())).status).toBe(405);
    expect((await call({ action: 'create' }, null)).status).toBe(401);
    expect((await call({ action: 'create', ...LIMITS, holder_name: 'X' }, 'tok-tech')).status).toBe(403);
    expect(m.issuer.current.issueCard).not.toHaveBeenCalled();
  });
  it('an unavailable product (kill switch / frozen tenant) is a 403 before any provider call', async () => {
    state = { available: false, product: 'spend_cards', mode: 'live', reason: 'killed' };
    const res = await call({ action: 'create', ...LIMITS, holder_name: 'X' });
    expect(res.status).toBe(403);
    expect((await jsonOf(res)).reason).toBe('killed');
    expect(m.issuer.current.issueCard).not.toHaveBeenCalled();
  });
  it('control-plane read failure fails CLOSED', async () => {
    db.failOn({ rpc: 'pay_product_state' });
    expect((await call({ action: 'create', ...LIMITS, holder_name: 'X' })).status).toBe(403);
  });
  it('503 when the issuer is not configured; 400 for an unknown action', async () => {
    m.issuer.current.isConfigured = () => false;
    expect((await call({ action: 'create' })).status).toBe(503);
    m.issuer.current.isConfigured = () => true;
    expect((await call({ action: 'explode' })).status).toBe(400);
  });
});

describe('pay-card-manage: create', () => {
  it('requires the terms disclosure (409) before issuing', async () => {
    db.rpcHandlers.pay_disclosure_accepted = () => null;
    const res = await call({ action: 'create', ...LIMITS, holder_name: 'X' });
    expect(res.status).toBe(409);
    expect((await jsonOf(res)).disclosure_key).toBe('spend_card_terms');
    expect(m.issuer.current.issueCard).not.toHaveBeenCalled();
  });
  it.each([
    [{ ...LIMITS, per_txn_limit_cents: 60000, daily_limit_cents: 70000, monthly_limit_cents: 80000 }, 'per_txn_above_platform_cap'],
    [{ ...LIMITS, daily_limit_cents: 5000 }, 'limits_not_ascending'],
    [{ ...LIMITS, per_txn_limit_cents: -1 }, 'limits_must_be_positive_integers'],
    [{ ...LIMITS, allowed_mcc: ['12a4'] }, 'invalid_mcc'],
  ])('rejects bad limits %#', async (limits, code) => {
    const res = await call({ action: 'create', holder_name: 'X', ...limits });
    expect(res.status).toBe(422);
    expect((await jsonOf(res)).error).toBe(code);
    expect(m.issuer.current.issueCard).not.toHaveBeenCalled();
  });
  it('issues a card owned by the ACCOUNT OWNER, tenant-linked holder, no card number stored', async () => {
    const res = await call({ action: 'create', ...LIMITS, team_member_id: 'tm-holder' }, 'tok-admin');
    expect(res.status).toBe(200);
    expect(cards()[0]).toMatchObject({ user_id: ID.ownerA, team_member_id: 'tm-holder', holder_name: 'Hana', last4: '4242', created_by: ID.admin, sandbox: true });
    expect(Object.keys(cards()[0]).join()).not.toMatch(/pan|cvv|number/i);
  });
  it("a team member of ANOTHER tenant can't be the holder (404) and no card is issued", async () => {
    expect((await call({ action: 'create', ...LIMITS, team_member_id: 'tm-other' })).status).toBe(404);
    expect(m.issuer.current.issueCard).not.toHaveBeenCalled();
  });
  it('422 without a holder name; provider boundary error -> 503', async () => {
    expect((await call({ action: 'create', ...LIMITS })).status).toBe(422);
    m.issuer.current.issueCard.mockRejectedValueOnce(new ProviderBoundaryError('provider_not_configured'));
    expect((await call({ action: 'create', ...LIMITS, holder_name: 'X' })).status).toBe(503);
  });
  it('if our insert fails after the provider issued, the orphan card is frozen', async () => {
    db.failOn({ table: 'spend_cards', op: 'insert' });
    expect((await call({ action: 'create', ...LIMITS, holder_name: 'X' })).status).toBe(500);
    expect(m.issuer.current.setCardStatus).toHaveBeenCalledWith('ec-new', 'frozen');
  });
});

describe('pay-card-manage: existing cards', () => {
  beforeEach(() => db.seed('spend_cards', [
    { id: 'card-a', user_id: ID.ownerA, status: 'active', sandbox: true, external_card_id: 'ec-a' },
    { id: 'card-b', user_id: ID.ownerB, status: 'active', sandbox: true, external_card_id: 'ec-b' },
    { id: 'card-l', user_id: ID.ownerA, status: 'active', sandbox: false, external_card_id: 'ec-l' },
    { id: 'card-c', user_id: ID.ownerA, status: 'canceled', sandbox: true, external_card_id: 'ec-c' },
  ]));
  it("another tenant's card is 404 for every action; nothing changes", async () => {
    for (const action of ['set_status', 'update_limits', 'simulate_purchase']) expect((await call({ action, card_id: 'card-b', status: 'frozen', ...LIMITS })).status).toBe(404);
    expect(m.issuer.current.setCardStatus).not.toHaveBeenCalled();
    expect(cards().find((c) => c.id === 'card-b')!.status).toBe('active');
  });
  it('a live card cannot be touched while the product runs in sandbox mode (409)', async () => {
    expect((await call({ action: 'set_status', card_id: 'card-l', status: 'frozen' })).status).toBe(409);
  });
  it('set_status validates the value, refuses canceled cards, and syncs provider before DB', async () => {
    expect((await call({ action: 'set_status', card_id: 'card-a', status: 'hacked' })).status).toBe(400);
    expect((await call({ action: 'set_status', card_id: 'card-c', status: 'active' })).status).toBe(409);
    expect((await call({ action: 'set_status', card_id: 'card-a', status: 'frozen' })).status).toBe(200);
    expect(m.issuer.current.setCardStatus).toHaveBeenCalledWith('ec-a', 'frozen');
    expect(cards().find((c) => c.id === 'card-a')!.status).toBe('frozen');
  });
  it('a provider failure leaves the local status unchanged', async () => {
    m.issuer.current.setCardStatus.mockRejectedValueOnce(new Error('timeout'));
    expect((await call({ action: 'set_status', card_id: 'card-a', status: 'frozen' })).status).toBe(500);
    expect(cards().find((c) => c.id === 'card-a')!.status).toBe('active');
  });
  it('update_limits re-validates against the platform cap', async () => {
    expect((await call({ action: 'update_limits', card_id: 'card-a', ...LIMITS, per_txn_limit_cents: 99999, daily_limit_cents: 99999, monthly_limit_cents: 99999 })).status).toBe(422);
    expect((await call({ action: 'update_limits', card_id: 'card-a', ...LIMITS })).status).toBe(200);
    expect(cards().find((c) => c.id === 'card-a')!.daily_limit_cents).toBe(20000);
  });
  it('simulate_purchase exists only in sandbox and sanitizes input', async () => {
    const res = await call({ action: 'simulate_purchase', card_id: 'card-a', amount_cents: 1200, merchant_name: 'M'.repeat(500), mcc: 'bad' });
    expect(res.status).toBe(200);
    const input = m.authorize.mock.calls[0][2];
    expect(input.merchantName).toHaveLength(200);
    expect(input.mcc).toBeNull();
    state = { ...state, mode: 'live' };
    m.issuer.current.sandbox = false;
    expect((await call({ action: 'simulate_purchase', card_id: 'card-l', amount_cents: 1 })).status).toBe(400);
  });
});
