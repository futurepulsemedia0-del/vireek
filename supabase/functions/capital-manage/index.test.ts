// @vitest-environment node
// pay-webhook: provider webhooks (payouts / cards). Authenticity = adapter signature, never a JWT, and it must fail CLOSED.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { get, jsonOf, loadHandler, options, type Handler } from '../_shared/testing/edgeHarness.ts';
import { BASE_ENV, captureLogs } from '../_shared/testing/edgeKit.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));
const reg = vi.hoisted(() => ({ payout: {} as Record<string, any>, issuer: {} as Record<string, any>, authorize: vi.fn() }));
vi.mock('../_shared/pay/registry.ts', () => ({ getPayoutProvider: (m: string) => reg.payout[m], getCardIssuer: (m: string) => reg.issuer[m] }));
vi.mock('../_shared/pay/cardAuth.ts', () => ({ CARD_COLUMNS: 'id, user_id, sandbox', processCardAuthorization: (...a: unknown[]) => reg.authorize(...a) }));

const adapter = (id: string, goodSig: string | null, extra: Record<string, unknown> = {}) => ({
  id, isConfigured: () => goodSig !== null,
  verifyWebhookSignature: async (_p: string, h: Headers) => goodSig !== null && h.get('x-sig') === goodSig,
  parseWebhookEvent: (p: string) => { try { const j = JSON.parse(p); return j.ext ? { externalId: j.ext, status: j.status, failureCode: j.fail } : null; } catch { return null; } },
  parseAuthorizationEvent: (p: string) => { const j = JSON.parse(p); return j.card ? { externalCardId: j.card, externalAuthId: 'auth1', amountCents: j.amt ?? 500, currency: 'usd', merchantName: 'Shop', mcc: '5411' } : null; },
  ...extra,
});

