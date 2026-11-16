// @vitest-environment node
//
// sendCompliantSms() is the customer-SMS choke point (37 importers). These tests run the REAL function with a fake
// Supabase client and a recorded fetch, and prove the plan / fraud guard sits in front of the Twilio call:
// caps and verification stop the send, emergency traffic and shadow mode do not, and the compliance gates still run first.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendCompliantSms } from '../../supabase/functions/_shared/messaging/sendSms';
import { PLAN_LIMITS } from '../../supabase/functions/_shared/fraud/planLimits';
import { makeFakeFraudDb, type FakeDbOptions } from '../test/planEnforcement/fakeFraudDb';
import { DOMESTIC, GUARD_PLANS, USER } from '../test/planEnforcement/matrix';

type Json = Record<string, unknown>;
let fetchCalls: Array<{ url: string; body: string }> = [];

/** Chainable, awaitable query builder that resolves to { data, error: null }. */
function chain(data: unknown): unknown {
  const target = function noop() {};
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data, error: null });
      if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve({ data, error: null });
      return () => proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

function makeAdmin(opts: FakeDbOptions, a2p = 'approved') {
  // sendCompliantSms() uses the real clock, so seed the ledger in today's UTC bucket.
  const fraud = makeFakeFraudDb({ dayKey: new Date().toISOString().slice(0, 10), ...opts });
  const admin = {
    rpc: fraud.rpc,
    from(table: string) {
      if (table === 'profiles') return chain({ a2p_campaign_status: a2p });
      if (table.startsWith('fraud_')) return fraud.from(table);
      return chain(null);
    },
  };
  return { admin: admin as never, fraud };
}

const send = (admin: never, over: Json = {}) =>
  sendCompliantSms(admin, USER, DOMESTIC, 'Your technician is on the way.', { skipQuietHours: true, source: 'plan-enforcement-test', ...over } as never);

beforeAll(() => {
  const env: Record<string, string> = { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'token', TWILIO_MESSAGING_SERVICE_SID: 'MGtest' };
  vi.stubGlobal('Deno', { env: { get: (k: string) => env[k] } });
  vi.stubGlobal('fetch', async (url: string, init?: { body?: unknown }) => {
    fetchCalls.push({ url: String(url), body: String(init?.body ?? '') });
    return { ok: true, status: 201, json: async () => ({ sid: 'SMtest' }) };
  });
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  fetchCalls = [];
});

describe('sendCompliantSms is guarded by the plan / fraud gate', () => {
  it('sends when the account is verified and under its caps', async () => {
    const { admin } = makeAdmin({});
    expect(await send(admin)).toMatchObject({ ok: true, sid: 'SMtest' });
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain('/Messages.json');
  });

  it.each(GUARD_PLANS)('%s: the daily SMS cap stops the send before Twilio (cap allowed, cap+1 refused)', async (plan: (typeof GUARD_PLANS)[number]) => {
    const cap = PLAN_LIMITS[plan].dailySms;
    const { admin } = makeAdmin({ context: { plan }, ledger: { daySms: cap - 1 } });
    expect(await send(admin)).toMatchObject({ ok: true });
    expect(await send(admin)).toMatchObject({ ok: false, reason: 'GUARD_BLOCKED', detail: 'DAILY_SMS' });
    expect(fetchCalls.length).toBe(1);
  });

  it('an unverified account cannot text customers', async () => {
    const { admin } = makeAdmin({ context: { outbound_unlocked: false } });
    expect(await send(admin)).toMatchObject({ ok: false, reason: 'GUARD_BLOCKED', detail: 'VERIFICATION_REQUIRED' });
    expect(fetchCalls.length).toBe(0);
  });

  it('the SMS kill switch stops the send', async () => {
    const { admin } = makeAdmin({ context: { kill_sms: true } });
    expect(await send(admin)).toMatchObject({ ok: false, reason: 'GUARD_BLOCKED', detail: 'KILL_SWITCH' });
    expect(fetchCalls.length).toBe(0);
  });

  it('fails closed when the fraud store is unreachable', async () => {
    const { admin } = makeAdmin({ context: null });
    expect(await send(admin)).toMatchObject({ ok: false, reason: 'GUARD_BLOCKED', detail: 'GUARD_UNAVAILABLE' });
    expect(fetchCalls.length).toBe(0);
  });

  it('purpose "emergency" is never stopped by caps, kill switch, suspension or an unverified account', async () => {
    const { admin } = makeAdmin({
      context: { kill_sms: true, kill_outbound_calls: true, status: 'suspended', outbound_unlocked: false },
      ledger: { daySms: 1_000_000, dayCostCents: 1_000_000_000, lifeCostCents: 1_000_000_000 },
    });
    expect(await send(admin, { purpose: 'emergency' })).toMatchObject({ ok: true, sid: 'SMtest' });
    expect(fetchCalls.length).toBe(1);
  });

  it('shadow mode (enforce = false) lets an over-cap message through and logs it', async () => {
    const cap = PLAN_LIMITS.professional.dailySms;
    const { admin, fraud } = makeAdmin({ context: { enforce: false }, ledger: { daySms: cap } });
    expect(await send(admin)).toMatchObject({ ok: true });
    expect(fetchCalls.length).toBe(1);
    expect(fraud.inserts.some((i) => (i.row.detail as Json | undefined)?.shadow === true)).toBe(true);
  });

  it('compliance gates still run first: an unapproved A2P campaign never reaches the guard', async () => {
    const { admin, fraud } = makeAdmin({}, 'pending');
    expect(await send(admin)).toMatchObject({ ok: false, reason: 'A2P_NOT_APPROVED' });
    expect(fraud.reserveCalls().length).toBe(0);
    expect(fetchCalls.length).toBe(0);
  });

  it('a refused message consumes no budget; an allowed one reserves exactly one SMS', async () => {
    const blocked = makeAdmin({ context: { kill_sms: true } });
    await send(blocked.admin);
    expect(blocked.fraud.reserveCalls().length).toBe(0);
    const ok = makeAdmin({});
    await send(ok.admin);
    expect(ok.fraud.reserveCalls().length).toBe(1);
    expect(ok.fraud.reserveCalls()[0].args).toMatchObject({ p_sms: 1 });
  });
});
