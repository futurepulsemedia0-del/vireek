import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  addMonthsStart,
  bookValue,
  buildSchedule,
  canDeleteAsset,
  centsToInput,
  describeEvent,
  disposalPreview,
  draftFromAsset,
  draftToSchedule,
  emptyDraft,
  filterAssets,
  formatDay,
  formatLife,
  formatMonth,
  isIsoDate,
  monthEndOf,
  parseCents,
  summarizeAssets,
  summarizeSchedule,
  termsLockReason,
  validateAssetDraft,
  validateDisposal,
  type AssetDraft,
  type AssetEvent,
  type FixedAsset,
} from './fixedAssets';

const asset = (over: Partial<FixedAsset> & Pick<FixedAsset, 'id'>): FixedAsset => ({
  asset_tag: `FA-${over.id}`,
  name: `Asset ${over.id}`,
  category: 'equipment',
  description: null,
  serial_number: null,
  location: null,
  vehicle_id: null,
  acquisition_date: '2027-01-05',
  in_service_date: '2027-01-05',
  cost_cents: 120000,
  salvage_cents: 0,
  useful_life_months: 12,
  method: 'straight_line',
  status: 'active',
  asset_account_id: 'a1',
  accumulated_account_id: 'a2',
  expense_account_id: 'e1',
  acquisition_entry_id: null,
  disposed_on: null,
  disposal_proceeds_cents: null,
  disposal_gain_loss_cents: null,
  notes: null,
  created_at: '2027-01-05T00:00:00Z',
  accumulated_cents: 0,
  posted_months: 0,
  scheduled_months: 12,
  next_period_start: '2027-01-01',
  next_amount_cents: 10000,
  ...over,
});

const accounts = [
  { id: 'a1', type: 'asset' as const },
  { id: 'a2', type: 'asset' as const },
  { id: 'e1', type: 'expense' as const },
  { id: 'cash', type: 'asset' as const },
];

const goodDraft = (over: Partial<AssetDraft> = {}): AssetDraft => ({
  ...emptyDraft('2027-03-01', { asset_account_id: 'a1', accumulated_account_id: 'a2', expense_account_id: 'e1' }),
  name: 'Service van',
  category: 'vehicle',
  cost: '42,500.00',
  salvage: '5000',
  lifeMonths: '60',
  ...over,
});

const sum = (xs: { amount_cents: number }[]) => xs.reduce((s, l) => s + l.amount_cents, 0);

describe('money & dates', () => {
  it('parses amounts into whole cents', () => {
    expect(parseCents('12,500.50')).toBe(1250050);
    expect(parseCents('$12500')).toBe(1250000);
    expect(parseCents('0.5')).toBe(50);
    expect(parseCents('7.05')).toBe(705);
  });

  it('rejects malformed or negative amounts', () => {
    for (const bad of ['', 'abc', '-5', '1.234', '1e3', '1.', '.5']) expect(parseCents(bad)).toBeNull();
  });

  it('formats cents for inputs', () => {
    expect(centsToInput(1250050)).toBe('12500.50');
    expect(centsToInput(0)).toBe('0.00');
  });

  it('validates ISO dates including leap days', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2027-02-29')).toBe(false);
    expect(isIsoDate('2027-13-01')).toBe(false);
    expect(isIsoDate('27-01-01')).toBe(false);
  });

  it('does month math without timezone drift', () => {
    expect(addMonthsStart('2027-11-10', 0)).toBe('2027-11-01');
    expect(addMonthsStart('2027-11-10', 2)).toBe('2028-01-01');
    expect(addMonthsStart('2027-01-31', 13)).toBe('2028-02-01');
    expect(monthEndOf('2027-02-10')).toBe('2027-02-28');
    expect(monthEndOf('2028-02-10')).toBe('2028-02-29');
  });

  it('formats months, days and lives', () => {
    expect(formatMonth('2027-03-15')).toBe('Mar 2027');
    expect(formatDay('2027-03-05')).toBe('Mar 5, 2027');
    expect(formatDay(null)).toBe('—');
    expect(formatLife(60)).toBe('5 yr');
    expect(formatLife(42)).toBe('3 yr 6 mo');
    expect(formatLife(8)).toBe('8 mo');
    expect(formatLife(0)).toBe('—');
  });
});

