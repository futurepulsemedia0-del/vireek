import { describe, it, expect } from 'vitest';
import {
  buildTextChannelContext,
  chooseState,
  figuresToLookupItems,
  isPriceAsk,
  matchPolicy,
  rowToPolicy,
  stripMoney,
  type PricePolicyRow,
} from './policy';
import { auditReply, composeFirstReply, resolvePriceAnswer, type PricePolicy } from './engine';

const row = (over: Partial<PricePolicyRow> = {}): PricePolicyRow => ({
  service_key: 'ac_repair',
  display_name: 'AC repair',
  trade: 'hvac',
  mode: 'range',
  keywords: ['air conditioner', 'ac not cooling'],
  source_kind: 'owner_entered',
  price_book_item_id: null,
  amount_low_cents: 20000,
  amount_high_cents: 40000,
  diagnostic_fee_cents: null,
  fee_credited_on_repair: false,
  written_price_before_work: false,
  includes: null,
  changes_price: null,
  verified_at: '2028-03-20T00:00:00Z',
  approved_states: ['TX'],
  legal_review_status: 'approved',
  active: true,
  ...over,
});

describe('isPriceAsk', () => {
  it.each(['how much to fix my AC?', 'What do you charge', 'can I get a quote', 'someone quoted me $200', 'ballpark?', 'is there a service fee'])('detects: %s', (t) => {
    expect(isPriceAsk(t)).toBe(true);
  });
  it.each(['my ac is broken', 'what time do you open', 'thanks!'])('ignores: %s', (t) => {
    expect(isPriceAsk(t)).toBe(false);
  });
});

describe('matchPolicy', () => {
  const rows = [row(), row({ service_key: 'ac_install', display_name: 'AC installation', keywords: ['new air conditioner'] }), row({ service_key: 'drain', display_name: 'Drain cleaning', keywords: null })];
  it('matches exact and keyword containment', () => {
    expect(matchPolicy(rows, 'AC repair')?.service_key).toBe('ac_repair');
    expect(matchPolicy(rows, 'my ac not cooling since monday, how much?')?.service_key).toBe('ac_repair');
    expect(matchPolicy(rows, 'drain cleaning price')?.service_key).toBe('drain');
  });
  it('prefers the most specific (longest) name', () => {
    expect(matchPolicy(rows, 'I want a new air conditioner, how much?')?.service_key).toBe('ac_install');
  });
  it('returns null with no match, empty needle or short noise', () => {
    expect(matchPolicy(rows, 'roof leak')).toBeNull();
    expect(matchPolicy(rows, '  ')).toBeNull();
    expect(matchPolicy([], 'ac repair')).toBeNull();
  });
  it('is deterministic on ties', () => {
    const a = row({ service_key: 'b_key', display_name: 'Same name', keywords: [] });
    const b = row({ service_key: 'a_key', display_name: 'Same name', keywords: [] });
    expect(matchPolicy([a, b], 'same name')?.service_key).toBe('a_key');
    expect(matchPolicy([b, a], 'same name')?.service_key).toBe('a_key');
  });
});

describe('chooseState', () => {
  it('uses explicit/address, ignores phone-only, falls back to business state', () => {
    expect(chooseState({ state: 'CA', basis: 'explicit' }, 'TX')).toBe('CA');
    expect(chooseState({ state: 'CA', basis: 'address' }, 'TX')).toBe('CA');
    expect(chooseState({ state: 'CA', basis: 'phone' }, 'TX')).toBe('TX');
    expect(chooseState({ state: null, basis: 'unknown' }, null)).toBeNull();
    expect(chooseState({ state: null, basis: 'unknown' }, 'texas')).toBeNull();
  });
});

describe('rowToPolicy + engine', () => {
  it('coerces unknown trades and null arrays', () => {
    const p = rowToPolicy(row({ trade: 'astrology' }));
    expect(p.trade).toBe('general');
    expect(p.includes).toEqual([]);
  });
});

describe('figuresToLookupItems', () => {
  const now = new Date('2028-04-01T00:00:00Z');
  const a = (over: Partial<PricePolicyRow>) => resolvePriceAnswer(rowToPolicy(row(over)), { state: 'TX', now });
  it('maps a range to ONE range item', () => {
    const items = figuresToLookupItems('AC repair', a({}).figures);
    expect(items).toEqual([{ service_name: 'AC repair', pricing_model: 'range', price_cents: 20000, price_max_cents: 40000 }]);
  });
  it('maps flat + diagnostic fee to flat items, starting_at to starting_at', () => {
    const flat = figuresToLookupItems('x', a({ mode: 'exact_flat', diagnostic_fee_cents: 8900 }).figures);
    expect(flat.map((i) => [i.pricing_model, i.price_cents])).toEqual([['flat', 20000], ['flat', 8900]]);
    expect(figuresToLookupItems('x', a({ mode: 'starting_at' }).figures)[0].pricing_model).toBe('starting_at');
  });
  it('returns nothing when no figure was spoken', () => {
    expect(figuresToLookupItems('x', a({ active: false }).figures)).toEqual([]);
  });
});

describe('text channels', () => {
  it('strips KB dollar amounts', () => {
    expect(stripMoney('Repairs are $199 or 250 dollars, call us')).toBe('Repairs are [amount] or [amount], call us');
  });
  it('approved context carries the answer, forbids other amounts, includes questions', () => {
    const p: PricePolicy = rowToPolicy(row());
    const r = composeFirstReply(p, { state: 'TX', now: new Date('2028-04-01T00:00:00Z') }, 'sms');
    const ctx = buildTextChannelContext(r.answer, r.questions);
    expect(ctx).toContain('APPROVED PRICE ANSWER');
    expect(ctx).toContain('$200');
    expect(ctx).toContain('Do not state any other dollar amount');
    expect(ctx).toContain('(1)');
    expect(auditReply(r.text, r.answer, { licensed_techs: false, warranty_months: null, on_time_guarantee: false })).toEqual([]);
  });
});
