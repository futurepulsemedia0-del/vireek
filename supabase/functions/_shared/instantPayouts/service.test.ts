import { describe, it, expect, beforeEach } from 'vitest';
import {
  ServiceError,
  getDashboardLink,
  getEligibility,
  requestPayout,
  resumePayout,
  type Actor,
  type ConnectRow,
  type Deps,
  type Gateway,
  type PayoutRow,
  type Store,
} from './service';
import { createExpressLoginLink, createInstantPayout, getInstantBalance, listExternalAccounts, type StripeCtx } from './stripeApi';
import { DEFAULT_PRICING, type ExternalAccountSummary } from './logic';

// ---------------------------------------------------------------------------
// Mocked Stripe: a fetch() that records every call and answers like the real API.
// ---------------------------------------------------------------------------
interface Call { method: string; path: string; headers: Record<string, string>; body: URLSearchParams }

function mockStripe(opts: {
  externalAccounts?: unknown[];
  instantAvailable?: unknown[];
  payoutResponse?: () => { status: number; body: unknown };
} = {}) {
  const calls: Call[] = [];
  const keys = new Map<string, unknown>(); // Idempotency-Key -> first response (Stripe replays it)
  let payoutSeq = 0;

  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    calls.push({ method, path: url.pathname.replace('/v1/', ''), headers, body });
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

    if (url.pathname === '/v1/balance') {
      return reply(200, {
        object: 'balance',
        instant_available: opts.instantAvailable ?? [{ amount: 50_500, currency: 'usd', net_available: [{ amount: 50_000, destination: 'card_1' }] }],
      });
    }
    if (url.pathname.endsWith('/external_accounts')) {
      return reply(200, {
        object: 'list',
        data: opts.externalAccounts ?? [
          { id: 'card_1', object: 'card', brand: 'Visa', funding: 'debit', last4: '4242', currency: 'usd', default_for_currency: true, available_payout_methods: ['standard', 'instant'] },
        ],
      });
    }
    if (url.pathname === '/v1/payouts' && method === 'POST') {
      const key = headers['Idempotency-Key'];
      if (key && keys.has(key)) return reply(200, keys.get(key));
      if (opts.payoutResponse) {
        const r = opts.payoutResponse();
        if (r.status >= 200 && r.status < 300 && key) keys.set(key, r.body);
        return reply(r.status, r.body);
      }
      const payout = {
        id: `po_${++payoutSeq}`,
        object: 'payout',
        status: 'in_transit',
        amount: Number(body.get('amount')),
        arrival_date: 1_800_000_000,
        application_fee_amount: 500,
      };
      if (key) keys.set(key, payout);
      return reply(200, payout);
    }
    if (url.pathname.endsWith('/login_links')) return reply(200, { url: 'https://connect.stripe.com/express/abc' });
    return reply(404, { error: { message: `no route ${url.pathname}` } });
  };

  const ctx: StripeCtx = { secretKey: 'sk_test_x', fetchImpl };
  const gateway: Gateway = {
    getInstantBalance: (a) => getInstantBalance(ctx, a),
    listExternalAccounts: (a) => listExternalAccounts(ctx, a),
    createInstantPayout: (a, i) => createInstantPayout(ctx, a, i),
    createExpressLoginLink: (a) => createExpressLoginLink(ctx, a),
  };
  return { calls, gateway, payoutCalls: () => calls.filter((c) => c.path === 'payouts') };
}