describe('buildSchedule — straight-line', () => {
  it('spreads evenly and ends exactly at salvage', () => {
    const lines = buildSchedule({ costCents: 100000, salvageCents: 10000, lifeMonths: 36, method: 'straight_line', inServiceDate: '2027-03-17' });
    expect(lines).toHaveLength(36);
    expect(lines.every((l) => l.amount_cents === 2500)).toBe(true);
    expect(lines[0].period_start).toBe('2027-03-01');
    expect(lines[0].period_end).toBe('2027-03-31');
    expect(lines[35].period_start).toBe('2030-02-01');
    expect(lines[35].book_value_cents).toBe(10000);
  });

  it('distributes leftover cents so the total is exact', () => {
    const lines = buildSchedule({ costCents: 100001, salvageCents: 0, lifeMonths: 3, method: 'straight_line', inServiceDate: '2027-01-01' });
    expect(lines.map((l) => l.amount_cents)).toEqual([33333, 33334, 33334]);
    expect(sum(lines)).toBe(100001);
    expect(lines[2].book_value_cents).toBe(0);
  });

  it('skips zero-amount months but still sums exactly', () => {
    const lines = buildSchedule({ costCents: 5, salvageCents: 0, lifeMonths: 60, method: 'straight_line', inServiceDate: '2027-01-01' });
    expect(lines).toHaveLength(5);
    expect(sum(lines)).toBe(5);
  });

  it('handles month ends across a year boundary and leap years', () => {
    const lines = buildSchedule({ costCents: 4000, salvageCents: 0, lifeMonths: 4, method: 'straight_line', inServiceDate: '2027-12-31' });
    expect(lines.map((l) => l.period_start)).toEqual(['2027-12-01', '2028-01-01', '2028-02-01', '2028-03-01']);
    expect(lines[2].period_end).toBe('2028-02-29');
  });

  it('stays exact for large, long-lived assets', () => {
    const lines = buildSchedule({ costCents: 2147483647, salvageCents: 123456, lifeMonths: 468, method: 'straight_line', inServiceDate: '2027-06-01' });
    expect(sum(lines)).toBe(2147483647 - 123456);
    expect(lines[lines.length - 1].book_value_cents).toBe(123456);
  });
});

describe('buildSchedule — other methods', () => {
  it("sum-of-the-years' digits steps down evenly", () => {
    const lines = buildSchedule({ costCents: 15000, salvageCents: 0, lifeMonths: 5, method: 'sum_of_years', inServiceDate: '2027-01-01' });
    expect(lines.map((l) => l.amount_cents)).toEqual([5000, 4000, 3000, 2000, 1000]);
  });

  it('double-declining switches to straight-line and lands exactly on salvage', () => {
    const lines = buildSchedule({ costCents: 10000, salvageCents: 1000, lifeMonths: 5, method: 'declining_balance', inServiceDate: '2027-01-01' });
    expect(lines.map((l) => l.amount_cents)).toEqual([4000, 2400, 1440, 864, 296]);
    expect(lines[lines.length - 1].book_value_cents).toBe(1000);
  });

  it('never depreciates below salvage for any method', () => {
    for (const method of ['straight_line', 'declining_balance', 'sum_of_years'] as const) {
      const lines = buildSchedule({ costCents: 987654, salvageCents: 54321, lifeMonths: 47, method, inServiceDate: '2027-05-09' });
      expect(sum(lines)).toBe(987654 - 54321);
      expect(lines.every((l) => l.book_value_cents >= 54321)).toBe(true);
      expect(lines.every((l) => l.amount_cents > 0)).toBe(true);
    }
  });

  it('returns nothing for non-depreciable or invalid input', () => {
    const base = { costCents: 1000, salvageCents: 0, lifeMonths: 12, method: 'straight_line' as const, inServiceDate: '2027-01-01' };
    expect(buildSchedule({ ...base, method: 'none' })).toEqual([]);
    expect(buildSchedule({ ...base, costCents: 0 })).toEqual([]);
    expect(buildSchedule({ ...base, salvageCents: 2000 })).toEqual([]);
    expect(buildSchedule({ ...base, lifeMonths: 0 })).toEqual([]);
    expect(buildSchedule({ ...base, lifeMonths: 601 })).toEqual([]);
    expect(buildSchedule({ ...base, inServiceDate: 'nope' })).toEqual([]);
  });

  it('summarizes a schedule', () => {
    const lines = buildSchedule({ costCents: 120000, salvageCents: 0, lifeMonths: 24, method: 'straight_line', inServiceDate: '2027-01-01' });
    const s = summarizeSchedule(lines, 120000, 0);
    expect(s).toMatchObject({ months: 24, firstAmount: 5000, lastAmount: 5000, firstYearTotal: 60000, endsOn: '2028-12-31', totalDepreciable: 120000 });
    expect(summarizeSchedule([]).endsOn).toBeNull();
  });
});

