// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
// Reliability tests for payment-plan-runner (hourly cron: late fees -> auto-charges -> reminders). Real index.ts + real
// _shared/paymentPlans/logic.ts; supabase-js is the in-memory FakeDb and the Stripe/SMS side (charge.ts) is mocked.
// "KNOWN GAP" tests pin current behaviour that is a weakness; they document it, they do not endorse it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { captureErrors, jsonOf, loadHandler, options, post, get, type Handler } from '../_shared/testing/edgeHarness.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));

const charge = vi.hoisted(() => ({
  chargeInstallment: vi.fn(),
  notifyCustomer: vi.fn(),
}));
vi.mock('../_shared/paymentPlans/charge.ts', () => ({
  chargeInstallment: (...a: unknown[]) => charge.chargeInstallment(...a),
  notifyCustomer: (...a: unknown[]) => charge.notifyCustomer(...a),
  payLinkFor: (kind: string, id: string) => `https://pay.test/${kind}/${id}`,
}));

const NOW = '2026-10-28T12:00:00.000Z';
let db: FakeDb;
let env: Record<string, string | undefined>;
let handler: Handler;
let reminderState: Array<Record<string, any>>;

const inst = (o: Record<string, any> = {}) => ({
  id: 'i1', kind: 'installment', status: 'due', due_date: '2026-10-28', reminders_sent: [], auto_charge: false,
  customer_name: 'Ann', amount_cents: 10000, late_fee_cents: 0, currency: 'usd', customer_phone: '+15550001', customer_email: 'ann@x.test', ...o,
});
const run = (headers: Record<string, string> = { 'X-Cron-Secret': 'plan-secret' }) => handler(post({}, headers));

async function boot(extra: Record<string, string | undefined> = {}) {
  env = { SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', PAYMENT_PLAN_CRON_SECRET: 'plan-secret', STRIPE_SECRET_KEY: 'sk_test', ...extra };
  handler = await loadHandler(() => import('./index.ts'), env);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  db = new FakeDb();
  reminderState = [];
  db.rpcHandlers.assess_payment_plan_late_fees = () => 0;
  db.rpcHandlers.list_installments_to_charge = () => [];
  db.rpcHandlers.list_installments_for_reminders = () => [...reminderState];
  db.rpcHandlers.mark_plan_reminders_sent = (a) => {
    const r = reminderState.find((x) => x.id === a.p_installment_id);
    if (r) r.reminders_sent = [...(r.reminders_sent ?? []), ...a.p_stages];
    return null;
  };
  sb.create = db.createClient;
  charge.chargeInstallment.mockReset().mockResolvedValue({ outcome: 'paid' });
  charge.notifyCustomer.mockReset().mockResolvedValue(undefined);
  captureErrors();
  await boot();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('payment-plan-runner — auth', () => {
  it('rejects a missing X-Cron-Secret (401) before touching the DB, Stripe or customers', async () => {
    const res = await run({});
    expect(res.status).toBe(401);
    expect(db.log).toHaveLength(0);
    expect(charge.chargeInstallment).not.toHaveBeenCalled();
    expect(charge.notifyCustomer).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret (401)', async () => {
    const res = await run({ 'X-Cron-Secret': 'wrong' });
    expect(res.status).toBe(401);
    expect(db.log).toHaveLength(0);
  });

  it('fails CLOSED when the secret env var is unset: even an empty/absent header is rejected', async () => {
    await boot({ PAYMENT_PLAN_CRON_SECRET: undefined });
    expect((await run({})).status).toBe(401);
    expect((await run({ 'X-Cron-Secret': '' })).status).toBe(401);
    expect(db.log).toHaveLength(0);
  });

  it('returns 500 (and does nothing) when STRIPE_SECRET_KEY is missing', async () => {
    await boot({ STRIPE_SECRET_KEY: undefined });
    const res = await run();
    expect(res.status).toBe(500);
    expect((await jsonOf(res)).error).toMatch(/STRIPE_SECRET_KEY/);
    expect(db.log).toHaveLength(0);
  });

  it('accepts the correct secret', async () => {
    const res = await run();
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ ok: true, late_fees: 0, charged: 0, errors: 0 });
  });
});

