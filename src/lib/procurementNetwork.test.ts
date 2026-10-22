import { describe, it, expect } from 'vitest';
import {
  MIN_COHORT,
  bpsToPercent,
  buildScheduleFromDiscounts,
  buyerCanCancel,
  daysLeft,
  fallbackUnitPrice,
  formatMoney,
  isProgramOrderable,
  parseCatalogCsv,
  parseDelimited,
  parseMoneyToCents,
  previewCart,
  summarizeSavings,
  supplierOrderActions,
  tierForVolume,
  tierProgress,
  unitPriceAt,
  validateScheduleDraft,
  validateShipTo,
} from './procurementNetwork';
import type { OrderSavingsRow, PoolPublic, ProgramItem, Rebate, Tier } from './procurementNetwork';

const tiers: Tier[] = [
  { id: 't1', rank: 1, label: 'Base', min_qualifying_cents: 0, discount_bps: 0 },
  { id: 't2', rank: 2, label: 'Silver', min_qualifying_cents: 1_000_000, discount_bps: 500 },
  { id: 't3', rank: 3, label: 'Gold', min_qualifying_cents: 5_000_000, discount_bps: 1000 },
];

const item = (over: Partial<ProgramItem> = {}): ProgramItem => ({
  id: 'i1',
  sku: 'SKU-1',
  name: 'Capacitor 45/5',
  description: null,
  category: null,
  manufacturer: null,
  mpn: null,
  unit: 'each',
  list_price_cents: 10_000,
  min_order_qty: 1,
  lead_time_days: null,
  prices: { t1: 9_500, t2: 9_000, t3: 8_500 },
  my_commit_qty: null,
  part_id: null,
  ...over,
});

const pool = (over: Partial<PoolPublic> = {}): PoolPublic => ({
  program_id: 'p1',
  cohort_visible: true,
  pooled_cents: 2_500_000,
  projected_cents: 3_000_000,
  participants: 6,
  gap_to_next_cents: 2_500_000,
  min_participants_for_tier: 3,
  tier_id: 't2',
  tier_rank: 2,
  tier_label: 'Silver',
  tier_discount_bps: 500,
  next_tier_rank: 3,
  next_tier_label: 'Gold',
  next_tier_min_cents: 5_000_000,
  ...over,
});

describe('money helpers', () => {
  it('formats cents and percentages', () => {
    expect(formatMoney(12345)).toBe('$123.45');
    expect(formatMoney(null)).toBe('$0.00');
    expect(bpsToPercent(500)).toBe('5%');
    expect(bpsToPercent(250)).toBe('2.5%');
    expect(bpsToPercent(125)).toBe('1.25%');
  });

  it('parses US, EU and plain amounts, rejecting junk and negatives', () => {
    expect(parseMoneyToCents('12.5')).toBe(1250);
    expect(parseMoneyToCents('$1,200.00')).toBe(120000);
    expect(parseMoneyToCents('1.234,56')).toBe(123456);
    expect(parseMoneyToCents('7')).toBe(700);
    expect(parseMoneyToCents('-3')).toBeNull();
    expect(parseMoneyToCents('abc')).toBeNull();
    expect(parseMoneyToCents('')).toBeNull();
    expect(parseMoneyToCents('1.234')).toBeNull();
  });
});

describe('tier selection (mirrors pn_pool_state)', () => {
  it('picks the highest tier whose threshold is met', () => {
    expect(tierForVolume(tiers, 0, 10, 3)?.id).toBe('t1');
    expect(tierForVolume(tiers, 999_999, 10, 3)?.id).toBe('t1');
    expect(tierForVolume(tiers, 1_000_000, 10, 3)?.id).toBe('t2');
    expect(tierForVolume(tiers, 9_000_000, 10, 3)?.id).toBe('t3');
  });

  it('keeps the base tier until enough distinct tenants have ordered', () => {
    expect(tierForVolume(tiers, 9_000_000, 2, 3)?.id).toBe('t1');
    expect(tierForVolume(tiers, 9_000_000, 3, 3)?.id).toBe('t3');
  });

  it('handles unsorted tiers and an empty list', () => {
    expect(tierForVolume([tiers[2], tiers[0], tiers[1]], 1_500_000, 5, 3)?.id).toBe('t2');
    expect(tierForVolume([], 100, 5, 3)).toBeNull();
  });
});

describe('pricing', () => {
  it('uses explicit schedule prices, else the tier discount off list', () => {
    expect(unitPriceAt(item(), tiers[1])).toBe(9_000);
    expect(unitPriceAt(item({ prices: {} }), tiers[1])).toBe(9_500);
    expect(unitPriceAt(item({ prices: {} }), null)).toBe(10_000);
    expect(fallbackUnitPrice(999, 1000)).toBe(899);
  });
});

