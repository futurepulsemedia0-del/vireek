// @vitest-environment node
// Reliability tests for money-recovered-run (weekly "Money Recovered" statement: cron sweep + owner send_now/send_test).
// Real index.ts + real engine/render; supabase-js is the in-memory FakeDb, Resend is a stubbed global fetch, the PDF builder is mocked.
// Statement maths themselves are covered by _shared/money-recovered/*.test.ts — here we test auth, isolation, idempotency and failure handling.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { captureErrors, get, jsonOf, loadHandler, options, post, type Handler } from '../_shared/testing/edgeHarness.ts';
import { computeStatement, previousWeekWindow } from '../_shared/money-recovered/engine.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));
vi.mock('npm:jspdf@2.5.2', () => ({ jsPDF: class {} }));
const pdf = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('../_shared/money-recovered/pdf.ts', () => ({ buildStatementPdf: (...a: unknown[]) => pdf.build(...a) }));

// Wednesday 11:00 in New York. The last full Mon–Sun week is 2026-10-19 .. 2026-10-25.
const NOW = '2026-10-28T15:00:00.000Z';
const WEEK = '2026-10-19';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const M = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TZ = 'America/New_York';

let db: FakeDb;
let handler: Handler;
let env: Record<string, string | undefined>;
let fetchMock: ReturnType<typeof vi.fn>;
let mails: Array<{ to: string; subject: string; hasAttachment: boolean }>;

const profile = (id: string, o: Record<string, unknown> = {}) => ({ id, email: `${id.slice(0, 1)}-owner@x.test`, company_name: `Co ${id.slice(0, 1)}`, invoice_currency: 'USD', status: 'active', role: 'owner', ...o });
const settings = (user_id: string, o: Record<string, unknown> = {}) => ({ user_id, enabled: true, send_hour: 8, timezone: TZ, include_owner: true, include_co_owners: false, extra_recipients: [], ...o });
const ev = (id: string, o: Record<string, unknown> = {}) => ({
  id, user_id: A, source_type: 'missed_call', call_id: null, customer_name: 'Cust ' + id, occurred_at: '2026-10-20T15:00:00Z', estimated_value_cents: 40000,
  status: 'recovered', recovery_method: 'callback', recovered_amount_cents: 30000, follow_up_count: 1, last_follow_up_at: '2026-10-21T15:00:00Z', resolved_at: '2026-10-22T15:00:00Z', ...o,
});
const snapshot = () => computeStatement({ events: [], calls: [], baseline: null, window: previousWeekWindow(new Date(NOW), TZ), now: new Date(NOW), currency: 'USD' });
const statements = () => db.rows('money_recovered_statements');
const deliveries = () => db.rows('money_recovered_deliveries');

const owner = (body: unknown, token: string | null = 'tokA') => handler(post(body, token ? { Authorization: `Bearer ${token}` } : {}));
const cron = (body: unknown = { action: 'sweep' }, secret = 'cron-s3cret') => handler(post(body, { 'X-Cron-Secret': secret }));

