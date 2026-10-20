import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

import {
  acceptErrorMessage,
  acceptQuoteWithAddons,
  addonsForOption,
  addonTotals,
  createOptionalItem,
  fetchQuoteAddons,
  grandTotalCents,
  MAX_OPTIONAL_ITEMS,
  normaliseOptionalItems,
  parsePublicAddons,
  reconcileSelection,
  validateOptionalItems,
  type PublicQuoteAddon,
  type QuoteOptionalItem,
} from './quoteAddons';

const addon = (id: string, price: number, over: Partial<PublicQuoteAddon> = {}): PublicQuoteAddon => ({
  id,
  name: id,
  description: '',
  quantity: 1,
  unit_price_cents: price,
  option_ids: [],
  ...over,
});

const item = (over: Partial<QuoteOptionalItem> = {}): QuoteOptionalItem => ({
  ...createOptionalItem({ name: 'Extended warranty' }),
  unit_price_cents: 14_900,
  ...over,
});

beforeEach(() => rpc.mockReset());

describe('normaliseOptionalItems', () => {
  it('returns [] for anything that is not an array', () => {
    expect(normaliseOptionalItems(null)).toEqual([]);
    expect(normaliseOptionalItems({})).toEqual([]);
    expect(normaliseOptionalItems('x')).toEqual([]);
  });

  it('trims, clamps and drops blank or malformed rows', () => {
    const out = normaliseOptionalItems([
      { id: 'a', name: '  Surge protector  ', description: ' d ', quantity: 500, unit_price_cents: -5.4 },
      { id: 'b', name: '   ' },
      null,
      'junk',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'a', name: 'Surge protector', description: 'd', quantity: 99, unit_price_cents: 0 });
  });

  it('re-ids duplicates, de-dupes option ids and caps the list', () => {
    const dup = normaliseOptionalItems([
      { id: 'x', name: 'One', option_ids: ['o1', 'o1', 3] },
      { id: 'x', name: 'Two' },
    ]);
    expect(dup[0].option_ids).toEqual(['o1']);
    expect(new Set(dup.map((d) => d.id)).size).toBe(2);

    const many = normaliseOptionalItems(Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, name: `N${i}` })));
    expect(many).toHaveLength(MAX_OPTIONAL_ITEMS);
  });
});

describe('parsePublicAddons', () => {
  it('never exposes the internal part link', () => {
    const [a] = parsePublicAddons([{ id: 'a', name: 'Filter', unit_price_cents: 4500, part_id: 'secret' }]);
    expect(a).not.toHaveProperty('part_id');
    expect(a.unit_price_cents).toBe(4500);
  });
});

describe('validateOptionalItems', () => {
  it('accepts a good add-on', () => {
    expect(validateOptionalItems([item()], [])).toEqual([]);
  });

  it('ignores blank rows (they are dropped on save)', () => {
    expect(validateOptionalItems([createOptionalItem()], [])).toEqual([]);
  });

  it('rejects free add-ons and bad quantities', () => {
    const errors = validateOptionalItems([item({ unit_price_cents: 0 }), item({ quantity: 0 })], []);
    expect(errors).toHaveLength(2);
  });

  it('rejects add-ons limited to an option that was removed', () => {
    expect(validateOptionalItems([item({ option_ids: ['gone'] })], ['o1'])).toHaveLength(1);
    expect(validateOptionalItems([item({ option_ids: ['o1'] })], ['o1'])).toEqual([]);
  });
});

describe('option scoping + selection', () => {
  const all = addon('all', 100);
  const better = addon('better', 200, { option_ids: ['opt-better'] });

  it('offers unscoped add-ons everywhere and scoped ones only with their option', () => {
    expect(addonsForOption([all, better], 'opt-good').map((a) => a.id)).toEqual(['all']);
    expect(addonsForOption([all, better], 'opt-better').map((a) => a.id)).toEqual(['all', 'better']);
    expect(addonsForOption([all, better], null).map((a) => a.id)).toEqual(['all']);
  });

  it('drops selected ids that are no longer on offer after switching option', () => {
    expect(reconcileSelection(['all', 'better', 'ghost'], addonsForOption([all, better], 'opt-good'))).toEqual(['all']);
  });
});

describe('addonTotals — mirrors the server', () => {
  it('is zero with nothing selected', () => {
    expect(addonTotals([addon('a', 5000)], [], 8)).toEqual({ count: 0, subtotalCents: 0, taxCents: 0, totalCents: 0 });
  });

  it('sums quantity × price and taxes the add-on subtotal once', () => {
    const list = [addon('a', 14_900), addon('b', 2_500, { quantity: 2 }), addon('c', 9_999)];
    const t = addonTotals(list, ['a', 'b'], 8.25);
    expect(t.subtotalCents).toBe(19_900);
    expect(t.taxCents).toBe(1_642); // 1641.75 → 1642
    expect(t.totalCents).toBe(21_542);
    expect(t.count).toBe(2);
  });

  it('ignores selected ids that are not in the list', () => {
    expect(addonTotals([addon('a', 1000)], ['nope'], 10).totalCents).toBe(0);
  });

  it('adds onto the base total', () => {
    const t = addonTotals([addon('a', 10_000)], ['a'], 0);
    expect(grandTotalCents(120_000, t)).toBe(130_000);
  });
});

describe('API', () => {
  it('fetchQuoteAddons returns [] when the RPC errors (migration not applied)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'function does not exist' } });
    await expect(fetchQuoteAddons('tok')).resolves.toEqual([]);
  });

  it('fetchQuoteAddons parses the payload', async () => {
    rpc.mockResolvedValue({ data: [{ id: 'a', name: 'Filter', quantity: 1, unit_price_cents: 4500, option_ids: [] }], error: null });
    const out = await fetchQuoteAddons('tok');
    expect(rpc).toHaveBeenCalledWith('get_quote_optional_items_for_token', { p_token: 'tok' });
    expect(out).toHaveLength(1);
  });

  it('acceptQuoteWithAddons sends ids only, de-duplicated', async () => {
    rpc.mockResolvedValue({ data: { accepted: true, addons_total_cents: 4500, total_cents: 124_500 }, error: null });
    const res = await acceptQuoteWithAddons('tok', 'opt', ['a', 'a', 'b']);
    expect(rpc).toHaveBeenCalledWith('accept_quote_with_addons_by_token', {
      p_token: 'tok',
      p_option_id: 'opt',
      p_item_ids: ['a', 'b'],
    });
    expect(res).toEqual({ ok: true, addonsTotalCents: 4500, totalCents: 124_500 });
  });

  it('maps server refusals and transport errors to typed reasons', async () => {
    rpc.mockResolvedValueOnce({ data: { accepted: false, reason: 'invalid_items' }, error: null });
    expect(await acceptQuoteWithAddons('t', null, ['a'])).toEqual({ ok: false, reason: 'invalid_items' });

    rpc.mockResolvedValueOnce({ data: { accepted: false, reason: 'unavailable' }, error: null });
    expect(await acceptQuoteWithAddons('t', null, ['a'])).toEqual({ ok: false, reason: 'unavailable' });

    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    expect(await acceptQuoteWithAddons('t', null, ['a'])).toEqual({ ok: false, reason: 'error' });

    rpc.mockRejectedValueOnce(new Error('network'));
    expect(await acceptQuoteWithAddons('t', null, ['a'])).toEqual({ ok: false, reason: 'error' });
  });

  it('has a human message for every reason', () => {
    for (const r of ['invalid_items', 'unavailable', 'error'] as const) expect(acceptErrorMessage(r).length).toBeGreaterThan(10);
  });
});