describe('tier progress and the cohort rule', () => {
  it('reports percent to the next tier when the pool is visible', () => {
    const p = tierProgress(pool(), tiers);
    expect(p.hidden).toBe(false);
    expect(p.percent).toBe(38); // (2.5M-1M)/(5M-1M)
    expect(p.nextLabel).toBe('Gold');
    expect(p.gapCents).toBe(2_500_000);
  });

  it('never exposes numbers below the cohort', () => {
    const hidden = tierProgress(
      pool({ cohort_visible: false, pooled_cents: null, projected_cents: null, participants: null, gap_to_next_cents: null }),
      tiers,
    );
    expect(hidden.hidden).toBe(true);
    expect(hidden.percent).toBeNull();
    expect(hidden.gapCents).toBeNull();
    expect(hidden.participantsNeeded).toBe(MIN_COHORT);
  });

  it('is 100% at the top tier and safe with no pool', () => {
    expect(tierProgress(pool({ tier_id: 't3', tier_rank: 3, next_tier_rank: null, next_tier_label: null, next_tier_min_cents: null, pooled_cents: 6_000_000 }), tiers).percent).toBe(100);
    expect(tierProgress(null, tiers).hidden).toBe(true);
  });
});

describe('cart preview', () => {
  const items = [item(), item({ id: 'i2', sku: 'SKU-2', list_price_cents: 2_000, min_order_qty: 5, prices: { t1: 1_900, t2: 1_800, t3: 1_700 } })];

  it('prices lines at the current tier and shows the next-tier upside', () => {
    const c = previewCart(items, { i1: 10, i2: 10 }, tiers, 't2', 3);
    expect(c.subtotalCents).toBe(10 * 9_000 + 10 * 1_800);
    expect(c.listTotalCents).toBe(10 * 10_000 + 10 * 2_000);
    expect(c.savingsVsListCents).toBe(c.listTotalCents - c.subtotalCents);
    expect(c.nextTierExtraSavingCents).toBe(10 * 500 + 10 * 100);
    expect(c.errors).toHaveLength(0);
  });

  it('flags minimum quantities and ignores empty/invalid lines', () => {
    const c = previewCart(items, { i1: 0, i2: 2 }, tiers, 't1', null);
    expect(c.lines).toHaveLength(1);
    expect(c.errors[0]).toContain('minimum order quantity');
    expect(c.nextTierExtraSavingCents).toBeNull();
    expect(previewCart(items, { i1: 5_000_000 }, tiers, 't1', null).errors[0]).toContain('invalid quantity');
  });
});

describe('order and program rules', () => {
  it('limits supplier actions to the legal next steps', () => {
    expect(supplierOrderActions('placed')).toEqual(['confirm', 'cancel']);
    expect(supplierOrderActions('confirmed')).toEqual(['ship', 'cancel']);
    expect(supplierOrderActions('shipped')).toEqual(['deliver']);
    expect(supplierOrderActions('awaiting_approval')).toHaveLength(0);
    expect(supplierOrderActions('delivered')).toHaveLength(0);
  });

  it('lets buyers cancel only before confirmation and while the program is open', () => {
    expect(buyerCanCancel('awaiting_approval', 'open')).toBe(true);
    expect(buyerCanCancel('placed', 'open')).toBe(true);
    expect(buyerCanCancel('confirmed', 'open')).toBe(false);
    expect(buyerCanCancel('placed', 'closed')).toBe(false);
  });

  it('checks program windows and days left', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    expect(isProgramOrderable({ status: 'open', starts_on: '2026-10-01', ends_on: '2026-10-31' }, now)).toBe(true);
    expect(isProgramOrderable({ status: 'open', starts_on: '2026-10-21', ends_on: '2026-10-31' }, now)).toBe(false);
    expect(isProgramOrderable({ status: 'closed', starts_on: '2026-10-01', ends_on: '2026-10-31' }, now)).toBe(false);
    expect(daysLeft('2026-10-31', now)).toBe(12);
    expect(daysLeft('2026-10-01', now)).toBe(0);
  });

  it('requires a complete ship-to', () => {
    expect(validateShipTo({})).toHaveLength(4);
    expect(validateShipTo({ name: 'ACME HVAC', line1: '1 Main St', city: 'Austin', postal_code: '78701' })).toHaveLength(0);
  });
});

