// @vitest-environment node
// membership-join-checkout: PUBLIC (no JWT) signup behind /join/:planSlug. Abuse protection + tenant derivation are the contract.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { get, jsonOf, loadHandler, options, post, type Handler } from '../_shared/testing/edgeHarness.ts';
import { BASE_ENV, captureLogs, ID } from '../_shared/testing/edgeKit.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));

const NOW = '2026-11-17T12:00:00.000Z';
const VALID = { plan_slug: 'gold-care', customer_name: 'Jane Doe', customer_email: 'Jane@Example.com ', customer_phone: '+1 415 555 0100' };
let db: FakeDb; let handler: Handler; let env: Record<string, string | undefined>;
const join = (o: Record<string, unknown> = {}) => handler(post({ ...VALID, ...o }));
const memberships = () => db.rows('memberships');

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
  db = new FakeDb();
  db.defaults.memberships = () => ({ created_at: new Date().toISOString() });
  db.defaults.payment_requests = () => ({ public_token: `tok_${Math.random().toString(36).slice(2, 14)}` }); // DB column default
  db.seed('membership_plans', [
    { id: 'plan-1', user_id: ID.ownerA, name: 'Gold', price_cents: 9900, public_slug: 'gold-care', public_enabled: true, active: true },
    { id: 'plan-off', user_id: ID.ownerA, name: 'Off', price_cents: 9900, public_slug: 'hidden-plan', public_enabled: false, active: true },
    { id: 'plan-cheap', user_id: ID.ownerA, name: 'Cheap', price_cents: 10, public_slug: 'too-cheap', public_enabled: true, active: true },
    { id: 'plan-nc', user_id: ID.ownerB, name: 'NoConnect', price_cents: 9900, public_slug: 'no-connect', public_enabled: true, active: true },
  ]);
  db.seed('stripe_connect_accounts', [{ user_id: ID.ownerA, stripe_account_id: 'acct_1', charges_enabled: true }, { user_id: ID.ownerB, stripe_account_id: 'acct_2', charges_enabled: false }]);
  sb.create = db.createClient;
  captureLogs();
  env = { ...BASE_ENV, STRIPE_SECRET_KEY: 'sk_test_x', SITE_URL: 'https://vireek.test/' };
  handler = await loadHandler(() => import('./index.ts'), env);
});

afterEach(() => { vi.useRealTimers(); });

describe('membership-join-checkout: validation + abuse protection', () => {
  it('preflight / method', async () => {
    expect((await handler(options())).status).toBe(200);
    expect((await handler(get())).status).toBe(405);
  });
  it('honeypot: a filled "website" field is rejected before any database work', async () => {
    expect((await join({ website: 'http://spam.test' })).status).toBe(400);
    expect(db.log).toHaveLength(0);
  });
  it.each([
    [{ plan_slug: 'Bad Slug!' }, 404], [{ plan_slug: 'ab' }, 404], [{ customer_name: 'J' }, 400], [{ customer_name: 'x'.repeat(101) }, 400],
    [{ customer_email: 'not-an-email' }, 400], [{ customer_email: `${'a'.repeat(250)}@x.io` }, 400], [{ customer_phone: '12' }, 400], [{ customer_phone: '1'.repeat(16) }, 400],
  ])('rejects invalid input %j', async (o, status) => {
    expect((await join(o)).status).toBe(status);
    expect(memberships()).toHaveLength(0);
  });
  it('500 without Stripe configuration (nothing is created)', async () => {
    env.STRIPE_SECRET_KEY = undefined;
    expect((await join()).status).toBe(500);
    expect(memberships()).toHaveLength(0);
  });
  it('a disabled, unknown, too-cheap or not-yet-connected plan is unavailable and creates nothing', async () => {
    for (const [slug, status] of [['hidden-plan', 404], ['nope-nope', 404], ['too-cheap', 409], ['no-connect', 409]] as const) expect((await join({ plan_slug: slug })).status).toBe(status);
    expect(memberships()).toHaveLength(0);
    expect(db.rows('payment_requests')).toHaveLength(0);
  });
  it('an existing active / past_due member gets 409; a cancelled one may rejoin', async () => {
    db.seed('memberships', [{ id: 'm-old', plan_id: 'plan-1', customer_email: 'jane@example.com', status: 'active' }]);
    expect((await jsonOf(await join())).reason).toBe('already_member');
    memberships()[0].status = 'cancelled';
    expect((await join()).status).toBe(200);
  });
  it('rate limits: 5 per email per hour and 40 per plan per hour (429), older rows do not count', async () => {
    const recent = (i: number, email: string) => ({ id: `r${i}`, plan_id: 'plan-1', customer_email: email, status: 'cancelled', signup_source: 'public_join', created_at: '2026-11-17T11:30:00.000Z' });
    db.seed('memberships', Array.from({ length: 5 }, (_, i) => recent(i, 'jane@example.com')));
    expect((await join()).status).toBe(429);
    db.tables.memberships = [];
    db.seed('memberships', Array.from({ length: 40 }, (_, i) => recent(i, `u${i}@x.test`)));
    expect((await join({ customer_email: 'fresh@x.test' })).status).toBe(429);
    db.tables.memberships = Array.from({ length: 40 }, (_, i) => ({ ...recent(i, `u${i}@x.test`), created_at: '2026-11-17T09:00:00.000Z' }));
    expect((await join({ customer_email: 'fresh@x.test' })).status).toBe(200);
  });
});

