// @vitest-environment node
// create-checkout-session: starts a subscription (Stripe Checkout) or switches the plan in place.
// The price is ALWAYS resolved from server env by plan id: the client never supplies a price.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from '../_shared/testing/fakeSupabase.ts';
import { get, jsonOf, loadHandler, options, type Handler } from '../_shared/testing/edgeHarness.ts';
import { authed, captureLogs, ID, seedUser } from '../_shared/testing/edgeKit.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));
const st = vi.hoisted(() => ({
  keys: [] as string[], customersCreate: vi.fn(), subsRetrieve: vi.fn(), subsUpdate: vi.fn(), pricesRetrieve: vi.fn(), sessionsCreate: vi.fn(),
}));
vi.mock('npm:stripe@17.4.0', () => ({
  default: class {
    customers = { create: (...a: unknown[]) => st.customersCreate(...a) };
    subscriptions = { retrieve: (...a: unknown[]) => st.subsRetrieve(...a), update: (...a: unknown[]) => st.subsUpdate(...a) };
    prices = { retrieve: (...a: unknown[]) => st.pricesRetrieve(...a) };
    checkout = { sessions: { create: (...a: unknown[]) => st.sessionsCreate(...a) } };
    constructor(key: string) { st.keys.push(key); }
  },
}));

const ENV = {
  SUPABASE_URL: 'http://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_SECRET_KEY: 'sk_test_x', SITE_URL: 'https://vireek.test/',
  STRIPE_PRICE_STARTER: 'price_s', STRIPE_PRICE_PROFESSIONAL: 'price_p', STRIPE_PRICE_BUSINESS: 'price_b',
};
let db: FakeDb; let handler: Handler; let env: Record<string, string | undefined>; let logs: ReturnType<typeof captureLogs>;
const call = (body: unknown, token: string | null = 'tok-owner') => handler(authed(body, token));
const profile = () => db.rows('profiles').find((p) => p.id === ID.ownerA)!;

beforeEach(async () => {
  db = new FakeDb();
  seedUser(db, 'tok-owner', ID.ownerA);
  db.seed('profiles', [{ id: ID.ownerA, email: 'o@x.test', full_name: 'Olga', stripe_customer_id: null, stripe_subscription_id: null, plan: 'free' }, { id: ID.ownerB, stripe_customer_id: 'cus_B', stripe_subscription_id: 'sub_B', plan: 'business' }]);
  sb.create = db.createClient;
  Object.values(st).forEach((v) => typeof v === 'function' && 'mockReset' in v && (v as ReturnType<typeof vi.fn>).mockReset());
  st.keys.length = 0;
  st.customersCreate.mockResolvedValue({ id: 'cus_new' });
  st.sessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.test/s1' });
  st.subsRetrieve.mockResolvedValue({ items: { data: [{ id: 'si_1' }] }, metadata: { keep: 'me' } });
  st.subsUpdate.mockResolvedValue({});
  st.pricesRetrieve.mockResolvedValue({ tax_behavior: 'exclusive' });
  env = { ...ENV };
  logs = captureLogs();
  handler = await loadHandler(() => import('./index.ts'), env);
});

describe('create-checkout-session: request gates', () => {
  it('preflight / method / unknown plan / auth', async () => {
    expect((await handler(options())).status).toBe(200);
    expect((await handler(get())).status).toBe(405);
    expect((await call({ planId: 'enterprise-free' })).status).toBe(400);
    expect((await call({ planId: 'starter' }, null)).status).toBe(401);
    expect((await call({ planId: 'starter' }, 'tok-nobody')).status).toBe(401);
    expect(st.sessionsCreate).not.toHaveBeenCalled();
  });
  it('500 (no Stripe call) when the key or the plan price is not configured', async () => {
    env.STRIPE_PRICE_STARTER = undefined;
    expect((await call({ planId: 'starter' })).status).toBe(500);
    env.STRIPE_PRICE_STARTER = 'price_s'; env.STRIPE_SECRET_KEY = undefined;
    expect((await call({ planId: 'starter' })).status).toBe(500);
    expect(st.customersCreate).not.toHaveBeenCalled();
  });
  it.todo('FINDING: a non-owner team member can currently start checkout / switch plan for their own profile row; gate to owner or can_view_billing');
});