describe('register helpers', () => {
  it('computes book value, treating disposed assets as zero', () => {
    expect(bookValue(asset({ id: '1', accumulated_cents: 30000 }))).toBe(90000);
    expect(bookValue(asset({ id: '2', accumulated_cents: 30000, status: 'disposed' }))).toBe(0);
    expect(bookValue(asset({ id: '3', accumulated_cents: 999999 }))).toBe(0);
  });

  it('summarizes live assets and counts disposed ones separately', () => {
    const s = summarizeAssets([
      asset({ id: '1', accumulated_cents: 20000 }),
      asset({ id: '2', cost_cents: 50000, accumulated_cents: 50000, status: 'fully_depreciated' }),
      asset({ id: '3', status: 'disposed', accumulated_cents: 1 }),
    ]);
    expect(s).toEqual({ count: 2, disposed: 1, fullyDepreciated: 1, costCents: 170000, accumulatedCents: 70000, netBookValueCents: 100000 });
  });

  it('filters by status, category and free text', () => {
    const list = [
      asset({ id: '1', name: 'Ford Transit', category: 'vehicle', serial_number: 'VIN123' }),
      asset({ id: '2', name: 'Laptop', category: 'computer', location: 'Front office' }),
      asset({ id: '3', name: 'Old drill', category: 'tools', status: 'disposed' }),
    ];
    const all = { query: '', status: 'all' as const, category: 'all' as const };
    expect(filterAssets(list, all)).toHaveLength(3);
    expect(filterAssets(list, { ...all, status: 'disposed' }).map((a) => a.id)).toEqual(['3']);
    expect(filterAssets(list, { ...all, category: 'computer' }).map((a) => a.id)).toEqual(['2']);
    expect(filterAssets(list, { ...all, query: 'vin1' }).map((a) => a.id)).toEqual(['1']);
    expect(filterAssets(list, { ...all, query: 'front' }).map((a) => a.id)).toEqual(['2']);
    expect(filterAssets(list, { ...all, query: 'zzz' })).toEqual([]);
  });

  it('explains locks and delete eligibility', () => {
    expect(termsLockReason({ posted_months: 0, acquisition_entry_id: null })).toBe('');
    expect(termsLockReason({ posted_months: 2, acquisition_entry_id: null })).toMatch(/locked/);
    expect(canDeleteAsset({ status: 'active', posted_months: 0, acquisition_entry_id: null })).toBe(true);
    expect(canDeleteAsset({ status: 'active', posted_months: 1, acquisition_entry_id: null })).toBe(false);
    expect(canDeleteAsset({ status: 'active', posted_months: 0, acquisition_entry_id: 'je1' })).toBe(false);
    expect(canDeleteAsset({ status: 'disposed', posted_months: 0, acquisition_entry_id: null })).toBe(false);
  });

  it('previews gain or loss on disposal', () => {
    const a = { cost_cents: 100000, accumulated_cents: 60000 };
    expect(disposalPreview(a, 50000)).toEqual({ bookValueCents: 40000, gainLossCents: 10000 });
    expect(disposalPreview(a, 0)).toEqual({ bookValueCents: 40000, gainLossCents: -40000 });
  });

  it('describes activity events', () => {
    const ev = (action: string, detail: Record<string, unknown>): AssetEvent => ({ id: 'e', actor_id: null, asset_id: null, action, detail, created_at: '' });
    expect(describeEvent(ev('created', { tag: 'FA-0001', name: 'Van' }))).toBe('Added FA-0001 · Van');
    expect(describeEvent(ev('updated', { tag: 'FA-0001', name: 'Van', terms_changed: true }))).toBe('Edited FA-0001 · Van (schedule rebuilt)');
    expect(describeEvent(ev('depreciation_posted', { posted_lines: 3, entries: 1, skipped_closed_periods: 2 }))).toBe(
      'Posted depreciation: 3 lines in 1 entry; 2 closed months skipped',
    );
    expect(describeEvent(ev('weird_thing', {}))).toBe('weird thing');
  });
});

