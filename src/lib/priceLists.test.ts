import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_PRICING_CONTEXT,
  applyAdjustment,
  emptyPriceListForm,
  findConflictingListIds,
  formToListPayload,
  getListState,
  isEndingSoon,
  parseAdjustmentValue,
  resolvePrice,
  resolvePrices,
  type PriceList,
  type PriceListItem,
  type PricingContext,
} from '@/lib/priceLists';
import type { PriceBookItem } from '@/lib/priceBook';

// Pure-helper tests: no Supabase client or env needed.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const OWNER = 'owner-1';
const ON = '2027-04-15';

const book = (id: string, price: number, extra: Partial<PriceBookItem> = {}): PriceBookItem => ({
  id,
  user_id: OWNER,
  service_name: id,
  category: null,
  pricing_model: 'flat',
  price_cents: price,
  price_max_cents: null,
  cost_cents: null,
  unit_label: null,
  keywords: [],
  description: null,
  active: true,
  sort_order: 0,
  source: 'manual',
  external_id: null,
  synced_at: null,
  created_at: '2027-01-01T00:00:00Z',
  updated_at: '2027-01-01T00:00:00Z',
  ...extra,
});

const list = (id: string, extra: Partial<PriceList> = {}): PriceList => ({
  id,
  account_owner_id: OWNER,
  name: id,
  description: null,
  scope: 'customer',
  tier: null,
  customer_id: 'cust-1',
  contract_id: null,
  membership_plan_id: null,
  priority: 0,
  status: 'active',
  effective_from: '2027-01-01',
  effective_to: null,
  created_at: '2027-01-01T00:00:00Z',
  updated_at: '2027-01-01T00:00:00Z',
  ...extra,
});

const li = (listId: string, itemId: string, type: PriceListItem['adjustment_type'], value: number): PriceListItem => ({
  id: `${listId}:${itemId}`,
  account_owner_id: OWNER,
  price_list_id: listId,
  price_book_item_id: itemId,
  adjustment_type: type,
  value,
  created_at: '2027-01-01T00:00:00Z',
  updated_at: '2027-01-01T00:00:00Z',
});

const ctx = (extra: Partial<PricingContext> = {}): PricingContext => ({ ...EMPTY_PRICING_CONTEXT, customerId: 'cust-1', ...extra });

describe('applyAdjustment', () => {
  it('applies each adjustment type and never goes below zero', () => {
    const base = { price_cents: 10_000, price_max_cents: null };
    expect(applyAdjustment(base, 'fixed', 8_500).price_cents).toBe(8_500);
    expect(applyAdjustment(base, 'percent_off', 15).price_cents).toBe(8_500);
    expect(applyAdjustment(base, 'percent_up', 10).price_cents).toBe(11_000);
    expect(applyAdjustment(base, 'amount_off', 2_500).price_cents).toBe(7_500);
    expect(applyAdjustment(base, 'amount_off', 99_999).price_cents).toBe(0);
  });

  it('keeps range items consistent (max never below min)', () => {
    const range = { price_cents: 10_000, price_max_cents: 20_000 };
    expect(applyAdjustment(range, 'percent_off', 10)).toEqual({ price_cents: 9_000, price_max_cents: 18_000 });
    expect(applyAdjustment(range, 'fixed', 12_000)).toEqual({ price_cents: 12_000, price_max_cents: 12_000 });
    const clamped = applyAdjustment(range, 'amount_off', 15_000);
    expect(clamped.price_max_cents as number).toBeGreaterThanOrEqual(clamped.price_cents);
  });
});

describe('list state and effective dates', () => {
  it('derives the state from status and dates (inclusive bounds)', () => {
    expect(getListState(list('a', { status: 'draft' }), ON)).toBe('draft');
    expect(getListState(list('a', { status: 'archived' }), ON)).toBe('archived');
    expect(getListState(list('a', { effective_from: '2027-05-01' }), ON)).toBe('scheduled');
    expect(getListState(list('a', { effective_to: '2027-04-14' }), ON)).toBe('expired');
    expect(getListState(list('a', { effective_to: ON }), ON)).toBe('active');
    expect(getListState(list('a', { effective_from: ON }), ON)).toBe('active');
  });

  it('flags lists ending within the warning window', () => {
    expect(isEndingSoon(list('a', { effective_to: '2027-05-01' }), ON)).toBe(true);
    expect(isEndingSoon(list('a', { effective_to: '2027-12-31' }), ON)).toBe(false);
    expect(isEndingSoon(list('a'), ON)).toBe(false);
  });
});