// ---------------------------------------------------------------------------
// In-memory store that mimics the SQL state machine (unique key, one pending, no backwards moves).
// ---------------------------------------------------------------------------
function memoryStore(init: { connect?: Partial<ConnectRow> | null; openDispute?: boolean } = {}) {
  const rows: PayoutRow[] = [];
  const audit: string[] = [];
  let seq = 0;
  const connect: ConnectRow | null =
    init.connect === null
      ? null
      : { stripe_account_id: 'acct_1', details_submitted: true, payouts_enabled: true, created_at: '2026-01-01T00:00:00Z', ...init.connect };

  const store: Store = {
    getConnect: async () => connect,
    hasOpenDispute: async () => init.openDispute === true,
    reserve: async ({ ownerId, actor, stripeAccountId, idempotencyKey, amountCents, feeCents, destination }) => {
      const same = rows.find((r) => r.user_id === ownerId && r.idempotency_key === idempotencyKey);
      if (same) return same;
      if (rows.some((r) => r.user_id === ownerId && r.status === 'pending')) {
        throw new ServiceError('Another instant payout is still being processed. Check back in a minute.', 409, 'reserve_rejected');
      }
      const row: PayoutRow = {
        id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
        user_id: ownerId,
        stripe_account_id: stripeAccountId,
        idempotency_key: idempotencyKey,
        amount_cents: amountCents,
        fee_cents: feeCents,
        currency: 'usd',
        destination_id: destination.id,
        destination_label: destination.label,
        status: 'pending',
        stripe_payout_id: null,
        failure_code: null,
        failure_message: null,
        arrival_date: null,
        completed_at: null,
        created_at: new Date().toISOString(),
      };
      rows.push(row);
      audit.push(`instant_payout_requested:${actor.userId}`);
      return row;
    },
    getPayout: async (o, id) => rows.find((r) => r.id === id && r.user_id === o) ?? null,
    findByKey: async (o, key) => rows.find((r) => r.user_id === o && r.idempotency_key === key) ?? null,
    markSent: async ({ id, stripePayoutId, status, feeCents, arrival }) => {
      const r = rows.find((x) => x.id === id)!;
      if (!r.stripe_payout_id) audit.push('instant_payout_sent');
      r.stripe_payout_id ??= stripePayoutId;
      r.status = status;
      if (feeCents !== null) r.fee_cents = feeCents;
      r.arrival_date = arrival ?? r.arrival_date;
      return r;
    },
    markFailed: async ({ id, code, message }) => {
      const r = rows.find((x) => x.id === id)!;
      if (r.status === 'pending' && !r.stripe_payout_id) {
        r.status = 'failed';
        r.failure_code = code;
        r.failure_message = message;
        audit.push('instant_payout_failed');
      }
      return r;
    },
    listRecent: async () => [...rows].reverse(),
  };
  return { store, rows, audit };
}

const owner: Actor = { userId: 'u1', email: 'owner@acme.com', ownerId: 'u1', canManage: true };
const member: Actor = { userId: 'u2', email: 'tech@acme.com', ownerId: 'u1', canManage: false };
const KEY = 'a1b2c3d4-e5f6-7890';

function deps(overrides: Partial<Deps> & { stripe: Gateway; store: Store }): Deps {
  return {
    pricing: DEFAULT_PRICING,
    minAccountAgeDays: 0,
    now: () => new Date('2026-06-01T00:00:00Z'),
    log: () => {},
    ...overrides,
  };
}

