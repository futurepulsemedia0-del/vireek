// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
// Full-account erasure must end by deleting the auth user: idempotent, audited, resumable.
// Real index.ts; supabase-js is the in-memory FakeDb (+ a spy for auth.admin.deleteUser); vault/provider mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { loadHandler, post, jsonOf, type Handler } from '../_shared/testing/edgeHarness.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));
const trust = vi.hoisted(() => ({ erase: vi.fn() }));
vi.mock('../_shared/trust/vault.ts', () => ({ eraseTrustPackData: (...a: unknown[]) => trust.erase(...a) }));
const prov = vi.hoisted(() => ({ erase: vi.fn() }));
vi.mock('../_shared/compliance/providerErasure.ts', () => ({ eraseProviderData: (...a: unknown[]) => prov.erase(...a) }));

const USER = '11111111-1111-4111-8111-111111111111';
const PAST = '2020-01-01T00:00:00.000Z';
let db: FakeDb;
let handler: Handler;
const deleteUser = vi.fn();
const audits = () => db.rpcCalls('log_audit_event').map((c) => c.payload);
const authAudits = () => audits().filter((a: any) => String(a.p_action).startsWith('auth_user_erasure:'));

const request = (o: Record<string, any> = {}) => ({
  id: 'r1', user_id: USER, status: 'grace_period', scheduled_for: PAST, request_type: 'full_account',
  target_dataset: null, target_customer_id: null, attempts: 0, processing_started_at: null, ...o,
});
async function run(rows: Record<string, any>[]) {
  db.seed('deletion_requests', rows);
  const res = await handler(post({}));
  return jsonOf(res);
}
const req1 = () => db.rows('deletion_requests')[0];