describe('payment-plan-runner — charging', () => {
  it('runs late fees, then charges, then reminders, in that order (so a fee is included in the charge)', async () => {
    db.rpcHandlers.list_installments_to_charge = () => ['c1'];
    await run();
    expect(db.log.filter((c) => c.op === 'rpc').map((c) => c.table)).toEqual(['assess_payment_plan_late_fees', 'list_installments_to_charge', 'list_installments_for_reminders']);
  });

  it('tallies outcomes and passes the secret key, id and manual=false to chargeInstallment', async () => {
    db.rpcHandlers.assess_payment_plan_late_fees = () => 3;
    db.rpcHandlers.list_installments_to_charge = () => ['p', 'f', 'r', 's'];
    const by: Record<string, string> = { p: 'paid', f: 'failed', r: 'requires_action', s: 'skipped' };
    charge.chargeInstallment.mockImplementation(async (_a: unknown, _k: string, id: string) => ({ outcome: by[id] }));
    const body = await jsonOf(await run());
    expect(body).toMatchObject({ late_fees: 3, charged: 1, failed: 1, requires_action: 1, errors: 0 });
    expect(charge.chargeInstallment.mock.calls.map((c) => c.slice(1))).toEqual([['sk_test', 'p', false], ['sk_test', 'f', false], ['sk_test', 'r', false], ['sk_test', 's', false]]);
  });

  it('one bad installment never blocks the rest (error counted, others still charged)', async () => {
    db.rpcHandlers.list_installments_to_charge = () => ['a', 'boom', 'c'];
    charge.chargeInstallment.mockImplementation(async (_a: unknown, _k: string, id: string) => { if (id === 'boom') throw new Error('stripe 500'); return { outcome: 'paid' }; });
    const body = await jsonOf(await run());
    expect(body).toMatchObject({ charged: 2, errors: 1 });
  });

  it('a failing late-fee RPC is isolated: charging and reminders still run', async () => {
    db.failOn({ rpc: 'assess_payment_plan_late_fees', error: { message: 'deadlock' } });
    db.rpcHandlers.list_installments_to_charge = () => ['a'];
    const body = await jsonOf(await run());
    expect(body).toMatchObject({ late_fees: 0, charged: 1, errors: 1 });
  });

  it('a failing charge-list RPC is isolated: reminders still run', async () => {
    db.failOn({ rpc: 'list_installments_to_charge', error: { message: 'timeout' } });
    reminderState.push(inst());
    const body = await jsonOf(await run());
    expect(body).toMatchObject({ errors: 1, reminders: 1 });
  });

  it('a network-level throw from the DB is also contained (200, error counted)', async () => {
    db.failOn({ rpc: 'list_installments_to_charge', mode: 'throw', error: { message: 'fetch failed' } });
    const res = await run();
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).errors).toBe(1);
  });

  it('idempotent re-run: ids the claim step no longer returns are not charged twice; "skipped" is not counted', async () => {
    let queue = ['a'];
    db.rpcHandlers.list_installments_to_charge = () => queue;
    charge.chargeInstallment.mockImplementation(async () => { const first = queue.length > 0; queue = []; return { outcome: first ? 'paid' : 'skipped' }; });
    expect((await jsonOf(await run())).charged).toBe(1);
    expect((await jsonOf(await run())).charged).toBe(0);
    expect(charge.chargeInstallment).toHaveBeenCalledTimes(1);
  });
});