describe('resolvePrice', () => {
  const item = book('drain', 20_000, { cost_cents: 9_000 });

  it('falls back to the price book when nothing applies', () => {
    const r = resolvePrice(item, [], [], ctx(), ON);
    expect(r.source).toBe('price_book');
    expect(r.price_cents).toBe(20_000);
    expect(r.list).toBeNull();
  });

  it('applies a customer list inside its window only', () => {
    const lists = [list('L1', { effective_from: '2027-04-01', effective_to: '2027-04-30' })];
    const items = [li('L1', 'drain', 'percent_off', 10)];
    expect(resolvePrice(item, lists, items, ctx(), ON).price_cents).toBe(18_000);
    expect(resolvePrice(item, lists, items, ctx(), '2027-05-01').source).toBe('price_book');
    expect(resolvePrice(item, lists, items, ctx(), '2027-03-31').source).toBe('price_book');
  });

  it('ignores draft and archived lists and lists for other customers', () => {
    const items = [li('L1', 'drain', 'fixed', 100), li('L2', 'drain', 'fixed', 100), li('L3', 'drain', 'fixed', 100)];
    const lists = [
      list('L1', { status: 'draft' }),
      list('L2', { status: 'archived' }),
      list('L3', { customer_id: 'someone-else' }),
    ];
    expect(resolvePrice(item, lists, items, ctx(), ON).source).toBe('price_book');
  });

  it('prefers contract over customer over tier, regardless of priority', () => {
    const lists = [
      list('tier', { scope: 'tier', tier: 'commercial', customer_id: null, priority: 1000 }),
      list('cust', { priority: 500 }),
      list('contract', { scope: 'contract', customer_id: null, contract_id: 'k1', priority: 0 }),
    ];
    const items = [li('tier', 'drain', 'fixed', 15_000), li('cust', 'drain', 'fixed', 16_000), li('contract', 'drain', 'fixed', 17_000)];
    const full = ctx({ customerType: 'commercial', contractIds: ['k1'] });
    expect(resolvePrice(item, lists, items, full, ON).list?.id).toBe('contract');
    expect(resolvePrice(item, lists.slice(0, 2), items, full, ON).list?.id).toBe('cust');
    expect(resolvePrice(item, lists.slice(0, 1), items, full, ON).list?.id).toBe('tier');
  });

  it('uses priority, then newest effective_from, within the same scope', () => {
    const items = [li('a', 'drain', 'fixed', 1_000), li('b', 'drain', 'fixed', 2_000), li('c', 'drain', 'fixed', 3_000)];
    const lists = [
      list('a', { priority: 1 }),
      list('b', { priority: 5 }),
      list('c', { priority: 5, effective_from: '2027-03-01' }),
    ];
    expect(resolvePrice(item, lists, items, ctx(), ON).list?.id).toBe('c');
  });

  it('falls through to a lower-ranked list when the higher one has no override for that service', () => {
    const lists = [list('cust'), list('tier', { scope: 'tier', tier: 'commercial', customer_id: null })];
    const items = [li('cust', 'other', 'fixed', 1), li('tier', 'drain', 'percent_off', 20)];
    const r = resolvePrice(item, lists, items, ctx({ customerType: 'commercial' }), ON);
    expect(r.list?.id).toBe('tier');
    expect(r.price_cents).toBe(16_000);
    expect(r.savings_cents).toBe(4_000);
  });

  it('matches tiers: commercial, contractor tag, and membership (any plan or a specific plan)', () => {
    const items = [li('c', 'drain', 'fixed', 1), li('k', 'drain', 'fixed', 2), li('m', 'drain', 'fixed', 3), li('mp', 'drain', 'fixed', 4)];
    const lists = [
      list('c', { scope: 'tier', tier: 'commercial', customer_id: null }),
      list('k', { scope: 'tier', tier: 'contractor', customer_id: null }),
      list('m', { scope: 'tier', tier: 'membership', customer_id: null }),
      list('mp', { scope: 'tier', tier: 'membership', customer_id: null, membership_plan_id: 'gold', priority: 9 }),
    ];
    const at = (extra: Partial<PricingContext>) => resolvePrice(item, lists, items, ctx(extra), ON).list?.id ?? null;

    expect(at({ customerType: 'commercial' })).toBe('c');
    expect(at({ customerTags: [' Contractor '] })).toBe('k');
    expect(at({ activeMembershipPlanIds: ['silver'] })).toBe('m');
    expect(at({ activeMembershipPlanIds: ['gold'] })).toBe('mp');
    expect(at({ activeMembershipPlanIds: [] })).toBeNull();
    expect(at({ customerType: 'residential' })).toBeNull();
  });

  it('flags a resolved price that is under cost', () => {
    const lists = [list('L1')];
    expect(resolvePrice(item, lists, [li('L1', 'drain', 'fixed', 8_000)], ctx(), ON).below_cost).toBe(true);
    expect(resolvePrice(item, lists, [li('L1', 'drain', 'fixed', 9_000)], ctx(), ON).below_cost).toBe(false);
    expect(resolvePrice(book('free', 100), lists, [], ctx(), ON).below_cost).toBe(false);
  });

  it('resolves many items in one pass', () => {
    const items = [book('a', 1_000), book('b', 2_000)];
    const out = resolvePrices(items, [list('L1')], [li('L1', 'a', 'percent_up', 50)], ctx(), ON);
    expect(out.get('a')?.price_cents).toBe(1_500);
    expect(out.get('b')?.source).toBe('price_book');
  });
});

