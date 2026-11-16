import { describe, it, expect } from 'vitest';
import {
  TOPUP_PURCHASE_TYPE,
  evaluateTopupSession,
  isTopupSession,
  parseTopupQuantity,
  processTopupReversal,
  processTopupSession,
  topupMinutes,
  type CreditArgs,
  type ReverseArgs,
  type TopupDeps,
  type TopupLineItemLike,
  type TopupProfileLike,
  type TopupSessionLike,
} from './topup';

const PRICE = 'price_topup_100';
const ALICE: TopupProfileLike = { id: 'alice', stripe_customer_id: 'cus_alice' };
const BOB: TopupProfileLike = { id: 'bob', stripe_customer_id: 'cus_bob' };

function session(over: Partial<TopupSessionLike> = {}): TopupSessionLike {
  return {
    id: 'cs_1',
    mode: 'payment',
    payment_status: 'paid',
    customer: 'cus_alice',
    currency: 'usd',
    amount_total: 2900,
    payment_intent: 'pi_1',
    metadata: { purchase_type: TOPUP_PURCHASE_TYPE, supabase_user_id: 'alice' },
    ...over,
  };
}
const items = (qty = 1, price = PRICE): TopupLineItemLike[] => [{ price: { id: price }, quantity: qty }];

function makeDeps(opts: { expectedPriceId?: string | undefined; lineItems?: TopupLineItemLike[] } = {}) {
  const profiles = [ALICE, BOB];
  const balances = new Map<string, number>([['alice', 0], ['bob', 0]]);
  const sessions = new Map<string, CreditArgs>();
  const deps: TopupDeps = {
    expectedPriceId: 'expectedPriceId' in opts ? opts.expectedPriceId : PRICE,
    listLineItems: async () => opts.lineItems ?? items(1),
    findProfilesByCustomer: async (c) => profiles.filter((p) => p.stripe_customer_id === c),
    recordCredit: async (a) => {
      if (sessions.has(a.p_session_id)) return 'duplicate';
      sessions.set(a.p_session_id, a);
      if (a.p_status === 'credited' && a.p_user) balances.set(a.p_user, (balances.get(a.p_user) ?? 0) + a.p_minutes);
      return a.p_status === 'credited' ? 'credited' : 'rejected';
    },
    log: () => {},
  };
  return { deps, balances, sessions };
}

describe('parseTopupQuantity', () => {
  it('defaults to 1 and accepts 1..10', () => {
    expect(parseTopupQuantity(undefined)).toBe(1);
    expect(parseTopupQuantity(null)).toBe(1);
    expect(parseTopupQuantity(1)).toBe(1);
    expect(parseTopupQuantity(10)).toBe(10);
  });
  it('rejects everything else', () => {
    for (const bad of [0, -1, 11, 1.5, '2', Number.NaN, {}, [], true]) expect(parseTopupQuantity(bad)).toBeNull();
  });
  it('is 100 minutes per pack', () => {
    expect(topupMinutes(3)).toBe(300);
  });
});