describe('create-checkout-session: new subscriber', () => {
  it.each([['starter', 'price_s'], ['professional', 'price_p'], ['business', 'price_b']])('plan %s uses server price %s even if the client sends another', async (planId, price) => {
    const res = await call({ planId, priceId: 'price_attacker', price: 1 });
    expect(await jsonOf(res)).toEqual({ url: 'https://checkout.stripe.test/s1' });
    const args = st.sessionsCreate.mock.calls[0][0];
    expect(args.line_items).toEqual([{ price, quantity: 1 }]);
    expect(args.mode).toBe('subscription');
    expect(args.metadata).toEqual({ supabase_user_id: ID.ownerA, plan_id: planId });
    expect(args.subscription_data.metadata).toEqual({ supabase_user_id: ID.ownerA, plan_id: planId });
  });
  it('creates the customer once, saves it on the CALLER profile only, and builds return URLs from SITE_URL', async () => {
    await call({ planId: 'starter' });
    expect(profile().stripe_customer_id).toBe('cus_new');
    expect(db.rows('profiles').find((p) => p.id === ID.ownerB)!.stripe_customer_id).toBe('cus_B');
    const args = st.sessionsCreate.mock.calls[0][0];
    expect(args.customer).toBe('cus_new');
    expect(args.success_url).toBe('https://vireek.test/dashboard/billing?checkout=success');
    expect(args.cancel_url).toBe('https://vireek.test/dashboard/billing?checkout=cancelled');
  });
  it('reuses an existing customer', async () => {
    profile().stripe_customer_id = 'cus_old';
    await call({ planId: 'starter' });
    expect(st.customersCreate).not.toHaveBeenCalled();
    expect(st.sessionsCreate.mock.calls[0][0].customer).toBe('cus_old');
  });
  it('tax is off by default; with STRIPE_AUTOMATIC_TAX=true it is on and an inclusive price is blocked', async () => {
    await call({ planId: 'starter' });
    expect(st.sessionsCreate.mock.calls[0][0].automatic_tax).toBeUndefined();
    env.STRIPE_AUTOMATIC_TAX = 'true';
    await call({ planId: 'starter' });
    expect(st.sessionsCreate.mock.calls[1][0].automatic_tax).toEqual({ enabled: true });
    st.pricesRetrieve.mockResolvedValueOnce({ tax_behavior: 'inclusive' });
    expect((await call({ planId: 'starter' })).status).toBe(500);
    expect(st.sessionsCreate).toHaveBeenCalledTimes(2);
  });
});

describe('create-checkout-session: existing subscription', () => {
  beforeEach(() => { profile().stripe_customer_id = 'cus_old'; profile().stripe_subscription_id = 'sub_old'; });
  it('swaps the price in place with proration and records the plan; no second subscription is created', async () => {
    expect(await jsonOf(await call({ planId: 'professional' }))).toEqual({ switched: true });
    expect(st.subsUpdate).toHaveBeenCalledWith('sub_old', expect.objectContaining({ items: [{ id: 'si_1', price: 'price_p' }], proration_behavior: 'create_prorations', metadata: { keep: 'me', plan_id: 'professional' } }));
    expect(st.sessionsCreate).not.toHaveBeenCalled();
    expect(profile().plan).toBe('professional');
  });
  it('a Stripe failure is a generic 500 and the local plan is not changed', async () => {
    st.subsUpdate.mockRejectedValueOnce(new Error('card_declined sk_test_leak'));
    const res = await call({ planId: 'business' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await jsonOf(res))).not.toContain('sk_test_leak');
    expect(profile().plan).toBe('free');
    expect(logs.text()).toContain('create_checkout_session_failed');
  });
});