beforeEach(async () => {
  db = new FakeDb();
  db.rpcHandlers['has_active_legal_hold'] = () => false;
  db.rpcHandlers['erase_user_rows'] = () => ({ blocked: {} });
  db.rpcHandlers['log_audit_event'] = () => null;
  deleteUser.mockReset().mockResolvedValue({ error: null });
  sb.create = (...a: unknown[]) => {
    const c: any = (db.createClient as any)(...a);
    c.auth.admin = { deleteUser: (id: string) => deleteUser(id) };
    return c;
  };
  trust.erase.mockReset().mockResolvedValue({ ok: true });
  prov.erase.mockReset().mockResolvedValue({ ok: true, failed: [] });
  handler = await loadHandler(() => import('./index.ts'), { SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc' });
});

describe('full_account erasure finishes with auth.admin.deleteUser', () => {
  it('deletes exactly the request owner after data erasure, records result and audit', async () => {
    db.seed('jobs', [{ id: 'j1', user_id: USER }]);
    const body = await run([request()]);
    expect(deleteUser).toHaveBeenCalledTimes(1);
    expect(deleteUser).toHaveBeenCalledWith(USER);
    expect(db.rows('jobs')).toHaveLength(0);
    expect(req1().status).toBe('completed');
    expect(req1().result).toMatchObject({ auth_user_deleted: 1, auth_user_already_absent: 0 });
    expect(authAudits()).toEqual([expect.objectContaining({ p_user_id: USER, p_action: 'auth_user_erasure:deleted', p_target_id: 'r1' })]);
    expect(body.deletionRequestsProcessed).toBe(1);
  });

  it('runs the data erasure BEFORE the auth deletion', async () => {
    const order: string[] = [];
    db.rpcHandlers['erase_user_rows'] = () => { order.push('erase'); return { blocked: {} }; };
    deleteUser.mockImplementation(async () => { order.push('deleteUser'); return { error: null }; });
    await run([request()]);
    expect(order).toEqual(['erase', 'deleteUser']);
  });

  it('never deletes the auth user when data erasure is blocked', async () => {
    db.rpcHandlers['erase_user_rows'] = () => ({ blocked: { some_table: 'fk' } });
    await run([request()]);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(req1().status).toBe('grace_period');
  });

  it('is NEVER called for customer_record or dataset requests', async () => {
    db.seed('customers', [{ id: 'c1', user_id: USER, name: 'A' }]);
    await run([request({ id: 'a', request_type: 'customer_record', target_customer_id: 'c1' }), request({ id: 'b', request_type: 'dataset', target_dataset: 'jobs' })]);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('a legal hold placed just before the irreversible step blocks the deletion', async () => {
    let n = 0;
    db.rpcHandlers['has_active_legal_hold'] = () => ++n >= 2; // sweep pre-check clear, auth-step re-check held
    await run([request()]);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(req1().status).toBe('blocked_legal_hold');
    expect(authAudits()[0].p_action).toBe('auth_user_erasure:blocked_legal_hold');
  });
});

describe('idempotency and resumability', () => {
  it('re-running after completion does nothing', async () => {
    await run([request()]);
    await handler(post({}));
    expect(deleteUser).toHaveBeenCalledTimes(1);
    expect(authAudits()).toHaveLength(1);
  });

  it('user already gone (404) counts as success, with its own audit record', async () => {
    deleteUser.mockResolvedValue({ error: { message: 'User not found', status: 404, code: 'user_not_found' } });
    await run([request()]);
    expect(req1().status).toBe('completed');
    expect(req1().result).toMatchObject({ auth_user_deleted: 0, auth_user_already_absent: 1 });
    expect(authAudits()[0].p_action).toBe('auth_user_erasure:already_absent');
  });

  it('auth failure mid-way: data stays erased, request stays processing (not cancellable), code stored, then resumes', async () => {
    deleteUser.mockResolvedValueOnce({ error: { message: 'boom: secret internals', status: 500 } });
    db.seed('jobs', [{ id: 'j1', user_id: USER }]);
    const first = await run([request()]);
    expect(first.errors.join(' ')).toContain('auth_user_erasure_incomplete:auth_delete_500');
    expect(req1().status).toBe('processing');
    expect(req1().last_error).toBe('auth_delete_500');
    expect(JSON.stringify(req1())).not.toContain('secret internals');
    expect(db.rows('jobs')).toHaveLength(0);

    // fresh lease: another run must leave it alone
    await handler(post({}));
    expect(deleteUser).toHaveBeenCalledTimes(1);

    // lease expires -> resumed, succeeds
    req1().processing_started_at = '2020-01-01T00:00:00.000Z';
    const second = await handler(post({}));
    expect((await jsonOf(second)).deletionRequestsProcessed).toBe(1);
    expect(deleteUser).toHaveBeenCalledTimes(2);
    expect(req1()).toMatchObject({ status: 'completed', attempts: 2, last_error: null });
    expect(authAudits().map((a: any) => a.p_action)).toEqual(['auth_user_erasure:failed', 'auth_user_erasure:deleted']);
  });

  it('crash after deleteUser but before completion: retry sees already_absent and completes', async () => {
    await run([request({ status: 'processing', attempts: 1, processing_started_at: PAST })]);
    expect(req1().status).toBe('completed');
    deleteUser.mockReset().mockResolvedValue({ error: { message: 'User not found', status: 404 } });
    db.seed('deletion_requests', [request({ id: 'r2', status: 'processing', attempts: 1, processing_started_at: PAST })]);
    await handler(post({}));
    expect(db.rows('deletion_requests').find((r: any) => r.id === 'r2')!.status).toBe('completed');
  });

  it('a request whose lease is still fresh (another run owns it) is skipped without side effects', async () => {
    const body = await run([request({ status: 'processing', processing_started_at: new Date().toISOString() })]);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(body.deletionRequestsProcessed).toBe(0);
  });

  it('a throwing deleteUser (network) is retried later, not lost', async () => {
    deleteUser.mockRejectedValueOnce(new Error('ECONNRESET'));
    await run([request()]);
    expect(req1().status).toBe('processing');
    expect(req1().last_error).toBe('auth_delete_unreachable');
  });

  it('non-auth failures still return to grace_period with a safe code only', async () => {
    trust.erase.mockResolvedValue({ ok: false, error: 'x' });
    await run([request()]);
    expect(req1().status).toBe('grace_period');
    expect(req1().last_error).toBe('trust_pack_erasure_incomplete');
    expect(deleteUser).not.toHaveBeenCalled();
  });
});
