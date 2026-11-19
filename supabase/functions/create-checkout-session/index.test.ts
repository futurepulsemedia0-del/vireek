// @vitest-environment node
// Cross-tenant negative tests for the billing entry points (checkout + portal share the same trust model:
// the Stripe customer / subscription is ALWAYS taken from the verified caller's own profile row, never from the request).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { captureErrors, jsonOf, loadHandler, post, type Handler } from '../_shared/testing/edgeHarness.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));

const st = vi.hoisted(() => ({
  sessionCreate: vi.fn(), customerCreate: vi.fn(), subRetrieve: vi.fn(), subUpdate: vi.fn(), portalCreate: vi.fn(),
}));
vi.mock('npm:stripe@17.4.0', () => ({
  default: class {
    checkout = { sessions: { create: st.sessionCreate } };
    customers = { create: st.customerCreate };
    subscriptions = { retrieve: st.subRetrieve, update: st.subUpdate };
    billingPortal = { sessions: { create: st.portalCreate } };
    prices = { retrieve: vi.fn() };
  },
}));

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENV = {
  SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_PRICE_STARTER: 'price_s', STRIPE_PRICE_PROFESSIONAL: 'price_p', STRIPE_PRICE_BUSINESS: 'price_b',
  SITE_URL: 'https://vireek.com', CORS_ALLOWED_ORIGINS: 'https://app.vireek.com',
};

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
  db.users.tokA = { id: A, email: 'a@x.test' };
  db.users.tokB = { id: B, email: 'b@x.test' };
  db.seed('profiles', [
    { id: A, stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A', email: 'a@x.test', full_name: 'A' },
    { id: B, stripe_customer_id: null, stripe_subscription_id: null, email: 'b@x.test', full_name: 'B' },
  ]);
  sb.create = db.createClient;
  st.sessionCreate.mockReset().mockResolvedValue({ url: 'https://stripe.test/co' });
  st.customerCreate.mockReset().mockResolvedValue({ id: 'cus_B_new' });
  st.subRetrieve.mockReset().mockResolvedValue({ items: { data: [{ id: 'si_A' }] }, metadata: {} });
  st.subUpdate.mockReset().mockResolvedValue({});
  st.portalCreate.mockReset().mockResolvedValue({ url: 'https://stripe.test/portal' });
  captureErrors();
});

describe('create-checkout-session tenant scoping', () => {
  let h: Handler;
  beforeEach(async () => { h = await loadHandler(() => import('./index.ts'), ENV); });

  it('401 without a valid session and touches nothing', async () => {
    expect((await h(post({ planId: 'starter' }))).status).toBe(401);
    expect((await h(post({ planId: 'starter' }, { Authorization: 'Bearer forged' }))).status).toBe(401);
    expect(st.sessionCreate).not.toHaveBeenCalled();
    expect(st.customerCreate).not.toHaveBeenCalled();
  });
  it("B can never be attached to A's Stripe customer or subscription, even if the body tries", async () => {
    const res = await h(post({ planId: 'starter', customerId: 'cus_A', userId: A, subscriptionId: 'sub_A' }, { Authorization: 'Bearer tokB' }));
    expect(res.status).toBe(200);
    expect(st.subUpdate).not.toHaveBeenCalled();
    expect(st.subRetrieve).not.toHaveBeenCalled();
    expect(st.sessionCreate.mock.calls[0][0].customer).toBe('cus_B_new');
    expect(st.sessionCreate.mock.calls[0][0].metadata.supabase_user_id).toBe(B);
    expect(db.rows('profiles').find((r) => r.id === A)!.stripe_customer_id).toBe('cus_A'); // A untouched
    expect(db.rows('profiles').find((r) => r.id === B)!.stripe_customer_id).toBe('cus_B_new');
  });
  it("A's plan switch updates only A's subscription and A's profile row", async () => {
    const res = await h(post({ planId: 'business' }, { Authorization: 'Bearer tokA' }));
    expect(await jsonOf(res)).toEqual({ switched: true });
    expect(st.subUpdate.mock.calls[0][0]).toBe('sub_A');
    expect(db.rows('profiles').find((r) => r.id === A)!.plan).toBe('business');
    expect(db.rows('profiles').find((r) => r.id === B)!.plan).toBeUndefined();
  });
  it('rejects unknown plans before any lookup', async () => {
    expect((await h(post({ planId: 'enterprise-free' }, { Authorization: 'Bearer tokA' }))).status).toBe(400);
  });
  it('CORS: allowed origin echoed, foreign origin gets no Allow-Origin, never "*"', async () => {
    const ok = await h(post({ planId: 'nope' }, { Authorization: 'Bearer tokA', origin: 'https://app.vireek.com' }));
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.vireek.com');
    const bad = await h(post({ planId: 'nope' }, { Authorization: 'Bearer tokA', origin: 'https://evil.com' }));
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await h(new Request('http://edge.test/fn', { method: 'OPTIONS', headers: { origin: 'https://evil.com' } }));
    expect(pre.status).toBe(403);
  });
});

describe('create-billing-portal-session tenant scoping', () => {
  let h: Handler;
  beforeEach(async () => { h = await loadHandler(() => import('../create-billing-portal-session/index.ts'), ENV); });

  it('401 without a valid session', async () => {
    expect((await h(post({}))).status).toBe(401);
    expect(st.portalCreate).not.toHaveBeenCalled();
  });
  it("opens the portal for the caller's own customer only", async () => {
    expect((await h(post({ customerId: 'cus_B_attacker' }, { Authorization: 'Bearer tokA' }))).status).toBe(200);
    expect(st.portalCreate.mock.calls[0][0].customer).toBe('cus_A');
  });
  it("B (no billing account) gets 404 and is never handed A's customer", async () => {
    const res = await h(post({ customerId: 'cus_A' }, { Authorization: 'Bearer tokB' }));
    expect(res.status).toBe(404);
    expect(st.portalCreate).not.toHaveBeenCalled();
  });
  it('does not leak internal error text', async () => {
    st.portalCreate.mockRejectedValue(new Error('No such customer: cus_A secret detail'));
    const res = await h(post({}, { Authorization: 'Bearer tokA' }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('cus_A');
  });
});
