// @vitest-environment node
// api-v1: the public, key-authenticated read API. Real index.ts + real contract.ts + real readLog.ts; supabase-js = FakeDb.
// (contract.test.ts already pins the OpenAPI spec; here we test the HANDLER: auth, scope, IP allowlist, tenant scoping, limits, audit.)
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { jsonOf, loadHandler, options, type Handler } from '../_shared/testing/edgeHarness.ts';
import { BASE_ENV, captureLogs, ID, sha256Hex } from '../_shared/testing/edgeKit.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));

const KEY = 'vrk_live_good_key_0123456789';
const TEST_KEY = 'vrk_test_sandbox_key_0123456789';
const CALL_A = '11111111-1111-4111-8111-111111111111';
const CALL_B = '22222222-2222-4222-8222-222222222222';
let db: FakeDb; let handler: Handler;
const api = (path: string, headers: Record<string, string> = { Authorization: `Bearer ${KEY}` }, method = 'GET') =>
  handler(new Request(`http://edge.test/api-v1${path}`, { method, headers }));
const keyRow = (o: Record<string, unknown> = {}) => ({ id: 'key-1', user_id: ID.ownerA, scopes: ['calls:read', 'jobs:read'], revoked_at: null, mode: 'live', ip_allowlist: [], rate_limit_per_minute: null, ...o });

beforeEach(async () => {
  db = new FakeDb();
  db.seed('api_keys', [
    { ...keyRow(), key_hash: await sha256Hex(KEY) },
    { ...keyRow({ id: 'key-test', mode: 'test' }), key_hash: await sha256Hex(TEST_KEY) },
    { ...keyRow({ id: 'key-revoked', revoked_at: '2026-01-01T00:00:00Z' }), key_hash: await sha256Hex('vrk_live_revoked') },
    { ...keyRow({ id: 'key-ip', ip_allowlist: ['203.0.113.0/24'] }), key_hash: await sha256Hex('vrk_live_ip') },
    { ...keyRow({ id: 'key-noscope', scopes: ['jobs:read'] }), key_hash: await sha256Hex('vrk_live_noscope') },
  ]);
  db.seed('calls', [
    { id: CALL_A, user_id: ID.ownerA, created_at: '2026-11-10T10:00:00Z', caller_phone: '+14155550100', summary: 'A1' },
    { id: '33333333-3333-4333-8333-333333333333', user_id: ID.ownerA, created_at: '2026-11-11T10:00:00Z', caller_phone: '+14155550101', summary: 'A2' },
    { id: CALL_B, user_id: ID.ownerB, created_at: '2026-11-12T10:00:00Z', caller_phone: '+14155550999', summary: 'B1 secret' },
  ]);
  sb.create = db.createClient;
  captureLogs();
  handler = await loadHandler(() => import('./index.ts'), { ...BASE_ENV });
});

describe('api-v1: transport + authentication', () => {
  it('preflight is 200; non-GET is 405 with Allow and a catalog error body', async () => {
    expect((await handler(options())).status).toBe(200);
    const res = await api('/calls', { Authorization: `Bearer ${KEY}` }, 'POST');
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, OPTIONS');
    expect((await jsonOf(res)).code).toBe('method_not_allowed');
  });
  it('missing key, non-Bearer scheme, unknown key and revoked key are all 401 and never read data', async () => {
    for (const h of [{}, { Authorization: `Basic ${KEY}` }, { Authorization: 'Bearer vrk_live_unknown' }, { Authorization: 'Bearer vrk_live_revoked' }]) {
      const res = await api('/calls', h);
      expect(res.status).toBe(401);
      expect(['missing_api_key', 'invalid_api_key']).toContain((await jsonOf(res)).code);
    }
    expect(db.calls('calls')).toHaveLength(0);
  });
  it('every response carries X-Request-Id and the API version; the rate-limit header only after authentication', async () => {
    const anon = await api('/calls', {});
    expect(anon.headers.get('X-Request-Id')).toBeTruthy();
    expect(anon.headers.get('X-RateLimit-Limit')).toBeNull();
    const ok = await api('/calls');
    expect(ok.headers.get('X-RateLimit-Limit')).toBeTruthy();
    expect(ok.headers.get('X-Vireek-Mode')).toBe('live');
  });
  it('500 server_not_configured when the service key is missing', async () => {
    handler = await loadHandler(() => import('./index.ts'), { SUPABASE_URL: 'http://db.test' });
    expect((await jsonOf(await api('/calls'))).code).toBe('server_not_configured');
  });
  it('unknown routes are 404 route_not_found; a key without the scope is 403', async () => {
    expect((await jsonOf(await api('/secrets'))).code).toBe('route_not_found');
    const res = await api('/calls', { Authorization: 'Bearer vrk_live_noscope' });
    expect(res.status).toBe(403);
    expect((await jsonOf(res)).code).toBe('insufficient_scope');
  });
  it('IP allowlist: outside address and unknown address are denied, an allowed address passes', async () => {
    const withIp = (ip?: string) => ({ Authorization: 'Bearer vrk_live_ip', ...(ip ? { 'cf-connecting-ip': ip } : {}) });
    expect((await jsonOf(await api('/calls', withIp('198.51.100.7')))).code).toBe('ip_not_allowed');
    expect((await jsonOf(await api('/calls', withIp()))).code).toBe('ip_not_allowed');
    expect((await api('/calls', withIp('203.0.113.9'))).status).toBe(200);
  });
});