describe('getEligibility', () => {
  it('returns the balance, destination and recent history for an owner', async () => {
    const s = mockStripe();
    const { store } = memoryStore();
    const e = await getEligibility(deps({ stripe: s.gateway, store }), owner);
    expect(e.eligible).toBe(true);
    expect(e.maxPayoutCents).toBe(50_000);
    expect(e.destination?.label).toBe('Visa debit •••• 4242');
    expect(e.pricing).toMatchObject({ feeBps: 100, feeMinCents: 50 });
    // balance is read on the CONNECTED account and asks Stripe for the net-of-fee amounts
    const bal = s.calls.find((c) => c.path === 'balance')!;
    expect(bal.headers['Stripe-Account']).toBe('acct_1');
  });

  it('never calls Stripe for a team member without permission', async () => {
    const s = mockStripe();
    const { store } = memoryStore();
    const e = await getEligibility(deps({ stripe: s.gateway, store }), member);
    expect(e.reason).toBe('forbidden');
    expect(s.calls).toHaveLength(0);
  });

  it('stops before Stripe when onboarding is unfinished or a dispute is open', async () => {
    const s = mockStripe();
    const a = await getEligibility(deps({ stripe: s.gateway, store: memoryStore({ connect: { details_submitted: false } }).store }), owner);
    expect(a.reason).toBe('onboarding_incomplete');
    const b = await getEligibility(deps({ stripe: s.gateway, store: memoryStore({ openDispute: true }).store }), owner);
    expect(b.reason).toBe('open_dispute');
    const c = await getEligibility(deps({ stripe: s.gateway, store: memoryStore({ connect: null }).store }), owner);
    expect(c.reason).toBe('not_connected');
    expect(s.calls).toHaveLength(0);
  });

  it('blocks accounts newer than the configured minimum age', async () => {
    const s = mockStripe();
    const { store } = memoryStore({ connect: { created_at: '2026-05-31T00:00:00Z' } });
    const e = await getEligibility(deps({ stripe: s.gateway, store, minAccountAgeDays: 3 }), owner);
    expect(e.reason).toBe('account_too_new');
  });

  it('explains when only a non-instant bank account exists', async () => {
    const s = mockStripe({
      externalAccounts: [{ id: 'ba_1', object: 'bank_account', bank_name: 'Chase', last4: '6789', currency: 'usd', default_for_currency: true, available_payout_methods: ['standard'] }],
    });
    const e = await getEligibility(deps({ stripe: s.gateway, store: memoryStore().store }), owner);
    expect(e.reason).toBe('no_instant_destination');
  });

  it('reports no instant balance when Stripe shows none', async () => {
    const s = mockStripe({ instantAvailable: [] });
    const e = await getEligibility(deps({ stripe: s.gateway, store: memoryStore().store }), owner);
    expect(e.reason).toBe('no_instant_balance');
  });

  it('turns a Stripe outage into a friendly 502', async () => {
    const gateway = { ...mockStripe().gateway, getInstantBalance: async () => { throw new TypeError('network down'); } };
    await expect(getEligibility(deps({ stripe: gateway, store: memoryStore().store }), owner)).rejects.toMatchObject({ status: 502, code: 'stripe_unavailable' });
  });
});