describe('findConflictingListIds', () => {
  it('flags same-target, same-priority lists with overlapping windows', () => {
    const lists = [
      list('a', { effective_to: '2027-06-30' }),
      list('b', { effective_from: '2027-06-01' }),
      list('c', { effective_from: '2027-07-01', effective_to: '2027-12-31', priority: 0, customer_id: 'cust-2' }),
    ];
    expect([...findConflictingListIds(lists)].sort()).toEqual(['a', 'b']);
  });

  it('does not flag different priorities, disjoint windows, or inactive lists', () => {
    expect(findConflictingListIds([list('a', { priority: 1 }), list('b', { priority: 2 })]).size).toBe(0);
    expect(findConflictingListIds([list('a', { effective_to: '2027-02-01' }), list('b', { effective_from: '2027-03-01' })]).size).toBe(0);
    expect(findConflictingListIds([list('a'), list('b', { status: 'draft' })]).size).toBe(0);
  });
});

describe('validation', () => {
  const valid = () => ({ ...emptyPriceListForm(), name: ' Acme HVAC ', customer_id: 'cust-1', effective_from: '2027-04-01' });

  it('builds a clean payload scoped to the account owner', () => {
    const p = formToListPayload(valid(), OWNER);
    expect(p).toMatchObject({ account_owner_id: OWNER, name: 'Acme HVAC', scope: 'customer', customer_id: 'cust-1', contract_id: null, tier: null, effective_to: null });
  });

  it('clears fields that do not belong to the chosen scope', () => {
    const p = formToListPayload({ ...valid(), scope: 'tier', tier: 'membership', membership_plan_id: 'gold', customer_id: 'stale' }, OWNER);
    expect(p).toMatchObject({ scope: 'tier', tier: 'membership', membership_plan_id: 'gold', customer_id: null, contract_id: null });
    expect(formToListPayload({ ...valid(), scope: 'tier', tier: 'commercial', membership_plan_id: 'gold' }, OWNER).membership_plan_id).toBeNull();
  });

  it('rejects bad input', () => {
    expect(() => formToListPayload({ ...valid(), name: '  ' }, OWNER)).toThrow();
    expect(() => formToListPayload({ ...valid(), customer_id: '' }, OWNER)).toThrow(/customer/i);
    expect(() => formToListPayload({ ...valid(), scope: 'contract', contract_id: '' }, OWNER)).toThrow(/contract/i);
    expect(() => formToListPayload({ ...valid(), effective_to: '2027-03-01' }, OWNER)).toThrow(/end date/i);
    expect(() => formToListPayload({ ...valid(), effective_from: '2027-02-30' }, OWNER)).toThrow(/start date/i);
    expect(() => formToListPayload({ ...valid(), priority: '1.5' }, OWNER)).toThrow(/priority/i);
  });

  it('parses adjustment values (dollars → cents, percent bounds)', () => {
    expect(parseAdjustmentValue('fixed', '85.5')).toBe(8_550);
    expect(parseAdjustmentValue('amount_off', '25')).toBe(2_500);
    expect(parseAdjustmentValue('percent_off', '12.5')).toBe(12.5);
    expect(() => parseAdjustmentValue('percent_off', '101')).toThrow();
    expect(() => parseAdjustmentValue('percent_up', '501')).toThrow();
    expect(() => parseAdjustmentValue('fixed', '')).toThrow();
    expect(() => parseAdjustmentValue('fixed', '-1')).toThrow();
  });
});
