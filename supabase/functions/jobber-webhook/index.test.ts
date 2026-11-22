// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
// Receiver-level tests for jobber-webhook: real index.ts, in-memory FakeDb, disconnect helper mocked.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { captureErrors, loadHandler, type Handler } from '../_shared/testing/edgeHarness.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));
const disc = vi.hoisted(() => ({ markPriceBookDisconnected: vi.fn() }));
vi.mock('../_shared/price-book/disconnect.ts', () => ({ markPriceBookDisconnected: (...a: unknown[]) => disc.markPriceBookDisconnected(...a) }));

const SECRET = 'jobber-client-secret';
const RAW = readFileSync(new URL('../_shared/price-book/__fixtures__/jobber-webhook-app-disconnect.json', import.meta.url), 'utf8').trimEnd();
const ACCOUNT = 'Z2lkOi8vSm9iYmVyL0FjY291bnQvOTk5';
const sig = (body = RAW, secret = SECRET) => createHmac('sha256', secret).update(body, 'utf8').digest('base64');
const req = (body: string, headers: Record<string, string> = { 'X-Jobber-Hmac-SHA256': sig(body) }, method = 'POST') =>
  new Request('http://edge.test/jobber-webhook', { method, headers, body: method === 'GET' ? undefined : body });

let db: FakeDb;
let handler: Handler;
async function boot(env: Record<string, string | undefined> = {}) {
  handler = await loadHandler(() => import('./index.ts'), { SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', JOBBER_CLIENT_SECRET: SECRET, ...env });
}

beforeEach(async () => {
  db = new FakeDb();
  db.uniques.jobber_webhook_events = ['event_key'];
  db.seed('price_book_connections', [
    { user_id: 'u1', provider: 'jobber', jobber_account_id: ACCOUNT },
    { user_id: 'u2', provider: 'jobber', jobber_account_id: ACCOUNT }, // same Jobber account connected by two Vireek users
    { user_id: 'u3', provider: 'jobber', jobber_account_id: 'OTHER' },
  ]);
  sb.create = db.createClient;
  disc.markPriceBookDisconnected.mockReset().mockResolvedValue(undefined);
  vi.spyOn(Math, 'random').mockReturnValue(0.9); // skip the 1 % retention sweep
  await boot();
});

describe('jobber-webhook', () => {
  it('405 for non-POST; 503 when the client secret is not configured', async () => {
    expect((await handler(req('', {}, 'GET'))).status).toBe(405);
    await boot({ JOBBER_CLIENT_SECRET: '' });
    expect((await handler(req(RAW))).status).toBe(503);
  });

  it('401 and NO database access for a missing, wrong-secret or tampered signature', async () => {
    for (const r of [req(RAW, {}), req(RAW, { 'X-Jobber-Hmac-SHA256': sig(RAW, 'other') }), req(`${RAW} `, { 'X-Jobber-Hmac-SHA256': sig(RAW) })]) {
      expect((await handler(r)).status).toBe(401);
    }
    expect(db.calls('jobber_webhook_events').length).toBe(0);
    expect(disc.markPriceBookDisconnected).not.toHaveBeenCalled();
  });

  it('413 for an oversized body before any crypto or DB work', async () => {
    const big = 'x'.repeat(65 * 1024);
    expect((await handler(req(big))).status).toBe(413);
    expect(db.calls('jobber_webhook_events').length).toBe(0);
  });

  it('authenticated but unparsable body is acknowledged (200) and ignored', async () => {
    const body = 'a=1&b=2';
    const res = await handler(req(body));
    expect(res.status).toBe(200);
    expect(disc.markPriceBookDisconnected).not.toHaveBeenCalled();
  });

  it('APP_DISCONNECT disconnects EVERY Vireek connection bound to that Jobber account, and only those', async () => {
    const res = await handler(req(RAW));
    expect(res.status).toBe(200);
    const users = disc.markPriceBookDisconnected.mock.calls.map((c) => c[1]).sort();
    expect(users).toEqual(['u1', 'u2']);
    expect(disc.markPriceBookDisconnected.mock.calls.every((c) => c[2] === 'jobber')).toBe(true);
  });

  it('a redelivery of the same event is a no-op (at-least-once delivery)', async () => {
    expect((await handler(req(RAW))).status).toBe(200);
    disc.markPriceBookDisconnected.mockClear();
    const again = await handler(req(RAW));
    expect(again.status).toBe(200);
    expect(await again.text()).toBe('duplicate');
    expect(disc.markPriceBookDisconnected).not.toHaveBeenCalled();
  });

  it('a processing failure returns 500 and releases the de-dupe key so Jobber\'s retry is processed', async () => {
    captureErrors();
    disc.markPriceBookDisconnected.mockRejectedValueOnce(new Error('connection_update_failed'));
    expect((await handler(req(RAW))).status).toBe(500);
    expect(db.rows('jobber_webhook_events')).toHaveLength(0);
    const retry = await handler(req(RAW));
    expect(retry.status).toBe(200);
    expect(disc.markPriceBookDisconnected).toHaveBeenCalledTimes(3); // u1 (failed), then u1 + u2 on the redelivery
  });

  it('other topics are acknowledged without touching any connection', async () => {
    const other = RAW.replace('APP_DISCONNECT', 'CLIENT_CREATE');
    expect((await handler(req(other))).status).toBe(200);
    expect(disc.markPriceBookDisconnected).not.toHaveBeenCalled();
  });
});
