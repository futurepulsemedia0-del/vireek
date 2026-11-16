// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
// eraseTrustPackData wipes the tenant's encryption keys, so it must run ONLY for full_account requests.
// Real index.ts; supabase-js is the in-memory FakeDb; vault.ts and providerErasure.ts are mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { loadHandler, post, jsonOf, type Handler } from '../_shared/testing/edgeHarness.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));

const trust = vi.hoisted(() => ({ erase: vi.fn() }));
vi.mock('../_shared/trust/vault.ts', () => ({ eraseTrustPackData: (...a: unknown[]) => trust.erase(...a) }));

const prov = vi.hoisted(() => ({ erase: vi.fn() }));
vi.mock('../_shared/compliance/providerErasure.ts', () => ({ eraseProviderData: (...a: unknown[]) => prov.erase(...a) }));

const USER = 'u1';
const PAST = '2020-01-01T00:00:00.000Z';
let db: FakeDb;
let handler: Handler;

const request = (o: Record<string, any>) => ({
  id: 'r1', user_id: USER, status: 'grace_period', scheduled_for: PAST,
  request_type: 'full_account', target_dataset: null, target_customer_id: null, ...o,
});

async function runWith(req: Record<string, any>) {
  db.seed('deletion_requests', [req]);
  const res = await handler(post({}));
  return { res, body: await jsonOf(res) };
}

beforeEach(async () => {
  db = new FakeDb();
  db.rpcHandlers['has_active_legal_hold'] = () => false;
  db.rpcHandlers['erase_user_rows'] = () => ({ blocked: {} });
  sb.create = db.createClient;
  trust.erase.mockReset().mockResolvedValue({ ok: true });
  prov.erase.mockReset().mockResolvedValue({ ok: true, failed: [] });
  handler = await loadHandler(() => import('./index.ts'), { SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc' });
});

describe('eraseTrustPackData scope in data-retention-sweep', () => {
  it('is called exactly once, for the right user, on a full_account request', async () => {
    const { body } = await runWith(request({ request_type: 'full_account' }));
    expect(trust.erase).toHaveBeenCalledTimes(1);
    expect(trust.erase.mock.calls[0][1]).toBe(USER);
    expect(body.deletionRequestsProcessed).toBe(1);
    expect(db.rows('deletion_requests')[0].status).toBe('completed');
  });

  it('is NEVER called for a customer_record request', async () => {
    db.seed('customers', [{ id: 'c1', user_id: USER, name: 'Ann', phone: '1', email: 'a@x.test' }]);
    const { body } = await runWith(request({ request_type: 'customer_record', target_customer_id: 'c1' }));
    expect(trust.erase).not.toHaveBeenCalled();
    expect(prov.erase).not.toHaveBeenCalled();
    expect(body.deletionRequestsProcessed).toBe(1);
    expect(db.rows('customers')[0].name).toBe('Redacted Customer');
  });

  it('is NEVER called for a dataset request', async () => {
    db.seed('jobs', [{ id: 'j1', user_id: USER }]);
    const { body } = await runWith(request({ request_type: 'dataset', target_dataset: 'jobs' }));
    expect(trust.erase).not.toHaveBeenCalled();
    expect(prov.erase).not.toHaveBeenCalled();
    expect(body.deletionRequestsProcessed).toBe(1);
    expect(db.rows('jobs')).toHaveLength(0);
  });

  it('does not call it when a legal hold blocks the request', async () => {
    db.rpcHandlers['has_active_legal_hold'] = () => true;
    await runWith(request({ request_type: 'full_account' }));
    expect(trust.erase).not.toHaveBeenCalled();
    expect(db.rows('deletion_requests')[0].status).toBe('blocked_legal_hold');
  });

  it('full_account: if trust erasure fails, nothing else is deleted and the request returns to grace_period', async () => {
    trust.erase.mockResolvedValue({ ok: false, error: 'x' });
    db.seed('jobs', [{ id: 'j1', user_id: USER }]);
    const { body } = await runWith(request({ request_type: 'full_account' }));
    expect(db.rows('jobs')).toHaveLength(1);
    expect(db.rows('deletion_requests')[0].status).toBe('grace_period');
    expect(body.errors.join(' ')).toContain('trust_pack_erasure_incomplete');
  });
});
