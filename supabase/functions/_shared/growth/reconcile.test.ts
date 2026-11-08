import { describe, it, expect } from 'vitest';
import { reconcile, stripeMrrCents, type FactLatest, type StripeSubLite } from './reconcile';

const sub = (o: Partial<StripeSubLite> = {}): StripeSubLite => ({
  id: 'sub_1', status: 'active', currency: 'usd', interval: 'month', intervalCount: 1, unitAmount: 10_000, quantity: 1,
  percentOffForever: null, hasOtherDiscount: false, ...o,
});
const fact = (o: Partial<FactLatest> = {}): FactLatest => ({
  stripe_subscription_id: 'sub_1', status: 'active', mrr_cents: 10_000, currency: 'usd', discount_unresolved: false, ...o,
});

describe('stripeMrrCents (mirrors growth_mrr_cents in SQL)', () => {
  it('monthly', () => expect(stripeMrrCents(sub())).toBe(10_000));
  it('yearly / 12', () => expect(stripeMrrCents(sub({ interval: 'year', unitAmount: 120_000 }))).toBe(10_000));
  it('quantity multiplies', () => expect(stripeMrrCents(sub({ quantity: 3 }))).toBe(30_000));
  it('interval_count divides (every 3 months)', () => expect(stripeMrrCents(sub({ intervalCount: 3, unitAmount: 30_000 }))).toBe(10_000));
  it('forever percent coupon applies', () => expect(stripeMrrCents(sub({ percentOffForever: 25 }))).toBe(7_500));
  it('trialing / canceled / unpaid count as 0', () => {
    for (const status of ['trialing', 'canceled', 'unpaid', 'incomplete', 'paused']) expect(stripeMrrCents(sub({ status }))).toBe(0);
  });
  it('past_due still counts', () => expect(stripeMrrCents(sub({ status: 'past_due' }))).toBe(10_000));
  it('weekly interval is unsupported => 0', () => expect(stripeMrrCents(sub({ interval: 'week' }))).toBe(0));
  it('rounds half away like SQL round()', () => expect(stripeMrrCents(sub({ unitAmount: 1001, interval: 'year' }))).toBe(83));
});

describe('reconcile', () => {
  it('perfect match has no mismatches and equal totals', () => {
    const r = reconcile([sub()], [fact()], true);
    expect(r.mismatches).toHaveLength(0);
    expect(r.totals.usd.stripe_mrr_cents).toBe(10_000);
    expect(r.totals.usd.facts_mrr_cents).toBe(10_000);
  });
  it('detects a subscription Stripe has but facts lack (missed webhook)', () => {
    const r = reconcile([sub()], [], true);
    expect(r.mismatches[0].kind).toBe('missing_in_facts');
    expect(r.unexplained).toBe(1);
  });
  it('ignores long-dead subscriptions with no facts', () => {
    expect(reconcile([sub({ status: 'canceled' })], [], true).mismatches).toHaveLength(0);
  });
  it('detects stale status', () => {
    const r = reconcile([sub({ status: 'canceled' })], [fact()], true);
    expect(r.mismatches[0].kind).toBe('status_mismatch');
  });
  it('detects MRR drift', () => {
    const r = reconcile([sub({ unitAmount: 20_000 })], [fact()], true);
    expect(r.mismatches[0].kind).toBe('mrr_mismatch');
    expect(r.unexplained).toBe(1);
  });
  it('MRR drift with an unapplied discount is explained, not unexplained', () => {
    const r = reconcile([sub({ hasOtherDiscount: true })], [fact({ mrr_cents: 9_000 })], true);
    expect(r.mismatches[0].explained_by_discount).toBe(true);
    expect(r.unexplained).toBe(0);
  });
  it('facts paying but absent from Stripe are flagged only when the list is complete', () => {
    expect(reconcile([], [fact()], true).mismatches[0].kind).toBe('missing_in_stripe');
    expect(reconcile([], [fact()], false).mismatches).toHaveLength(0);
  });
  it('totals are per currency (no mixing)', () => {
    const r = reconcile([sub(), sub({ id: 'sub_2', currency: 'eur', unitAmount: 5_000 })], [fact(), fact({ stripe_subscription_id: 'sub_2', currency: 'eur', mrr_cents: 5_000 })], true);
    expect(r.totals.usd.stripe_mrr_cents).toBe(10_000);
    expect(r.totals.eur.stripe_mrr_cents).toBe(5_000);
  });
});