describe('evaluateTopupSession', () => {
  const base = { lineItems: items(2), profiles: [ALICE], expectedPriceId: PRICE };
  it('accepts a paid pack for the right customer', () => {
    expect(evaluateTopupSession({ ...base, session: session() })).toEqual({ ok: true, userId: 'alice', quantity: 2, minutes: 200 });
  });
  it('rejects sessions that are not ours', () => {
    expect(isTopupSession({ mode: 'subscription', metadata: { purchase_type: TOPUP_PURCHASE_TYPE } })).toBe(false);
    expect(evaluateTopupSession({ ...base, session: session({ metadata: {} }) })).toEqual({ ok: false, reason: 'not_topup' });
  });
  it('rejects unpaid sessions', () => {
    expect(evaluateTopupSession({ ...base, session: session({ payment_status: 'unpaid' }) })).toEqual({ ok: false, reason: 'not_paid' });
  });
  it('rejects the wrong customer (metadata user is not the owner of the Stripe customer)', () => {
    const forged = session({ customer: 'cus_bob' });
    expect(evaluateTopupSession({ ...base, session: forged, profiles: [BOB] })).toEqual({ ok: false, reason: 'user_mismatch' });
  });
  it('rejects a customer id that does not match the profile row', () => {
    expect(evaluateTopupSession({ ...base, session: session({ customer: 'cus_other' }) })).toEqual({ ok: false, reason: 'customer_mismatch' });
  });
  it('rejects unknown and ambiguous customers', () => {
    expect(evaluateTopupSession({ ...base, session: session(), profiles: [] })).toEqual({ ok: false, reason: 'no_profile' });
    expect(evaluateTopupSession({ ...base, session: session(), profiles: [ALICE, BOB] })).toEqual({ ok: false, reason: 'ambiguous_profile' });
    expect(evaluateTopupSession({ ...base, session: session({ customer: null }) })).toEqual({ ok: false, reason: 'no_customer' });
  });
  it('rejects a missing user claim', () => {
    expect(evaluateTopupSession({ ...base, session: session({ metadata: { purchase_type: TOPUP_PURCHASE_TYPE } }) })).toEqual({ ok: false, reason: 'missing_user' });
  });
  it('rejects wrong price, foreign line items and absurd quantities', () => {
    expect(evaluateTopupSession({ ...base, session: session(), lineItems: items(1, 'price_other') })).toEqual({ ok: false, reason: 'unexpected_line_item' });
    expect(evaluateTopupSession({ ...base, session: session(), lineItems: [...items(1), { price: { id: 'price_x' }, quantity: 1 }] })).toEqual({ ok: false, reason: 'unexpected_line_item' });
    expect(evaluateTopupSession({ ...base, session: session(), lineItems: items(11) })).toEqual({ ok: false, reason: 'bad_quantity' });
    expect(evaluateTopupSession({ ...base, session: session(), lineItems: [] })).toEqual({ ok: false, reason: 'bad_quantity' });
  });
  it('rejects when the price env is not configured', () => {
    expect(evaluateTopupSession({ ...base, session: session(), expectedPriceId: undefined })).toEqual({ ok: false, reason: 'price_not_configured' });
  });
});

describe('processTopupSession', () => {
  it('credits 100 x quantity minutes', async () => {
    const { deps, balances } = makeDeps({ lineItems: items(3) });
    expect(await processTopupSession(session(), deps)).toEqual({ outcome: 'credited', minutes: 300 });
    expect(balances.get('alice')).toBe(300);
    expect(balances.get('bob')).toBe(0);
  });

  it('replaying the same webhook 3 times credits exactly once', async () => {
    const { deps, balances, sessions } = makeDeps();
    const a = await processTopupSession(session(), deps);
    const b = await processTopupSession(session(), deps);
    const c = await processTopupSession(session(), deps);
    expect(a.outcome).toBe('credited');
    expect(b.outcome).toBe('duplicate');
    expect(c.outcome).toBe('duplicate');
    expect(balances.get('alice')).toBe(100);
    expect(sessions.size).toBe(1);
  });

  it('different sessions credit independently', async () => {
    const { deps, balances } = makeDeps();
    await processTopupSession(session({ id: 'cs_a' }), deps);
    await processTopupSession(session({ id: 'cs_b' }), deps);
    expect(balances.get('alice')).toBe(200);
  });

  it('wrong-customer sessions credit nobody and are recorded as rejected', async () => {
    const { deps, balances, sessions } = makeDeps();
    // metadata says alice, but the paying Stripe customer is bob's
    const out = await processTopupSession(session({ customer: 'cus_bob' }), deps);
    expect(out).toEqual({ outcome: 'rejected', reason: 'user_mismatch' });
    expect(balances.get('alice')).toBe(0);
    expect(balances.get('bob')).toBe(0);
    expect(sessions.get('cs_1')?.p_status).toBe('rejected');
    expect(sessions.get('cs_1')?.p_minutes).toBe(0);
  });

  it('waits for async payment methods instead of crediting early', async () => {
    const { deps, balances, sessions } = makeDeps();
    expect(await processTopupSession(session({ payment_status: 'unpaid' }), deps)).toEqual({ outcome: 'pending_payment' });
    expect(balances.get('alice')).toBe(0);
    expect(sessions.size).toBe(0);
    // the later async_payment_succeeded event (paid) credits once
    expect((await processTopupSession(session(), deps)).outcome).toBe('credited');
    expect(balances.get('alice')).toBe(100);
  });

  it('ignores subscription checkouts', async () => {
    const { deps } = makeDeps();
    expect(await processTopupSession(session({ mode: 'subscription' }), deps)).toEqual({ outcome: 'ignored' });
  });

  it('throws (so Stripe retries) when the price is not configured, never rejecting a paid session', async () => {
    const { deps, sessions } = makeDeps({ expectedPriceId: undefined });
    await expect(processTopupSession(session(), deps)).rejects.toThrow();
    expect(sessions.size).toBe(0);
  });
});