describe('requestPayout', () => {
  let s: ReturnType<typeof mockStripe>;
  let m: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    s = mockStripe();
    m = memoryStore();
  });
  const input = { amountCents: 50_000, expectedFeeCents: 500, idempotencyKey: KEY };

  it('creates exactly one instant payout with the right Stripe request', async () => {
    const out = await requestPayout(deps({ stripe: s.gateway, store: m.store }), owner, input);
    expect(out.httpStatus).toBe(200);
    expect(out.payout).toMatchObject({ status: 'in_transit', stripe_payout_id: 'po_1', amount_cents: 50_000, fee_cents: 500 });

    const calls = s.payoutCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['Stripe-Account']).toBe('acct_1');
    expect(calls[0].headers['Idempotency-Key']).toBe(`instant_payout_${out.payout.id}`);
    expect(calls[0].body.get('method')).toBe('instant');
    expect(calls[0].body.get('amount')).toBe('50000');
    expect(calls[0].body.get('currency')).toBe('usd');
    expect(calls[0].body.get('destination')).toBe('card_1');
    expect(calls[0].body.get('metadata[instant_payout_id]')).toBe(out.payout.id);
  });

  it('writes the audit trail (requested, then sent)', async () => {
    await requestPayout(deps({ stripe: s.gateway, store: m.store }), owner, input);
    expect(m.audit).toEqual(['instant_payout_requested:u1', 'instant_payout_sent']);
  });

  it('records Stripe\'s actual application fee when it differs from the quote', async () => {
    const s2 = mockStripe({ payoutResponse: () => ({ status: 200, body: { id: 'po_9', status: 'in_transit', amount: 20_000, application_fee_amount: 200 } }) });
    const out = await requestPayout(deps({ stripe: s2.gateway, store: m.store }), owner, { amountCents: 20_000, expectedFeeCents: 200, idempotencyKey: KEY });
    expect(out.payout.fee_cents).toBe(200);
  });

  it('refuses when the fee the user saw is stale, without touching Stripe', async () => {
    await expect(requestPayout(deps({ stripe: s.gateway, store: m.store }), owner, { ...input, expectedFeeCents: 499 }))
      .rejects.toMatchObject({ status: 409, code: 'quote_changed', extra: { fee_cents: 500 } });
    expect(s.payoutCalls()).toHaveLength(0);
    expect(m.rows).toHaveLength(0);
  });

  it('refuses amounts above the net balance or below the minimum', async () => {
    await expect(requestPayout(deps({ stripe: s.gateway, store: m.store }), owner, { ...input, amountCents: 50_001, expectedFeeCents: 500 }))
      .rejects.toMatchObject({ code: 'amount_exceeds_balance', extra: { max_payout_cents: 50_000 } });
    await expect(requestPayout(deps({ stripe: s.gateway, store: m.store }), owner, { ...input, amountCents: 99, expectedFeeCents: 50 }))
      .rejects.toMatchObject({ code: 'amount_too_small' });
    expect(s.payoutCalls()).toHaveLength(0);
  });

  it('is blocked for team members without permission and during an open dispute', async () => {
    await expect(requestPayout(deps({ stripe: s.gateway, store: m.store }), member, input)).rejects.toMatchObject({ status: 403 });
    const disputed = memoryStore({ openDispute: true });
    await expect(requestPayout(deps({ stripe: s.gateway, store: disputed.store }), owner, input)).rejects.toMatchObject({ code: 'open_dispute' });
    expect(s.payoutCalls()).toHaveLength(0);
  });

  it('a double click / lost response with the same key never pays twice', async () => {
    const d = deps({ stripe: s.gateway, store: m.store });
    const first = await requestPayout(d, owner, input);
    // After the first payout the balance is spent, yet the replay must still return the original payout.
    const replay = await requestPayout(d, owner, input);
    expect(replay.payout.id).toBe(first.payout.id);
    expect(m.rows).toHaveLength(1);
    expect(s.payoutCalls().length).toBeLessThanOrEqual(1);
  });

  it('rejects reuse of a key for a different amount', async () => {
    const d = deps({ stripe: s.gateway, store: m.store });
    await requestPayout(d, owner, input);
    await expect(requestPayout(d, owner, { ...input, amountCents: 10_000, expectedFeeCents: 100 })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('blocks a second payout while one is still unconfirmed', async () => {
    const down = mockStripe({ payoutResponse: () => ({ status: 500, body: { error: { message: 'boom' } } }) });
    await requestPayout(deps({ stripe: down.gateway, store: m.store }), owner, input); // ambiguous -> stays pending
    await expect(requestPayout(deps({ stripe: s.gateway, store: m.store }), owner, { ...input, idempotencyKey: 'another-key-123' }))
      .rejects.toMatchObject({ code: 'reserve_rejected' });
  });

  it('marks the payout failed on a definite Stripe rejection and shows a plain-language reason', async () => {
    const s2 = mockStripe({ payoutResponse: () => ({ status: 400, body: { error: { code: 'invalid_card', message: 'raw stripe text' } } }) });
    await expect(requestPayout(deps({ stripe: s2.gateway, store: m.store }), owner, input))
      .rejects.toMatchObject({ status: 422, code: 'stripe_rejected', message: expect.stringMatching(/debit card/i) });
    expect(m.rows[0]).toMatchObject({ status: 'failed', failure_code: 'invalid_card', stripe_payout_id: null });
    expect(m.audit).toContain('instant_payout_failed');
  });

  it('keeps the reservation on an ambiguous Stripe failure, then resume finishes it with the SAME idempotency key', async () => {
    let healthy = false;
    const flaky = mockStripe({
      payoutResponse: () => (healthy ? { status: 200, body: { id: 'po_7', status: 'in_transit', amount: 50_000 } } : { status: 503, body: { error: { message: 'unavailable' } } }),
    });
    const d = deps({ stripe: flaky.gateway, store: m.store });

    const first = await requestPayout(d, owner, input);
    expect(first.httpStatus).toBe(202);
    expect(first.warning).toBe('status_unknown');
    expect(m.rows[0]).toMatchObject({ status: 'pending', stripe_payout_id: null });

    healthy = true;
    const resumed = await resumePayout(d, owner, first.payout.id);
    expect(resumed.payout).toMatchObject({ status: 'in_transit', stripe_payout_id: 'po_7' });

    const keys = flaky.payoutCalls().map((c) => c.headers['Idempotency-Key']);
    expect(new Set(keys).size).toBe(1);
  });

  it('survives a network error (fetch throws) as an ambiguous failure', async () => {
    const gateway: Gateway = { ...s.gateway, createInstantPayout: async () => { throw new TypeError('socket hang up'); } };
    const out = await requestPayout(deps({ stripe: gateway, store: m.store }), owner, input);
    expect(out.warning).toBe('status_unknown');
    expect(m.rows[0].status).toBe('pending');
  });
});

describe('resumePayout', () => {
  it('refuses to retry after the idempotency window has passed', async () => {
    const s = mockStripe({ payoutResponse: () => ({ status: 500, body: {} }) });
    const m = memoryStore();
    const first = await requestPayout(deps({ stripe: s.gateway, store: m.store }), owner, { amountCents: 50_000, expectedFeeCents: 500, idempotencyKey: KEY });
    const later = deps({ stripe: s.gateway, store: m.store, now: () => new Date(Date.now() + 24 * 60 * 60 * 1000) });
    await expect(resumePayout(later, owner, first.payout.id)).rejects.toMatchObject({ code: 'resume_expired' });
  });
  it('404s for someone else\'s payout and 403s for members', async () => {
    const m = memoryStore();
    const s = mockStripe();
    await expect(resumePayout(deps({ stripe: s.gateway, store: m.store }), owner, '0b9f2b5e-7c1d-4a52-9d0e-3f1f6c2a8b11')).rejects.toMatchObject({ status: 404 });
    await expect(resumePayout(deps({ stripe: s.gateway, store: m.store }), member, '0b9f2b5e-7c1d-4a52-9d0e-3f1f6c2a8b11')).rejects.toMatchObject({ status: 403 });
  });
});

describe('getDashboardLink', () => {
  it('returns the Express login link on the connected account', async () => {
    const s = mockStripe();
    const url = await getDashboardLink(deps({ stripe: s.gateway, store: memoryStore().store }), owner);
    expect(url).toMatch(/^https:\/\/connect\.stripe\.com\//);
    expect(s.calls[0].path).toBe('accounts/acct_1/login_links');
  });
  it('needs a connected account and permission', async () => {
    const s = mockStripe();
    await expect(getDashboardLink(deps({ stripe: s.gateway, store: memoryStore({ connect: null }).store }), owner)).rejects.toMatchObject({ code: 'not_connected' });
    await expect(getDashboardLink(deps({ stripe: s.gateway, store: memoryStore().store }), member)).rejects.toMatchObject({ status: 403 });
  });
});

describe('external account mapping', () => {
  it('labels cards and banks and flags prepaid / errored accounts as unusable', async () => {
    const s = mockStripe({
      externalAccounts: [
        { id: 'card_p', object: 'card', brand: 'Visa', funding: 'prepaid', last4: '1111', currency: 'usd', available_payout_methods: ['instant'] },
        { id: 'ba_e', object: 'bank_account', bank_name: 'Chase', last4: '6789', currency: 'usd', status: 'errored', available_payout_methods: ['instant'] },
        { id: 'ba_ok', object: 'bank_account', bank_name: 'Chase', last4: '0001', currency: 'usd', status: 'verified', available_payout_methods: ['standard', 'instant'] },
        { id: 'weird', object: 'wallet' },
      ],
    });
    const list: ExternalAccountSummary[] = await s.gateway.listExternalAccounts('acct_1');
    expect(list.map((a) => a.id)).toEqual(['card_p', 'ba_e', 'ba_ok']);
    expect(list.find((a) => a.id === 'ba_ok')).toMatchObject({ label: 'Chase •••• 0001', usable: true, instantCapable: true });
    expect(list.find((a) => a.id === 'card_p')?.usable).toBe(false);
    expect(list.find((a) => a.id === 'ba_e')?.usable).toBe(false);
  });
});
