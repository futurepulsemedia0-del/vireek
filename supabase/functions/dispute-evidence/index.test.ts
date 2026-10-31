// @vitest-environment node
// Reliability tests for dispute-evidence (authenticated Stripe dispute actions: submit / accept / sync).
// Real index.ts + real disputes/normalize.ts; supabase-js is the in-memory FakeDb and Stripe is mocked (stripeApi.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { captureErrors, get, jsonOf, loadHandler, options, post, type Handler } from '../_shared/testing/edgeHarness.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));

const stripe = vi.hoisted(() => ({ call: vi.fn(), upload: vi.fn() }));
vi.mock('../_shared/disputes/stripeApi.ts', () => ({
  stripeCall: (...a: unknown[]) => stripe.call(...a),
  stripeUploadEvidenceFile: (...a: unknown[]) => stripe.upload(...a),
}));

const NOW = '2026-10-28T12:00:00.000Z';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const M = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const future = new Date(Date.parse(NOW) + 5 * 86400_000).toISOString();
const past = new Date(Date.parse(NOW) - 86400_000).toISOString();

let db: FakeDb;
let handler: Handler;
let env: Record<string, string | undefined>;

const dispute = (o: Record<string, unknown> = {}) => ({
  id: 'd1', user_id: A, stripe_dispute_id: 'dp_1', stripe_account_id: 'acct_1', status: 'needs_response', submission_count: 0,
  evidence_due_by: future, evidence_draft: { customer_name: 'Ann' }, ...o,
});
const stripeDispute = (o: Record<string, unknown> = {}) => ({ id: 'dp_1', status: 'under_review', amount: 5000, currency: 'usd', created: 1_790_000_000, evidence_details: { submission_count: 1 }, ...o });
const act = (body: unknown, token: string | null = 'tokA') => handler(post(body, token ? { Authorization: `Bearer ${token}` } : {}));