describe('api-v1: tenant isolation + data access', () => {
  it('a list returns ONLY the key owner rows, newest first, and scopes the query by user_id', async () => {
    const body = await jsonOf(await api('/calls'));
    expect(body.data.map((r: { summary: string }) => r.summary)).toEqual(['A2', 'A1']);
    expect(JSON.stringify(body)).not.toContain('B1 secret');
    const q = db.calls('calls', 'select')[0];
    expect(db.has(q, 'user_id', ID.ownerA)).toBe(true);
  });
  it("another tenant's record id is 404 record_not_found; a malformed id is 400 invalid_id", async () => {
    expect((await jsonOf(await api(`/calls/${CALL_B}`))).code).toBe('record_not_found');
    expect((await api('/calls/not-a-uuid')).status).toBe(400);
    expect((await jsonOf(await api(`/calls/${CALL_A}`))).data.id).toBe(CALL_A);
  });
  it('pagination: limit is clamped, has_more / next_before are consistent, bad before is 400', async () => {
    const page = await jsonOf(await api('/calls?limit=1'));
    expect(page.data).toHaveLength(1);
    expect(page.has_more).toBe(true);
    expect(page.next_before).toBe(page.data[0].created_at);
    const next = await jsonOf(await api(`/calls?limit=1&before=${encodeURIComponent(page.next_before)}`));
    expect(next.data[0].summary).toBe('A1');
    expect((await api('/calls?before=yesterday')).status).toBe(400);
  });
  it('test-mode keys get synthetic data and never touch the real table', async () => {
    const res = await api('/calls', { Authorization: `Bearer ${TEST_KEY}` });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Vireek-Mode')).toBe('test');
    expect(db.calls('calls')).toHaveLength(0);
  });
});

describe('api-v1: limits, audit and failure handling', () => {
  it('429 with Retry-After when the per-key limiter says no; a limiter outage fails OPEN', async () => {
    db.rpcHandlers.api_v1_rate_limit_ok = () => false;
    const res = await api('/calls');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    db.rpcHandlers.api_v1_rate_limit_ok = () => ({ error: { message: 'down' } });
    expect((await api('/calls')).status).toBe(200);
  });
  it('every sensitive read is logged; if the read log is unavailable NO data is returned (fail closed)', async () => {
    await api('/calls');
    expect(db.rpcCalls('log_sensitive_read')).toHaveLength(1);
    db.failOn({ rpc: 'log_sensitive_read' });
    const res = await api('/calls');
    const body = await jsonOf(res);
    expect(body.code).toBe('query_failed');
    expect(body.data).toBeUndefined();
  });
  it('a query failure and an unexpected exception are generic errors', async () => {
    db.failOn({ table: 'calls', error: { message: 'relation "calls" is corrupt' }, times: 1 });
    const res = await api('/calls');
    expect(JSON.stringify(await jsonOf(res))).not.toContain('corrupt');
    expect(res.status).toBe(500);
    db.failOn({ table: 'calls', mode: 'throw', error: { message: 'kaboom stack' } });
    const boom = await api('/calls');
    expect((await jsonOf(boom)).code).toBe('internal_error');
  });
  it('request logs record status and path but never the raw key', async () => {
    await api('/calls');
    await vi.waitFor(() => expect(db.rows('api_request_logs')).toHaveLength(1));
    const row = db.rows('api_request_logs')[0];
    expect(row).toMatchObject({ api_key_id: 'key-1', user_id: ID.ownerA, status: 200, resource: 'calls' });
    expect(JSON.stringify(db.rows('api_request_logs'))).not.toContain(KEY);
  });
});