describe('savings reporting', () => {
  const rows: OrderSavingsRow[] = [
    { order_id: 'o1', program_id: 'p1', supplier_id: 's1', status: 'delivered', ordered_at: '2026-09-03T10:00:00Z', paid_cents: 90_000, baseline_cents: 100_000, list_cents: 110_000 },
    { order_id: 'o2', program_id: 'p1', supplier_id: 's1', status: 'placed', ordered_at: '2026-10-05T10:00:00Z', paid_cents: 45_000, baseline_cents: 50_000, list_cents: 55_000 },
    { order_id: 'o3', program_id: 'p2', supplier_id: 's2', status: 'cancelled', ordered_at: '2026-10-06T10:00:00Z', paid_cents: 999, baseline_cents: 9999, list_cents: 9999 },
    { order_id: 'o4', program_id: 'p2', supplier_id: 's2', status: 'awaiting_approval', ordered_at: '2026-10-07T10:00:00Z', paid_cents: 1, baseline_cents: 100, list_cents: 100 },
  ];
  const rebate = (over: Partial<Rebate>): Rebate => ({
    id: 'r', user_id: 'u', program_id: 'p1', supplier_id: 's1', kind: 'tier_true_up', amount_cents: 1_000, status: 'accrued',
    basis: {}, paid_at: null, paid_reference: null, created_at: '2026-10-10T00:00:00Z', ...over,
  });

  it('counts only approved, non-cancelled orders and adds rebates', () => {
    const s = summarizeSavings(rows, [rebate({}), rebate({ id: 'r2', kind: 'program_bonus', amount_cents: 2_500, status: 'paid' }), rebate({ id: 'r3', amount_cents: 777, status: 'void' })]);
    expect(s.orders).toBe(2);
    expect(s.paidCents).toBe(135_000);
    expect(s.baselineCents).toBe(150_000);
    expect(s.instantSavingsCents).toBe(15_000);
    expect(s.rebatesAccruedCents).toBe(1_000);
    expect(s.rebatesPaidCents).toBe(2_500);
    expect(s.totalSavingsCents).toBe(18_500);
    expect(s.savingsPercent).toBe(12.3);
  });

  it('groups by month and supplier and tolerates empty input', () => {
    const s = summarizeSavings(rows, []);
    expect(s.byMonth.map((m) => m.month)).toEqual(['2026-09', '2026-10']);
    expect(s.bySupplier).toHaveLength(1);
    const empty = summarizeSavings([], []);
    expect(empty.savingsPercent).toBeNull();
    expect(empty.totalSavingsCents).toBe(0);
  });

  it('reports a negative saving honestly', () => {
    const s = summarizeSavings([{ ...rows[0], paid_cents: 120_000 }], []);
    expect(s.instantSavingsCents).toBe(-20_000);
  });
});

describe('catalog CSV import', () => {
  it('parses quotes, aliases and currency formats', () => {
    const csv = 'SKU,Product Name,List Price,UOM,MOQ\r\nA-1,"Filter, 20x25",$12.50,box,2\nB-2,Contactor,1.234,each,\n';
    const r = parseCatalogCsv(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toEqual({
      sku: 'A-1', name: 'Filter, 20x25', list_price_cents: 1250, unit: 'box', category: null,
      manufacturer: null, mpn: null, description: null, min_order_qty: 2, lead_time_days: null,
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].line).toBe(3);
  });

  it('rejects duplicates, missing columns and oversize files', () => {
    expect(parseCatalogCsv('sku,name,price\nX,One,1\nx,Two,2').errors[0].message).toContain('Duplicate SKU');
    expect(parseCatalogCsv('sku,name\nX,One').errors[0].message).toContain('Missing required column');
    expect(parseCatalogCsv('only header').errors).toHaveLength(1);
    const big = 'sku,name,price\n' + Array.from({ length: 2001 }, (_, i) => `S${i},N${i},1`).join('\n');
    expect(parseCatalogCsv(big).errors[0].message).toContain('at most');
  });

  it('supports tab and semicolon delimiters', () => {
    expect(parseDelimited('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseDelimited('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseDelimited('a,"b ""q"" c"\n1,2')).toEqual([['a', 'b "q" c'], ['1', '2']]);
  });
});

describe('price schedule validation (mirrors pn_supplier_submit_schedule)', () => {
  const items = [{ id: 'i1', sku: 'SKU-1', list_price_cents: 10_000 }];
  const ok = [
    { catalog_item_id: 'i1', tier_id: 't1', unit_price_cents: 9_500 },
    { catalog_item_id: 'i1', tier_id: 't2', unit_price_cents: 9_000 },
    { catalog_item_id: 'i1', tier_id: 't3', unit_price_cents: 9_000 },
  ];

  it('accepts a monotonic schedule at or below list', () => {
    expect(validateScheduleDraft(tiers, items, ok)).toHaveLength(0);
  });

  it('rejects prices above list and prices that rise with volume', () => {
    expect(validateScheduleDraft(tiers, items, [{ ...ok[0], unit_price_cents: 10_001 }])[0]).toContain('exceeds list');
    const rising = [ok[0], { ...ok[1], unit_price_cents: 9_900 }];
    expect(validateScheduleDraft(tiers, items, rising)[0]).toContain('higher tier cannot cost more');
  });

  it('requires tiers starting at zero with strictly increasing thresholds, and at least one line', () => {
    expect(validateScheduleDraft([], items, ok)).toEqual(['Add volume tiers first']);
    expect(validateScheduleDraft([{ ...tiers[0], min_qualifying_cents: 100 }], items, ok)[0]).toContain('start at $0');
    expect(validateScheduleDraft([tiers[0], { ...tiers[1], min_qualifying_cents: 0 }], items, ok).join(' ')).toContain('must require more volume');
    expect(validateScheduleDraft(tiers, items, [])).toContain('Add at least one price line');
  });

  it('generates a starting schedule from per-tier discounts', () => {
    const lines = buildScheduleFromDiscounts(tiers, items, { t2: 600 });
    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.tier_id === 't2')?.unit_price_cents).toBe(9_400);
    expect(lines.find((l) => l.tier_id === 't3')?.unit_price_cents).toBe(9_000);
    expect(validateScheduleDraft(tiers, items, lines)).toHaveLength(0);
  });
});
