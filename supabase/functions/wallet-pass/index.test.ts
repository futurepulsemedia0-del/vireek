// @vitest-environment node
// wallet-pass is a capability-token endpoint (share_token / per-pass ApplePass auth_token), not a session endpoint.
// These negative tests prove one tenant's credential never unlocks another tenant's pass.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { captureErrors, loadHandler, type Handler } from '../_shared/testing/edgeHarness.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));

const w = vi.hoisted(() => ({ loadPayload: vi.fn(), renderApple: vi.fn(), publishGoogle: vi.fn() }));
vi.mock('../_shared/wallet/config.ts', () => ({ readWalletEnv: () => ({ apple: { passTypeIdentifier: 'pass.vireek.test' }, google: null }) }));
vi.mock('../_shared/wallet/service.ts', () => ({
  loadPayload: (...a: unknown[]) => w.loadPayload(...a),
  renderApple: (...a: unknown[]) => w.renderApple(...a),
  publishGoogle: (...a: unknown[]) => w.publishGoogle(...a),
  safeEqual: (a: string, b: string) => a === b,
}));

const PASS_TYPE = 'pass.vireek.test';
const SERIAL_A = 'a'.repeat(32);
const SERIAL_B = 'b'.repeat(32);
const SHARE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHARE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T = '2026-11-01T10:00:00.000Z';

let db: FakeDb;
let h: Handler;
const call = (path: string, init: RequestInit = {}) => h(new Request(`http://edge.test/functions/v1/wallet-pass${path}`, init));
const apple = (token: string) => ({ headers: { Authorization: `ApplePass ${token}`, origin: 'https://evil.com' } });

beforeEach(async () => {
  db = new FakeDb();
  db.seed('wallet_passes', [
    { id: 'pA', serial: SERIAL_A, share_token: SHARE_A, auth_token: 'tokenA', status: 'active', last_changed_at: T },
    { id: 'pB', serial: SERIAL_B, share_token: SHARE_B, auth_token: 'tokenB', status: 'voided', last_changed_at: T },
  ]);
  sb.create = db.createClient;
  w.loadPayload.mockReset().mockResolvedValue({ pass: { kind: 'loyalty' } });
  w.renderApple.mockReset().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]) });
  w.publishGoogle.mockReset();
  captureErrors();
  h = await loadHandler(() => import('./index.ts'), { SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc' });
});

describe('wallet-pass capability boundaries', () => {
  it("pass A's auth token cannot fetch pass B's latest pass (cross-tenant)", async () => {
    const res = await call(`/v1/passes/${PASS_TYPE}/${SERIAL_B}`, apple('tokenA'));
    expect(res.status).toBe(401);
    expect(w.renderApple).not.toHaveBeenCalled();
  });
  it("pass A's token cannot register a device against pass B", async () => {
    const res = await call(`/v1/devices/dev1/registrations/${PASS_TYPE}/${SERIAL_B}`, { method: 'POST', body: JSON.stringify({ pushToken: 'x' }), ...apple('tokenA') });
    expect(res.status).toBe(401);
    expect(db.rows('wallet_registrations')).toHaveLength(0);
  });
  it('the owner of pass A can fetch and register their own pass', async () => {
    expect((await call(`/v1/passes/${PASS_TYPE}/${SERIAL_A}`, apple('tokenA'))).status).toBe(200);
    const reg = await call(`/v1/devices/dev1/registrations/${PASS_TYPE}/${SERIAL_A}`, { method: 'POST', body: JSON.stringify({ pushToken: 'push' }), ...apple('tokenA') });
    expect(reg.status).toBe(201);
    expect(db.rows('wallet_registrations')[0].pass_id).toBe('pA');
  });
  it('missing, malformed or wrong-scheme credentials are rejected', async () => {
    expect((await call(`/v1/passes/${PASS_TYPE}/${SERIAL_A}`)).status).toBe(401);
    expect((await call(`/v1/passes/${PASS_TYPE}/${SERIAL_A}`, { headers: { Authorization: 'Bearer tokenA' } })).status).toBe(401);
    expect((await call(`/v1/passes/${PASS_TYPE}/not-a-serial`, apple('tokenA'))).status).toBe(404);
  });
  it('a wrong passTypeIdentifier is a 404 even with a valid token', async () => {
    expect((await call(`/v1/passes/pass.other/${SERIAL_A}`, apple('tokenA'))).status).toBe(404);
  });
  it('the changed-serials list only contains passes registered for that device', async () => {
    db.seed('wallet_registrations', [{ id: 'r1', pass_id: 'pA', device_library_id: 'dev1' }, { id: 'r2', pass_id: 'pB', device_library_id: 'dev2' }]);
    const res = await call(`/v1/devices/dev1/registrations/${PASS_TYPE}`);
    expect(res.status).toBe(200);
    expect((await res.json()).serialNumbers).toEqual([SERIAL_A]);
    expect((await call(`/v1/devices/unknown-device/registrations/${PASS_TYPE}`)).status).toBe(204);
  });
  it('downloads: unknown / non-UUID tokens are 404 and voided passes are 410', async () => {
    expect((await call('/p/not-a-uuid.pkpass')).status).toBe(404);
    expect((await call('/p/cccccccc-cccc-4ccc-8ccc-cccccccccccc.pkpass')).status).toBe(404);
    expect((await call(`/p/${SHARE_B}.pkpass`)).status).toBe(410);
    expect((await call(`/p/${SHARE_A}.pkpass`)).status).toBe(200);
  });
  it('never emits CORS headers', async () => {
    const res = await call(`/p/${SHARE_A}.pkpass`, { headers: { origin: 'https://evil.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