describe('validateAssetDraft', () => {
  const ctx = { assets: [{ id: 'x1', asset_tag: 'FA-0001' }], editingId: null, accounts };

  it('accepts a complete draft', () => {
    expect(validateAssetDraft(goodDraft(), ctx)).toEqual({});
  });

  it('flags missing name, cost and bad numbers', () => {
    const e = validateAssetDraft(goodDraft({ name: ' ', cost: '', lifeMonths: '0' }), ctx);
    expect(e.name).toBeTruthy();
    expect(e.cost).toBeTruthy();
    expect(e.lifeMonths).toBeTruthy();
  });

  it('rejects salvage above cost and cost above the ledger limit', () => {
    expect(validateAssetDraft(goodDraft({ cost: '1000', salvage: '2000' }), ctx).salvage).toMatch(/exceed/);
    expect(validateAssetDraft(goodDraft({ cost: '99999999' }), ctx).cost).toMatch(/maximum/);
  });

  it('checks tag uniqueness case-insensitively but allows the asset’s own tag', () => {
    expect(validateAssetDraft(goodDraft({ assetTag: 'fa-0001' }), ctx).assetTag).toMatch(/in use/);
    expect(validateAssetDraft(goodDraft({ assetTag: 'FA-0001' }), { ...ctx, editingId: 'x1' }).assetTag).toBeUndefined();
  });

  it('checks dates and account types', () => {
    const e = validateAssetDraft(goodDraft({ acquisitionDate: '2027-03-10', inServiceDate: '2027-03-01', expenseAccountId: 'a1' }), ctx);
    expect(e.inServiceDate).toMatch(/before/);
    expect(e.expenseAccountId).toBeTruthy();
    expect(validateAssetDraft(goodDraft({ accumulatedAccountId: 'a1' }), ctx).accumulatedAccountId).toMatch(/differ/);
  });

  it('does not require a life for non-depreciated assets', () => {
    expect(validateAssetDraft(goodDraft({ category: 'land', method: 'none', lifeMonths: '' }), ctx)).toEqual({});
  });

  it('requires an offset account only when recording the acquisition', () => {
    expect(validateAssetDraft(goodDraft({ recordAcquisition: true }), ctx).offsetAccountId).toBeTruthy();
    expect(validateAssetDraft(goodDraft({ recordAcquisition: true, offsetAccountId: 'cash' }), ctx)).toEqual({});
    expect(validateAssetDraft(goodDraft({ recordAcquisition: true, offsetAccountId: 'a1' }), ctx).offsetAccountId).toMatch(/differ/);
  });
});

describe('drafts & disposal validation', () => {
  it('round-trips an asset into a draft and a matching schedule', () => {
    const a = asset({ id: '1', cost_cents: 120000, useful_life_months: 12, notes: 'n' });
    const d = draftFromAsset(a);
    expect(d).toMatchObject({ cost: '1200.00', salvage: '0.00', lifeMonths: '12', notes: 'n' });
    expect(sum(draftToSchedule(d))).toBe(120000);
  });

  it('returns an empty schedule for an unparsable draft', () => {
    expect(draftToSchedule(goodDraft({ cost: 'x' }))).toEqual([]);
  });

  it('validates disposal input', () => {
    const a = { in_service_date: '2027-03-01' };
    const today = '2027-09-01';
    expect(validateDisposal({ date: '2027-06-01', proceeds: '', depositAccountId: '' }, a, today)).toEqual({});
    expect(validateDisposal({ date: '2027-02-01', proceeds: '0', depositAccountId: '' }, a, today).date).toMatch(/before/);
    expect(validateDisposal({ date: '2027-12-01', proceeds: '0', depositAccountId: '' }, a, today).date).toMatch(/future/);
    expect(validateDisposal({ date: '2027-06-01', proceeds: '500', depositAccountId: '' }, a, today).depositAccountId).toBeTruthy();
    expect(validateDisposal({ date: '2027-06-01', proceeds: 'abc', depositAccountId: '' }, a, today).proceeds).toBeTruthy();
  });
});
