// @vitest-environment node
// enforce-payment-suspension is server-to-server: fail-closed secret auth, no CORS, no sweep without auth.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadHandler, type Handler } from '../_shared/testing/edgeHarness.ts';

vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: () => ({}) }));
const sweep = vi.hoisted(() => ({ run: vi.fn(), notify: vi.fn() }));
vi.mock('../_shared/billing/suspensionSweep.ts', () => ({ runSuspensionSweep: (...a: unknown[]) => sweep.run(...a) }));
vi.mock('../_shared/billing/notices/dispatch.ts', () => ({ notifyPaymentSuspended: (...a: unknown[]) => sweep.notify(...a) }));

const call = (headers: Record<string, string> = {}, method = 'POST') =>
  new Request('http://edge.test/fn', { method, headers });

let handler: Handler;
async function boot(env: Record<string, string | undefined>) {
  handler = await loadHandler(() => import('./index.ts'), { SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc-key', ...env });
}

beforeEach(() => {
  sweep.run.mockReset().mockResolvedValue({ suspendedCount: 1, suspendedIds: ['acct-1'] });
  sweep.notify.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('enforce-payment-suspension auth', () => {
  it('rejects with 401 and never sweeps when no credential is sent', async () => {
    await boot({ CRON_SECRET: 'cron-secret' });
    expect((await handler(call())).status).toBe(401);
    expect(sweep.run).not.toHaveBeenCalled();
  });
  it('rejects the public anon key used as Bearer (gateway JWT alone is not enough)', async () => {
    await boot({ CRON_SECRET: 'cron-secret' });
    expect((await handler(call({ Authorization: 'Bearer anon-public-key' }))).status).toBe(401);
    expect(sweep.run).not.toHaveBeenCalled();
  });
  it('rejects a wrong x-cron-secret', async () => {
    await boot({ CRON_SECRET: 'cron-secret' });
    expect((await handler(call({ 'x-cron-secret': 'nope' }))).status).toBe(401);
    expect(sweep.run).not.toHaveBeenCalled();
  });
  it('still authenticates via service-role Bearer when CRON_SECRET is unset (pg_net schedule keeps working)', async () => {
    await boot({});
    expect((await handler(call({ Authorization: 'Bearer svc-key' }))).status).toBe(200);
    expect(sweep.run).toHaveBeenCalledTimes(1);
  });
  it('accepts x-cron-secret and returns the sweep result, notifying each suspended account', async () => {
    await boot({ CRON_SECRET: 'cron-secret' });
    const res = await handler(call({ 'x-cron-secret': 'cron-secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suspended_count: 1, suspended_ids: ['acct-1'] });
    expect(sweep.notify).toHaveBeenCalledWith(expect.anything(), 'acct-1');
  });
  it('does not leak internal error text on failure', async () => {
    await boot({ CRON_SECRET: 'cron-secret' });
    sweep.run.mockRejectedValue(new Error('relation "secret_table" does not exist'));
    const res = await handler(call({ 'x-cron-secret': 'cron-secret' }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret_table');
  });
  it('sends no CORS headers and answers a browser preflight with 405', async () => {
    await boot({ CRON_SECRET: 'cron-secret' });
    const pre = await handler(new Request('http://edge.test/fn', { method: 'OPTIONS', headers: { origin: 'https://evil.com' } }));
    expect(pre.status).toBe(405);
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    const ok = await handler(call({ 'x-cron-secret': 'cron-secret', origin: 'https://vireek.com' }));
    expect(ok.headers.get('access-control-allow-origin')).toBeNull();
  });
});