async function boot(extra: Record<string, string | undefined> = {}) {
  env = { SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc-key', SUPABASE_ANON_KEY: 'anon-key', MONEY_RECOVERED_CRON_SECRET: 'cron-s3cret', RESEND_API_KEY: 're_test', ...extra };
  handler = await loadHandler(() => import('./index.ts'), env);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  db = new FakeDb();
  db.uniques.money_recovered_statements = ['user_id', 'week_start'];
  db.users.tokA = { id: A, email: 'A-owner@x.test' };
  db.users.tokB = { id: B, email: 'B-owner@x.test' };
  db.users.tokM = { id: M, email: 'm@a.test' };
  db.seed('profiles', [profile(A), profile(B), profile(M, { role: 'technician' })]);
  sb.create = db.createClient;
  mails = [];
  fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    mails.push({ to: b.to[0], subject: b.subject, hasAttachment: Array.isArray(b.attachments) });
    return new Response('{"id":"em_1"}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  pdf.build.mockReset().mockReturnValue(new Uint8Array([37, 80, 68, 70]));
  captureErrors();
  await boot();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('money-recovered-run — request gating', () => {
  it('answers CORS preflight and rejects non-POST', async () => {
    expect((await handler(options())).status).toBe(200);
    expect((await handler(get())).status).toBe(405);
    expect(db.log).toHaveLength(0);
  });
});

describe('money-recovered-run — cron authentication', () => {
  it.each([
    ['wrong secret of the same length', 'cron-s3creX'],
    ['wrong secret of a different length', 'short'],
    ['empty secret', ''],
  ])('401 for %s — nothing is read or sent', async (_n, secret) => {
    db.seed('money_recovered_settings', [settings(A)]);
    const res = await cron({ action: 'sweep' }, secret);
    expect(res.status).toBe(401);
    expect(db.log).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('401 when MONEY_RECOVERED_CRON_SECRET is not configured (fails closed, even for an empty header)', async () => {
    await boot({ MONEY_RECOVERED_CRON_SECRET: undefined });
    expect((await cron({ action: 'sweep' }, 'anything')).status).toBe(401);
    expect((await cron({ action: 'sweep' }, '')).status).toBe(401);
    expect(db.log).toHaveLength(0);
  });

  it('a wrong cron secret does NOT fall through to JWT auth, even with a valid owner token', async () => {
    const res = await handler(post({ action: 'sweep' }, { 'X-Cron-Secret': 'bad', Authorization: 'Bearer tokA' }));
    expect(res.status).toBe(401);
    expect(db.log).toHaveLength(0);
  });

  it('an owner JWT cannot trigger the sweep (action "sweep" is cron-only)', async () => {
    db.seed('money_recovered_settings', [settings(B)]);
    const res = await owner({ action: 'sweep' });
    expect(res.status).toBe(400);
    expect(db.calls('money_recovered_settings')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the correct secret runs the sweep (nothing due -> processed 0)', async () => {
    const res = await cron();
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({ processed: 0, due: 0 });
  });
});

describe('money-recovered-run — owner authentication & validation', () => {
  it('401 without a token or with an invalid token', async () => {
    expect((await owner({ action: 'send_test' }, null)).status).toBe(401);
    expect((await owner({ action: 'send_test' }, 'garbage')).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates the caller with the ANON client carrying the caller\'s own Authorization header (not the service key)', async () => {
    await owner({ action: 'send_test' });
    const auth = db.clients.find((c) => c.key === 'anon-key');
    expect(auth?.headers?.Authorization).toBe('Bearer tokA');
  });

  it('403 for a non-owner profile (e.g. technician) and for a user with no profile', async () => {
    expect((await owner({ action: 'send_now' }, 'tokM')).status).toBe(403);
    db.users.tokZ = { id: 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz', email: 'z@x.test' };
    expect((await owner({ action: 'send_now' }, 'tokZ')).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statements()).toHaveLength(0);
  });

  it.each([
    ['unknown action', { action: 'drop_table' }],
    ['missing action', {}],
  ])('400 for %s', async (_n, body) => {
    expect((await owner(body)).status).toBe(400);
  });

  it.each([
    ['not a Monday', '2026-10-20'],
    ['malformed', '2026/10/19'],
    ['impossible date', '2026-02-30'],
    ['the current (incomplete) week', '2026-10-26'],
    ['a future week', '2027-01-04'],
  ])('400 for weekStart %s', async (_n, weekStart) => {
    const res = await owner({ action: 'send_now', weekStart });
    expect(res.status).toBe(400);
    expect(statements()).toHaveLength(0);
  });

  it('400 when the saved time zone is invalid', async () => {
    db.seed('money_recovered_settings', [settings(A, { timezone: 'Mars/Olympus' })]);
    expect((await owner({ action: 'send_now' })).status).toBe(400);
  });

  it('a non-JSON body is treated as empty (400), not a crash', async () => {
    const res = await handler(new Request('http://edge.test/fn', { method: 'POST', headers: { Authorization: 'Bearer tokA' }, body: '{oops' }));
    expect(res.status).toBe(400);
  });
});

describe('money-recovered-run — owner sends', () => {
  it('send_test mails ONLY the caller, prefixes the subject, records no delivery rows and leaves the statement unsent', async () => {
    const res = await owner({ action: 'send_test' });
    const body = await jsonOf(res);
    expect(res.status).toBe(200);
    expect(body.delivery).toEqual({ test: true, ok: true, error: null });
    expect(mails.map((m) => m.to)).toEqual(['a-owner@x.test']);
    expect(mails[0].subject.startsWith('[Test] ')).toBe(true);
    expect(deliveries()).toHaveLength(0);
    expect(statements()[0]).toMatchObject({ user_id: A, week_start: WEEK });
  });

  it('send_now delivers to owner + active co-owners + valid extras (deduped, lower-cased, invalid dropped, max 25) and marks the statement sent', async () => {
    db.seed('money_recovered_settings', [settings(A, { include_co_owners: true, extra_recipients: ['Boss@X.test', 'a-owner@x.test', 'not-an-email', ' ', 'extra@x.test'] })]);
    db.seed('team_members', [
      { account_owner_id: A, member_email: 'co@x.test', role: 'owner', invite_status: 'active' },
      { account_owner_id: A, member_email: 'pending@x.test', role: 'owner', invite_status: 'pending' },
      { account_owner_id: A, member_email: 'tech@x.test', role: 'technician', invite_status: 'active' },
      { account_owner_id: B, member_email: 'other-tenant-co@x.test', role: 'owner', invite_status: 'active' },
    ]);
    const body = await jsonOf(await owner({ action: 'send_now' }));
    expect(mails.map((m) => m.to).sort()).toEqual(['a-owner@x.test', 'boss@x.test', 'co@x.test', 'extra@x.test']);
    expect(body.delivery).toMatchObject({ status: 'sent', sent: 4, total: 4, error: null });
    expect(statements()[0].status).toBe('sent');
    expect(mails.every((m) => m.hasAttachment)).toBe(true);
  });

  it('caps recipients at 25', async () => {
    db.seed('money_recovered_settings', [settings(A, { extra_recipients: Array.from({ length: 40 }, (_, i) => `u${i}@x.test`) })]);
    await owner({ action: 'send_now' });
    expect(mails).toHaveLength(25);
  });

  it('with no valid recipients the statement is "ready" with an explanatory error and nothing is mailed', async () => {
    db.seed('money_recovered_settings', [settings(A, { include_owner: false })]);
    const body = await jsonOf(await owner({ action: 'send_now' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(body.delivery).toMatchObject({ status: 'ready', error: 'No valid recipients configured.' });
  });
});

describe('money-recovered-run — tenant isolation', () => {
  it('tenant A\'s statement uses only A\'s ledger rows; B\'s money, customers and recipients never appear', async () => {
    db.seed('revenue_recovery_events', [ev('ea1'), ev('eb1', { user_id: B, recovered_amount_cents: 999900, estimated_value_cents: 999900, customer_name: 'SECRET-B-CUSTOMER' })]);
    db.seed('money_recovered_settings', [settings(A), settings(B)]);
    const body = await jsonOf(await owner({ action: 'send_now' }));
    expect(body.statement.credited_cents).toBe(30000);
    expect(JSON.stringify(statements()[0].snapshot)).not.toContain('SECRET-B-CUSTOMER');
    expect(mails.map((m) => m.to)).toEqual(['a-owner@x.test']);
  });

  it('every read/write on tenant-owned tables carries the caller\'s user_id (service role bypasses RLS, so this is the only guard)', async () => {
    db.seed('revenue_recovery_events', [ev('ea1', { call_id: 'call-a' }), ev('eb1', { user_id: B, call_id: 'call-b' })]);
    db.seed('calls', [{ id: 'call-a', user_id: A, summary: 's', recording_url: 'https://r/a' }, { id: 'call-b', user_id: B, summary: 'SECRET-B', recording_url: 'https://r/b' }]);
    db.seed('money_recovered_baselines', [{ user_id: A, monthly_leak_cents: 100000, source: 'audit', label: null, captured_at: '2026-09-01T00:00:00Z' }, { user_id: B, monthly_leak_cents: 5, source: 'audit', label: null, captured_at: '2026-10-01T00:00:00Z' }]);
    await owner({ action: 'send_now', resend: true });
    const scoped = ['revenue_recovery_events', 'calls', 'money_recovered_baselines', 'money_recovered_statements', 'money_recovered_settings', 'profiles'];
    const owned = db.log.filter((c) => c.op !== 'rpc' && scoped.includes(c.table));
    expect(owned.length).toBeGreaterThan(5);
    for (const c of owned) {
      if (c.op === 'insert' || c.op === 'upsert') expect(c.payload.user_id).toBe(A);
      else expect(db.has(c, c.table === 'profiles' ? 'id' : 'user_id', A), `${c.op} ${c.table} is not scoped to the caller`).toBe(true);
    }
    expect(JSON.stringify(statements()[0].snapshot)).not.toContain('SECRET-B');
  });

  it('"resend" deletes only the caller\'s delivery rows for that statement', async () => {
    db.seed('money_recovered_settings', [settings(A)]);
    await owner({ action: 'send_now' });
    db.seed('money_recovered_deliveries', [{ statement_id: 'stmt-of-B', user_id: B, email: 'b@x.test', status: 'sent' }]);
    vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
    await owner({ action: 'send_now', resend: true });
    const del = db.calls('money_recovered_deliveries', 'delete')[0];
    expect(db.has(del, 'user_id', A)).toBe(true);
    expect(deliveries().some((d) => d.user_id === B)).toBe(true);
  });

  it('two tenants asking for the same week get two separate statements', async () => {
    await owner({ action: 'send_test' }, 'tokA');
    await owner({ action: 'send_test' }, 'tokB');
    expect(statements().map((s) => s.user_id).sort()).toEqual([A, B]);
  });
});

describe('money-recovered-run — idempotent re-runs', () => {
  it('send_now twice (after the cooldown) creates ONE statement and mails each recipient ONCE', async () => {
    db.seed('money_recovered_settings', [settings(A, { extra_recipients: ['x@x.test'] })]);
    await owner({ action: 'send_now' });
    vi.setSystemTime(new Date(Date.parse(NOW) + 120_000));
    const second = await jsonOf(await owner({ action: 'send_now' }));
    expect(statements()).toHaveLength(1);
    expect(mails).toHaveLength(2);
    expect(second.delivery).toMatchObject({ status: 'sent', sent: 2, total: 2 });
  });

  it('a send_now right after a successful send is rate-limited (429) and does nothing', async () => {
    db.seed('money_recovered_statements', [{ id: 's1', user_id: A, week_start: WEEK, status: 'sent', send_attempts: 1, generated_at: NOW, snapshot: snapshot() }]);
    const res = await owner({ action: 'send_now' });
    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('overlapping runs cannot double-send: the delivery claim is atomic per (statement, email)', async () => {
    db.seed('money_recovered_settings', [settings(A, { extra_recipients: ['x@x.test', 'y@x.test'] })]);
    await Promise.all([owner({ action: 'send_now' }), owner({ action: 'send_now' })]);
    expect(mails.map((m) => m.to).sort()).toEqual(['a-owner@x.test', 'x@x.test', 'y@x.test']);
    expect(statements()).toHaveLength(1);
  });

  it('a lost insert race falls back to the winning statement instead of failing', async () => {
    db.failOn({ table: 'money_recovered_statements', op: 'insert', times: 1, error: { message: 'duplicate key', code: '23505' }, when: () => { db.seed('money_recovered_statements', [{ id: 'winner', user_id: A, week_start: WEEK, status: 'ready', send_attempts: 0, generated_at: NOW, snapshot: snapshot() }]); return true; } });
    const res = await owner({ action: 'send_test' });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).statement.id).toBe('winner');
  });

  it('a statement that cannot be saved and has no winner -> generic 500 (no DB message leaked)', async () => {
    db.failOn({ table: 'money_recovered_statements', op: 'insert', error: { message: 'relation "internal_secret" is missing' } });
    const res = await owner({ action: 'send_test' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await jsonOf(res))).not.toContain('internal_secret');
  });
});

describe('money-recovered-run — sweep (cron)', () => {
  const seedTenants = () => {
    db.seed('money_recovered_settings', [settings(A), settings(B)]);
    db.seed('revenue_recovery_events', [ev('ea1'), ev('eb1', { user_id: B, recovered_amount_cents: 12000 })]);
  };

  it('sends each due tenant its own statement, once', async () => {
    seedTenants();
    const body = await jsonOf(await cron());
    expect(body).toMatchObject({ due: 2, processed: 2, sent: 2, failures: 0 });
    expect(mails.map((m) => m.to).sort()).toEqual(['a-owner@x.test', 'b-owner@x.test']);
    expect(statements().find((s) => s.user_id === A)!.credited_cents).toBe(30000);
    expect(statements().find((s) => s.user_id === B)!.credited_cents).toBe(12000);
  });

  it('is idempotent: a second sweep (and a third) sends nothing', async () => {
    seedTenants();
    await cron();
    const again = await jsonOf(await cron());
    await cron();
    expect(again).toMatchObject({ processed: 0, sent: 0 });
    expect(mails).toHaveLength(2);
    expect(statements()).toHaveLength(2);
  });

  it('skips disabled tenants, inactive accounts and statements that exhausted their 5 attempts', async () => {
    db.seed('profiles', [profile('d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1', { status: 'suspended' }), profile('e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1')]);
    db.seed('money_recovered_settings', [
      settings(A, { enabled: false }),
      settings('d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1'),
      settings('e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1'),
      settings(B),
    ]);
    db.seed('money_recovered_statements', [{ id: 'sx', user_id: 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1', week_start: WEEK, status: 'failed', send_attempts: 5, snapshot: snapshot() }]);
    const body = await jsonOf(await cron());
    expect(body).toMatchObject({ processed: 1, sent: 1 });
    expect(mails.map((m) => m.to)).toEqual(['b-owner@x.test']);
  });

  it('self-heals: a failed statement is retried on the next sweep and only the failed recipient is re-mailed', async () => {
    db.seed('money_recovered_settings', [settings(A, { extra_recipients: ['x@x.test'] })]);
    fetchMock.mockImplementation(async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body);
      mails.push({ to: b.to[0], subject: b.subject, hasAttachment: true });
      return b.to[0] === 'x@x.test' && mails.filter((m) => m.to === 'x@x.test').length === 1 ? new Response('rate limited', { status: 429 }) : new Response('{}', { status: 200 });
    });
    const first = await jsonOf(await cron());
    expect(first.sent).toBe(0); // statement is "partial", not "sent"
    expect(statements()[0].status).toBe('partial');
    await cron();
    expect(statements()[0].status).toBe('sent');
    expect(mails.map((m) => m.to).sort()).toEqual(['a-owner@x.test', 'x@x.test', 'x@x.test']); // owner mailed once, x retried once
  });

  it('is not due on Monday before send_hour, and is due from send_hour on', async () => {
    db.seed('money_recovered_settings', [settings(A)]);
    vi.setSystemTime(new Date('2026-10-26T11:00:00Z')); // Mon 07:00 New York
    expect(await jsonOf(await cron())).toEqual({ processed: 0, due: 0 });
    vi.setSystemTime(new Date('2026-10-26T13:00:00Z')); // Mon 09:00
    expect((await jsonOf(await cron())).due).toBe(1);
  });

  it('a failing tenant does not block the others (failure counted, rest sent)', async () => {
    seedTenants();
    db.failOn({ table: 'money_recovered_statements', op: 'insert', when: (c) => c.payload?.user_id === A, error: { message: 'boom' } });
    const body = await jsonOf(await cron());
    expect(body).toMatchObject({ processed: 2, sent: 1, failures: 1 });
    expect(mails.map((m) => m.to)).toEqual(['b-owner@x.test']);
  });

  it('processes at most 20 tenants per sweep; the rest are picked up by the next run', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
    db.seed('profiles', ids.map((id) => profile(id, { email: `${id}@x.test` })));
    db.seed('money_recovered_settings', ids.map((id) => settings(id)));
    expect((await jsonOf(await cron())).processed).toBe(20);
    expect((await jsonOf(await cron())).processed).toBe(5);
    expect(mails).toHaveLength(25);
  });

  it('a failing settings query returns a generic 500', async () => {
    db.failOn({ table: 'money_recovered_settings', op: 'select', error: { message: 'db down' } });
    const res = await cron();
    expect(res.status).toBe(500);
    expect(await jsonOf(res)).toEqual({ error: 'Money Recovered run failed.' });
  });
});

describe('money-recovered-run — external-service failure', () => {
  it('Resend returning an error marks the delivery and statement "failed" with a truncated last_error', async () => {
    fetchMock.mockResolvedValue(new Response('x'.repeat(900), { status: 500 }));
    const body = await jsonOf(await owner({ action: 'send_now' }));
    expect(body.delivery.status).toBe('failed');
    expect(deliveries()[0].status).toBe('failed');
    expect(deliveries()[0].error.length).toBeLessThanOrEqual(300);
    expect(statements()[0]).toMatchObject({ status: 'failed' });
    expect(statements()[0].last_error.length).toBeLessThanOrEqual(300);
  });

  it('a network error (fetch rejects) is contained and recorded', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const res = await owner({ action: 'send_now' });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).delivery).toMatchObject({ status: 'failed', error: 'ECONNRESET' });
  });

  it('missing RESEND_API_KEY is reported as a failed delivery, not a crash', async () => {
    await boot({ RESEND_API_KEY: undefined });
    const body = await jsonOf(await owner({ action: 'send_now' }));
    expect(body.delivery.status).toBe('failed');
    expect(body.delivery.error).toMatch(/RESEND_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('send_test surfaces the provider error to the caller', async () => {
    fetchMock.mockResolvedValue(new Response('domain not verified', { status: 403 }));
    const body = await jsonOf(await owner({ action: 'send_test' }));
    expect(body.delivery).toEqual({ test: true, ok: false, error: 'domain not verified' });
  });

  it('a PDF build failure does not block the email — it is sent without an attachment', async () => {
    pdf.build.mockImplementation(() => { throw new Error('jspdf exploded'); });
    await owner({ action: 'send_now' });
    expect(mails).toHaveLength(1);
    expect(mails[0].hasAttachment).toBe(false);
  });

  it('a stuck "sending" claim is re-claimed after 15 minutes, but not before (crash recovery without double-send)', async () => {
    db.seed('money_recovered_settings', [settings(A)]);
    db.seed('money_recovered_statements', [{ id: 's1', user_id: A, week_start: WEEK, status: 'ready', send_attempts: 0, generated_at: '2026-10-28T10:00:00Z', snapshot: snapshot() }]);
    db.seed('money_recovered_deliveries', [{ id: 'dl', statement_id: 's1', user_id: A, email: 'a-owner@x.test', status: 'sending', updated_at: new Date(Date.parse(NOW) - 5 * 60_000).toISOString() }]);
    await owner({ action: 'send_now' });
    expect(mails).toHaveLength(0); // in-flight elsewhere
    deliveries()[0].updated_at = new Date(Date.parse(NOW) - 20 * 60_000).toISOString();
    await owner({ action: 'send_now' });
    expect(mails).toHaveLength(1);
    expect(deliveries()[0].status).toBe('sent');
  });
});