describe('membership-join-checkout: signup', () => {
  it('derives the tenant from the PLAN, normalizes the email, ignores a client-supplied user_id, and creates a lead', async () => {
    const res = await join({ user_id: ID.ownerB });
    expect(res.status).toBe(200);
    expect(memberships()[0]).toMatchObject({ user_id: ID.ownerA, plan_id: 'plan-1', customer_email: 'jane@example.com', status: 'offered', signup_source: 'public_join', auto_renew: true });
    expect(db.rows('customers')[0]).toMatchObject({ user_id: ID.ownerA, email: 'jane@example.com', lifecycle_stage: 'lead', tags: ['membership-signup'] });
    expect(db.rows('payment_requests')[0]).toMatchObject({ user_id: ID.ownerA, amount: 99, status: 'sent' });
  });
  it('returns a usable pay path (the token must be selected back from the insert) and stores the same link', async () => {
    const body = await jsonOf(await join());
    const pr = db.rows('payment_requests')[0];
    expect(body.pay_path).toMatch(/^\/pay\/tok_[a-z0-9]+$/);
    expect(body.pay_path).toBe(`/pay/${pr.public_token}`);
    expect(pr.payment_link_url).toBe(`https://vireek.test${body.pay_path}`);
    expect(memberships()[0].last_payment_request_id).toBe(pr.id);
  });
  it('links an existing customer (same email, same tenant) instead of duplicating; another tenant customer is not reused', async () => {
    db.seed('customers', [{ id: 'c-a', user_id: ID.ownerA, email: 'jane@example.com' }, { id: 'c-b', user_id: ID.ownerB, email: 'jane@example.com' }]);
    await join();
    expect(memberships()[0].customer_id).toBe('c-a');
    expect(db.rows('customers')).toHaveLength(2);
  });
  it('double-click within 30 minutes reuses the open checkout and creates no new rows', async () => {
    const first = await jsonOf(await join());
    const second = await jsonOf(await join());
    expect(second.pay_path).toBe(first.pay_path);
    expect(memberships()).toHaveLength(1);
    expect(db.rows('payment_requests')).toHaveLength(1);
  });
  it('a database failure is a generic 500', async () => {
    db.failOn({ table: 'memberships', op: 'insert', error: { message: 'secret schema detail' } });
    const res = await join();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await jsonOf(res))).not.toContain('secret schema detail');
  });
  it('regression: index.ts has no dead reference to an undefined `session` after the final return', () => {
    expect(readFileSync(new URL('./index.ts', import.meta.url), 'utf8')).not.toMatch(/session\.url/);
  });
});