describe('payment-plan-runner — reminders', () => {
  it('sends the due-today reminder to that row\'s own contact, with its own pay link, then marks the stage', async () => {
    reminderState.push(inst());
    const body = await jsonOf(await run());
    expect(body.reminders).toBe(1);
    const [contact, subject, text] = charge.notifyCustomer.mock.calls[0];
    expect(contact).toEqual({ customer_phone: '+15550001', customer_email: 'ann@x.test' });
    expect(typeof subject).toBe('string');
    expect(text).toContain('https://pay.test/i/i1');
    expect(db.rpcCalls('mark_plan_reminders_sent')[0].payload).toEqual({ p_installment_id: 'i1', p_stages: ['upcoming_3d', 'due'] });
  });

  it('idempotent re-run: a second run does not re-send an already-sent stage', async () => {
    reminderState.push(inst());
    await run();
    await run();
    await run();
    expect(charge.notifyCustomer).toHaveBeenCalledTimes(1);
  });

  it('a long-overdue installment sends ONE reminder (latest stage) and marks every stage up to it — no back-fill', async () => {
    reminderState.push(inst({ due_date: '2026-10-20' })); // 8 days late
    await run();
    expect(charge.notifyCustomer).toHaveBeenCalledTimes(1);
    expect(db.rpcCalls('mark_plan_reminders_sent')[0].payload.p_stages).toEqual(['upcoming_3d', 'due', 'overdue_1d', 'overdue_7d']);
  });

  it('never reminds deposits, and skips upcoming installments more than 3 days out', async () => {
    reminderState.push(inst({ id: 'dep', kind: 'deposit' }), inst({ id: 'far', due_date: '2026-11-15' }));
    const body = await jsonOf(await run());
    expect(body.reminders).toBe(0);
    expect(charge.notifyCustomer).not.toHaveBeenCalled();
  });

  it('auto-charge installments still scheduled get no day-of reminder (the charge is the notice)', async () => {
    reminderState.push(inst({ auto_charge: true, status: 'scheduled' }));
    expect((await jsonOf(await run())).reminders).toBe(0);
  });

  it('tenant isolation (cron scope): two tenants\' customers each get only their own message and link', async () => {
    reminderState.push(
      inst({ id: 'ta', customer_name: 'Tenant A Cust', customer_phone: '+1A', customer_email: 'a@a.test' }),
      inst({ id: 'tb', customer_name: 'Tenant B Cust', customer_phone: '+1B', customer_email: 'b@b.test' }),
    );
    await run();
    expect(charge.notifyCustomer).toHaveBeenCalledTimes(2);
    for (const [contact, , text] of charge.notifyCustomer.mock.calls) {
      const isA = contact.customer_phone === '+1A';
      expect(contact.customer_email).toBe(isA ? 'a@a.test' : 'b@b.test');
      expect(text).toContain(isA ? '/i/ta' : '/i/tb');
      expect(text).not.toContain(isA ? '/i/tb' : '/i/ta');
    }
  });

  it('a failing notification skips the mark (so it is retried next run), is counted, and does not block other rows', async () => {
    reminderState.push(inst({ id: 'bad' }), inst({ id: 'good' }));
    charge.notifyCustomer.mockImplementation(async (c: any) => { if (c.customer_phone === '+bad') throw new Error('twilio down'); });
    reminderState[0].customer_phone = '+bad';
    const body = await jsonOf(await run());
    expect(body).toMatchObject({ reminders: 1, errors: 1 });
    expect(db.rpcCalls('mark_plan_reminders_sent').map((c) => c.payload.p_installment_id)).toEqual(['good']);
  });

  it('KNOWN GAP: if the mark RPC fails AFTER the customer was notified, the next run sends the same reminder again (at-least-once)', async () => {
    reminderState.push(inst());
    db.failOn({ rpc: 'mark_plan_reminders_sent', times: 1, error: { message: 'write failed' } });
    const first = await jsonOf(await run());
    expect(first).toMatchObject({ reminders: 1, errors: 0 }); // the rpc { error } is never checked, so the run reports success
    await run();
    expect(charge.notifyCustomer).toHaveBeenCalledTimes(2);
  });

  it('malformed rows: bad due_date, null reminders_sent and string amounts do not crash the run', async () => {
    reminderState.push(
      inst({ id: 'baddate', due_date: 'not-a-date' }),
      inst({ id: 'nullsent', reminders_sent: null, amount_cents: '12500', late_fee_cents: '300' }),
    );
    const res = await run();
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.errors).toBe(0);
    expect(body.reminders).toBe(1);
    expect(charge.notifyCustomer.mock.calls[0][2]).toContain('$128.00'); // 125.00 + 3.00 late fee, strings coerced
  });

  it('empty / null RPC results are handled', async () => {
    db.rpcHandlers.list_installments_to_charge = () => null;
    db.rpcHandlers.list_installments_for_reminders = () => null;
    const res = await run();
    expect(res.status).toBe(200);
  });

  it('CORS: this cron endpoint has no OPTIONS handling — a preflight is rejected as unauthorized (documents current behaviour)', async () => {
    expect((await handler(options())).status).toBe(401);
    expect((await handler(get())).status).toBe(401);
  });
});