async function boot(extra: Record<string, string | undefined> = {}) {
  env = { SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_SECRET_KEY: 'sk_test', ...extra };
  handler = await loadHandler(() => import('./index.ts'), env);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  db = new FakeDb();
  db.users.tokA = { id: A, email: 'owner-a@x.test' };
  db.users.tokB = { id: B, email: 'owner-b@x.test' };
  db.users.tokM = { id: M, email: 'member@a.test' };
  db.users.tokX = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', email: 'stranger@x.test' };
  db.seed('profiles', [{ id: A }, { id: B }]);
  db.rpcHandlers.apply_stripe_dispute_event = (a, d) => {
    const row = d.rows('stripe_disputes').find((r) => r.stripe_dispute_id === a.p.dispute.stripe_dispute_id);
    if (row) Object.assign(row, { status: a.p.dispute.status, submission_count: a.p.dispute.submission_count });
    return null;
  };
  sb.create = db.createClient;
  stripe.call.mockReset().mockResolvedValue(stripeDispute());
  stripe.upload.mockReset().mockResolvedValue('file_new');
  captureErrors();
  await boot();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('dispute-evidence — authentication', () => {
  it('handles CORS preflight and rejects non-POST methods', async () => {
    expect((await handler(options())).status).toBe(200);
    expect((await handler(get())).status).toBe(405);
    expect(db.log).toHaveLength(0);
  });

  it('401 without an Authorization header — nothing is read, Stripe is not called', async () => {
    const res = await act({ action: 'sync', dispute_id: 'd1' }, null);
    expect(res.status).toBe(401);
    expect(db.calls('stripe_disputes')).toHaveLength(0);
    expect(stripe.call).not.toHaveBeenCalled();
  });

  it('401 for an invalid / expired token', async () => {
    db.seed('stripe_disputes', [dispute()]);
    const res = await act({ action: 'sync', dispute_id: 'd1' }, 'garbage');
    expect(res.status).toBe(401);
    expect(stripe.call).not.toHaveBeenCalled();
  });

  it('403 for a signed-in user who is neither an account owner nor a team member', async () => {
    db.seed('stripe_disputes', [dispute()]);
    const res = await act({ action: 'sync', dispute_id: 'd1' }, 'tokX');
    expect(res.status).toBe(403);
    expect(stripe.call).not.toHaveBeenCalled();
  });

  it('403 for a team member without can_view_billing', async () => {
    db.seed('team_members', [{ member_email: 'member@a.test', account_owner_id: A, permissions: { can_view_billing: false } }]);
    db.seed('stripe_disputes', [dispute()]);
    expect((await act({ action: 'sync', dispute_id: 'd1' }, 'tokM')).status).toBe(403);
    expect(stripe.call).not.toHaveBeenCalled();
  });

  it('a team member WITH can_view_billing acts on the owner\'s account (queries are scoped to the owner id, not the member id)', async () => {
    db.seed('team_members', [{ member_email: 'member@a.test', account_owner_id: A, permissions: { can_view_billing: true } }]);
    db.seed('stripe_disputes', [dispute()]);
    const res = await act({ action: 'sync', dispute_id: 'd1' }, 'tokM');
    expect(res.status).toBe(200);
    const q = db.calls('stripe_disputes', 'select')[0];
    expect(db.has(q, 'user_id', A)).toBe(true);
    expect(db.has(q, 'user_id', M)).toBe(false);
  });

  it('fails closed when the same member email is attached to several accounts (ambiguous row -> 403)', async () => {
    db.seed('team_members', [
      { member_email: 'member@a.test', account_owner_id: A, permissions: { can_view_billing: true } },
      { member_email: 'member@a.test', account_owner_id: B, permissions: { can_view_billing: true } },
    ]);
    expect((await act({ action: 'sync', dispute_id: 'd1' }, 'tokM')).status).toBe(403);
  });
});

describe('dispute-evidence — validation', () => {
  it.each([
    ['unknown action', { action: 'delete', dispute_id: 'd1' }],
    ['missing dispute_id', { action: 'sync' }],
    ['empty body', {}],
  ])('400 for %s', async (_n, body) => {
    expect((await act(body)).status).toBe(400);
    expect(stripe.call).not.toHaveBeenCalled();
  });

  it('400 for a non-JSON body (does not crash)', async () => {
    const res = await handler(new Request('http://edge.test/fn', { method: 'POST', headers: { Authorization: 'Bearer tokA' }, body: '{not json' }));
    expect(res.status).toBe(400);
  });

  it('500 with a clear message when STRIPE_SECRET_KEY is not configured', async () => {
    await boot({ STRIPE_SECRET_KEY: undefined });
    const res = await act({ action: 'sync', dispute_id: 'd1' });
    expect(res.status).toBe(500);
    expect((await jsonOf(res)).error).toMatch(/STRIPE_SECRET_KEY/);
  });
});

describe('dispute-evidence — tenant isolation', () => {
  it('owner A cannot act on tenant B\'s dispute: 404, and Stripe is never called', async () => {
    db.seed('stripe_disputes', [dispute({ id: 'dB', user_id: B, stripe_dispute_id: 'dp_B' })]);
    for (const action of ['sync', 'accept', 'submit']) {
      const res = await act({ action, dispute_id: 'dB' });
      expect(res.status).toBe(404);
    }
    expect(stripe.call).not.toHaveBeenCalled();
    expect(stripe.upload).not.toHaveBeenCalled();
    expect(db.rpcCalls('apply_stripe_dispute_event')).toHaveLength(0);
  });

  it('evidence-file lookup is scoped to the owner as well as the dispute', async () => {
    db.seed('stripe_disputes', [dispute()]);
    await act({ action: 'submit', dispute_id: 'd1' });
    const q = db.calls('stripe_dispute_evidence_files', 'select')[0];
    expect(db.has(q, 'user_id', A)).toBe(true);
    expect(db.has(q, 'dispute_id', 'd1')).toBe(true);
  });

  it('only tenant A\'s evidence files are uploaded when B has files on a same-named dispute id', async () => {
    db.seed('stripe_disputes', [dispute()]);
    db.seed('stripe_dispute_evidence_files', [
      { id: 'fa', dispute_id: 'd1', user_id: A, storage_path: 'A/doc.pdf', file_name: 'doc.pdf', mime_type: 'application/pdf', category: 'receipt', stripe_file_id: null, created_at: '1' },
      { id: 'fb', dispute_id: 'd1', user_id: B, storage_path: 'B/secret.pdf', file_name: 'secret.pdf', mime_type: 'application/pdf', category: 'receipt', stripe_file_id: null, created_at: '2' },
    ]);
    db.files['A/doc.pdf'] = new Uint8Array([1, 2, 3]);
    db.files['B/secret.pdf'] = new Uint8Array([9, 9, 9]);
    const res = await act({ action: 'submit', dispute_id: 'd1' });
    expect(res.status).toBe(200);
    expect(stripe.upload).toHaveBeenCalledTimes(1);
    expect(stripe.upload.mock.calls[0][1]).toBe('doc.pdf');
  });
});

describe('dispute-evidence — sync / accept', () => {
  it('sync re-pulls the dispute from Stripe (Connect account passed) and persists it through the RPC', async () => {
    db.seed('stripe_disputes', [dispute({ status: 'needs_response' })]);
    stripe.call.mockResolvedValue(stripeDispute({ status: 'won' }));
    const res = await act({ action: 'sync', dispute_id: 'd1' });
    expect(await jsonOf(res)).toEqual({ ok: true, status: 'won' });
    expect(stripe.call).toHaveBeenCalledWith('GET', 'disputes/dp_1', 'sk_test', undefined, 'acct_1');
    const rpc = db.rpcCalls('apply_stripe_dispute_event')[0].payload.p;
    expect(rpc).toMatchObject({ event_type: 'charge.dispute.updated', stripe_account_id: 'acct_1', dispute: { stripe_dispute_id: 'dp_1', status: 'won' } });
    expect(rpc.event_id).toMatch(/^manual_sync_dp_1_\d+$/);
  });

  it('sync works even on an already-closed dispute (covers a missed webhook)', async () => {
    db.seed('stripe_disputes', [dispute({ status: 'lost' })]);
    expect((await act({ action: 'sync', dispute_id: 'd1' })).status).toBe(200);
  });

  it('accept concedes an open dispute via Stripe /close', async () => {
    db.seed('stripe_disputes', [dispute()]);
    stripe.call.mockResolvedValue(stripeDispute({ status: 'lost' }));
    const res = await act({ action: 'accept', dispute_id: 'd1' });
    expect(await jsonOf(res)).toEqual({ ok: true, status: 'lost' });
    expect(stripe.call).toHaveBeenCalledWith('POST', 'disputes/dp_1/close', 'sk_test', {}, 'acct_1');
  });

  it.each(['won', 'lost', 'under_review', 'charge_refunded'])('accept / submit on a "%s" dispute -> 409 and no Stripe call', async (status) => {
    db.seed('stripe_disputes', [dispute({ status })]);
    expect((await act({ action: 'accept', dispute_id: 'd1' })).status).toBe(409);
    expect((await act({ action: 'submit', dispute_id: 'd1' })).status).toBe(409);
    expect(stripe.call).not.toHaveBeenCalled();
  });

  it('warning_needs_response counts as open', async () => {
    db.seed('stripe_disputes', [dispute({ status: 'warning_needs_response' })]);
    expect((await act({ action: 'accept', dispute_id: 'd1' })).status).toBe(200);
  });
});

describe('dispute-evidence — submit', () => {
  it('409 when evidence was already submitted (Stripe allows one submission)', async () => {
    db.seed('stripe_disputes', [dispute({ submission_count: 1 })]);
    const res = await act({ action: 'submit', dispute_id: 'd1' });
    expect(res.status).toBe(409);
    expect(stripe.call).not.toHaveBeenCalled();
  });

  it('409 when the evidence deadline has passed', async () => {
    db.seed('stripe_disputes', [dispute({ evidence_due_by: past })]);
    expect((await act({ action: 'submit', dispute_id: 'd1' })).status).toBe(409);
    expect(stripe.call).not.toHaveBeenCalled();
  });

  it('400 when there is no evidence at all (no files, empty/whitespace draft)', async () => {
    db.seed('stripe_disputes', [dispute({ evidence_draft: { customer_name: '   ', note: 5 } })]);
    expect((await act({ action: 'submit', dispute_id: 'd1' })).status).toBe(400);
    expect(stripe.call).not.toHaveBeenCalled();
  });

  it('400 when the draft is null', async () => {
    db.seed('stripe_disputes', [dispute({ evidence_draft: null })]);
    expect((await act({ action: 'submit', dispute_id: 'd1' })).status).toBe(400);
  });

  it('submits a text-only draft with submit:true and persists the result', async () => {
    db.seed('stripe_disputes', [dispute()]);
    const res = await act({ action: 'submit', dispute_id: 'd1' });
    expect(await jsonOf(res)).toEqual({ ok: true, status: 'under_review' });
    const [method, path, key, params, acct] = stripe.call.mock.calls[0];
    expect([method, path, key, acct]).toEqual(['POST', 'disputes/dp_1', 'sk_test', 'acct_1']);
    expect(params.submit).toBe(true);
    expect(JSON.stringify(params.evidence)).toContain('Ann');
    expect(stripe.upload).not.toHaveBeenCalled();
  });

  it('uploads each file once and records its Stripe id; a retry skips files already uploaded (no duplicate uploads)', async () => {
    db.seed('stripe_disputes', [dispute()]);
    db.seed('stripe_dispute_evidence_files', [
      { id: 'f1', dispute_id: 'd1', user_id: A, storage_path: 'A/1.pdf', file_name: '1.pdf', mime_type: 'application/pdf', category: 'receipt', stripe_file_id: 'file_old', created_at: '1' },
      { id: 'f2', dispute_id: 'd1', user_id: A, storage_path: 'A/2.pdf', file_name: '2.pdf', mime_type: 'application/pdf', category: 'receipt', stripe_file_id: null, created_at: '2' },
    ]);
    db.files['A/2.pdf'] = new Uint8Array([7]);
    expect((await act({ action: 'submit', dispute_id: 'd1' })).status).toBe(200);
    expect(stripe.upload).toHaveBeenCalledTimes(1);
    expect(db.rows('stripe_dispute_evidence_files').find((f) => f.id === 'f2')!.stripe_file_id).toBe('file_new');
  });

  it('double-submit is safe: the second attempt is rejected and Stripe sees exactly one submission', async () => {
    db.seed('stripe_disputes', [dispute()]);
    expect((await act({ action: 'submit', dispute_id: 'd1' })).status).toBe(200);
    expect((await act({ action: 'submit', dispute_id: 'd1' })).status).toBe(409);
    expect(stripe.call.mock.calls.filter((c) => c[3]?.submit === true)).toHaveLength(1);
  });
});

describe('dispute-evidence — external-service failure', () => {
  it('storage download failure -> 500 naming the file; nothing is sent to Stripe', async () => {
    db.seed('stripe_disputes', [dispute()]);
    db.seed('stripe_dispute_evidence_files', [{ id: 'f1', dispute_id: 'd1', user_id: A, storage_path: 'A/missing.pdf', file_name: 'missing.pdf', mime_type: 'application/pdf', category: 'receipt', stripe_file_id: null, created_at: '1' }]);
    const res = await act({ action: 'submit', dispute_id: 'd1' });
    expect(res.status).toBe(500);
    expect((await jsonOf(res)).error).toContain('missing.pdf');
    expect(stripe.call).not.toHaveBeenCalled();
  });

  it('Stripe validation errors are surfaced (502) when short, and replaced with a generic message when long', async () => {
    db.seed('stripe_disputes', [dispute()]);
    stripe.call.mockRejectedValueOnce(new Error('Text evidence is too long'));
    const short = await act({ action: 'submit', dispute_id: 'd1' });
    expect(short.status).toBe(502);
    expect((await jsonOf(short)).error).toBe('Text evidence is too long');
    stripe.call.mockRejectedValueOnce(new Error('x'.repeat(400)));
    const long = await act({ action: 'submit', dispute_id: 'd1' });
    expect(long.status).toBe(502);
    expect((await jsonOf(long)).error).toBe('Something went wrong submitting the evidence.');
  });

  it('a failed submit can be retried: nothing was persisted, so the dispute is still open', async () => {
    db.seed('stripe_disputes', [dispute()]);
    stripe.call.mockRejectedValueOnce(new Error('Stripe API error (503)'));
    expect((await act({ action: 'submit', dispute_id: 'd1' })).status).toBe(502);
    expect((await act({ action: 'submit', dispute_id: 'd1' })).status).toBe(200);
  });

  it('a malformed Stripe response (no id/status) is rejected with 502 instead of corrupting the dispute row', async () => {
    db.seed('stripe_disputes', [dispute()]);
    stripe.call.mockResolvedValue({});
    const res = await act({ action: 'sync', dispute_id: 'd1' });
    expect(res.status).toBe(502);
    expect((await jsonOf(res)).error).toBe('Malformed dispute object');
    expect(db.rpcCalls('apply_stripe_dispute_event')).toHaveLength(0);
  });

  it('persist RPC failure -> 502 with a generic message (the raw DB error is not leaked)', async () => {
    db.seed('stripe_disputes', [dispute()]);
    db.failOn({ rpc: 'apply_stripe_dispute_event', error: { message: 'relation "secret_table" does not exist' } });
    const res = await act({ action: 'sync', dispute_id: 'd1' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await jsonOf(res))).not.toContain('secret_table');
  });

  it('a network-level throw from the DB lookup is a 502, not an unhandled rejection', async () => {
    db.failOn({ table: 'stripe_disputes', op: 'select', mode: 'throw', error: { message: 'fetch failed' } });
    expect((await act({ action: 'sync', dispute_id: 'd1' })).status).toBe(502);
  });
});