/** In-memory mirror of reverse_topup(): cumulative, idempotent, floors at the available balance. */
function makeReversalWorld(opts: { minutes?: number; amountCents?: number; bonus?: number } = {}) {
  const row = { minutes: opts.minutes ?? 100, amount: opts.amountCents ?? 2900, reversed: 0, shortfall: 0 };
  const state = { bonus: opts.bonus ?? 100 };
  const deps = {
    reverse: async (a: ReverseArgs) => {
      if (a.p_payment_intent !== 'pi_1') return 'not_topup' as const;
      const target = a.p_refunded_cents >= row.amount ? row.minutes : Math.min(row.minutes, Math.floor((row.minutes * a.p_refunded_cents) / row.amount));
      const delta = target - row.reversed;
      if (delta <= 0) return 'noop' as const;
      const take = Math.min(state.bonus, delta);
      state.bonus -= take;
      row.reversed = target;
      row.shortfall += delta - take;
      return 'reversed' as const;
    },
    log: () => {},
  };
  return { row, state, deps };
}

describe('processTopupReversal', () => {
  it('claws back the full pack on a full refund, once, even if replayed 3 times', async () => {
    const { deps, state, row } = makeReversalWorld();
    const input = { paymentIntentId: 'pi_1', cumulativeAmountCents: 2900, reason: 'refund' as const };
    expect((await processTopupReversal(input, deps)).outcome).toBe('reversed');
    expect((await processTopupReversal(input, deps)).outcome).toBe('noop');
    expect((await processTopupReversal(input, deps)).outcome).toBe('noop');
    expect(state.bonus).toBe(0);
    expect(row.reversed).toBe(100);
  });
  it('handles a partial refund and then a full one without double counting', async () => {
    const { deps, state } = makeReversalWorld();
    await processTopupReversal({ paymentIntentId: 'pi_1', cumulativeAmountCents: 1450, reason: 'refund' }, deps);
    expect(state.bonus).toBe(50);
    await processTopupReversal({ paymentIntentId: 'pi_1', cumulativeAmountCents: 2900, reason: 'refund' }, deps);
    expect(state.bonus).toBe(0);
  });
  it('floors at zero and records the shortfall when the minutes were already spent', async () => {
    const { deps, state, row } = makeReversalWorld({ bonus: 30 });
    await processTopupReversal({ paymentIntentId: 'pi_1', cumulativeAmountCents: 2900, reason: 'dispute' }, deps);
    expect(state.bonus).toBe(0);
    expect(row.shortfall).toBe(70);
  });
  it('ignores charges that are not top-ups and invalid input', async () => {
    const { deps, state } = makeReversalWorld();
    expect(await processTopupReversal({ paymentIntentId: 'pi_other', cumulativeAmountCents: 2900, reason: 'refund' }, deps)).toEqual({ outcome: 'not_topup' });
    expect(await processTopupReversal({ paymentIntentId: null, cumulativeAmountCents: 2900, reason: 'refund' }, deps)).toEqual({ outcome: 'ignored', reason: 'no_payment_intent' });
    expect(await processTopupReversal({ paymentIntentId: 'pi_1', cumulativeAmountCents: 0, reason: 'refund' }, deps)).toEqual({ outcome: 'ignored', reason: 'bad_amount' });
    expect(state.bonus).toBe(100);
  });
});