let db: FakeDb;
let handler: Handler;
let logs: ReturnType<typeof captureLogs>;
const hook = (kind: string | null, body: unknown, sig = 'live-sig') =>
  handler(new Request(`http://edge.test/fn${kind ? `?kind=${kind}` : ''}`, { method: 'POST', headers: { 'x-sig': sig }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
const finalize = () => db.rpcCalls('pay_finalize_transfer');

beforeEach(async () => {
  db = new FakeDb();
  sb.create = db.createClient;
  reg.payout = { live: adapter('acme', 'live-sig'), sandbox: adapter('sandbox', 'sbx-sig') };
  reg.issuer = { live: adapter('acme', 'live-sig'), sandbox: adapter('sandbox', 'sbx-sig') };
  reg.authorize.mockReset().mockResolvedValue({ decision: { approved: true }, replayed: false, transactionId: 't1' });
  db.rpcHandlers.pay_finalize_transfer = () => ({ status: 'paid' });
  db.rpcHandlers.pay_product_state = () => ({ available: true, max_single_cents: 50000 });
  logs = captureLogs();
  handler = await loadHandler(() => import('./index.ts'), { ...BASE_ENV });
});

describe('pay-webhook: transport', () => {
  it('CORS preflight 200, non-POST 405, oversize payload 413', async () => {
    expect((await handler(options())).status).toBe(200);
    expect((await handler(get())).status).toBe(405);
    expect((await hook('payouts', 'x'.repeat(256_001))).status).toBe(413);
  });
  it('unknown / capital kind fails closed with 400', async () => {
    expect((await hook(null, {})).status).toBe(400);
    expect((await hook('capital', {})).status).toBe(400);
  });
});

describe('pay-webhook: payouts', () => {
  beforeEach(() => db.seed('pay_transfers', [{ id: 't-live', provider: 'acme', external_id: 'ext-1', sandbox: false }, { id: 't-sbx', provider: 'sandbox', external_id: 'ext-2', sandbox: true }]));
  it('bad signature -> 400 and no state change', async () => {
    expect((await hook('payouts', { ext: 'ext-1', status: 'paid' }, 'forged')).status).toBe(400);
    expect(finalize()).toHaveLength(0);
  });
  it('no configured adapter -> 400 (fail closed)', async () => {
    reg.payout = { live: adapter('acme', null), sandbox: adapter('sandbox', null) };
    expect((await hook('payouts', { ext: 'ext-1', status: 'paid' })).status).toBe(400);
    expect(finalize()).toHaveLength(0);
  });
  it('valid live signature finalizes exactly the matching transfer', async () => {
    const res = await hook('payouts', { ext: 'ext-1', status: 'failed', fail: 'R01' });
    expect(res.status).toBe(200);
    expect(finalize()).toHaveLength(1);
    expect(finalize()[0].payload).toMatchObject({ p_transfer_id: 't-live', p_status: 'failed', p_external_id: 'ext-1', p_failure_code: 'R01' });
  });
  it('a sandbox-signed event routes to the sandbox transfer', async () => {
    expect((await hook('payouts', { ext: 'ext-2', status: 'paid' }, 'sbx-sig')).status).toBe(200);
    expect(finalize()[0].payload.p_transfer_id).toBe('t-sbx');
  });
  it('mode mismatch (live-signed event for a sandbox transfer) -> 400, nothing finalized', async () => {
    db.seed('pay_transfers', [{ id: 't-x', provider: 'acme', external_id: 'ext-3', sandbox: true }]);
    expect((await hook('payouts', { ext: 'ext-3', status: 'paid' })).status).toBe(400);
    expect(finalize()).toHaveLength(0);
  });
  it('unknown external id is acked (200) with no retry storm; unparseable payload is 400', async () => {
    expect((await hook('payouts', { ext: 'nope', status: 'paid' })).status).toBe(200);
    expect(finalize()).toHaveLength(0);
    expect((await hook('payouts', '{"not":"an event"}')).status).toBe(400);
  });
  it('an invalid_transition result is still acked so the provider stops retrying', async () => {
    db.rpcHandlers.pay_finalize_transfer = () => ({ status: 'invalid_transition' });
    expect((await hook('payouts', { ext: 'ext-1', status: 'paid' })).status).toBe(200);
  });
  it('a database failure is 500 (provider retries) and the log does not contain the payload', async () => {
    db.failOn({ rpc: 'pay_finalize_transfer', mode: 'throw', error: { message: 'db down' } });
    expect((await hook('payouts', { ext: 'ext-1', status: 'paid', iban: 'DE89370400440532013000' })).status).toBe(500);
    expect(logs.text()).toContain('pay_webhook_failed');
    expect(logs.text()).not.toContain('DE89370400440532013000');
  });
});

describe('pay-webhook: card authorizations', () => {
  beforeEach(() => db.seed('spend_cards', [{ id: 'card-1', user_id: 'owner-a', provider: 'acme', external_card_id: 'ec-1', sandbox: false }]));
  it('bad signature -> 400, never reaches the policy engine', async () => {
    expect((await hook('cards', { card: 'ec-1' }, 'forged')).status).toBe(400);
    expect(reg.authorize).not.toHaveBeenCalled();
  });
  it('unknown card and sandbox/live mismatch decline with card_not_active', async () => {
    expect(await jsonOf(await hook('cards', { card: 'ec-404' }))).toEqual({ approved: false, decline_code: 'card_not_active' });
    db.seed('spend_cards', [{ id: 'card-2', user_id: 'owner-a', provider: 'acme', external_card_id: 'ec-2', sandbox: true }]);
    expect((await jsonOf(await hook('cards', { card: 'ec-2' }))).approved).toBe(false);
    expect(reg.authorize).not.toHaveBeenCalled();
  });
  it('the platform kill switch declines everything without evaluating the card', async () => {
    db.rpcHandlers.pay_product_state = () => ({ available: false });
    expect(await jsonOf(await hook('cards', { card: 'ec-1' }))).toEqual({ approved: false, decline_code: 'card_not_active' });
    expect(reg.authorize).not.toHaveBeenCalled();
  });
  it('approval and decline pass through the engine decision with the platform cap', async () => {
    expect(await jsonOf(await hook('cards', { card: 'ec-1' }))).toEqual({ approved: true });
    expect(reg.authorize.mock.calls[0][3]).toBe(50000);
    reg.authorize.mockResolvedValueOnce({ decision: { approved: false, declineCode: 'over_limit' }, replayed: false, transactionId: null });
    expect(await jsonOf(await hook('cards', { card: 'ec-1', amt: 999999 }))).toEqual({ approved: false, decline_code: 'over_limit' });
  });
});
