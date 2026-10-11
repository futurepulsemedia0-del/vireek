import { describe, it, expect } from 'vitest';
import {
  analyzeSuppliers,
  buildSupplierContext,
  comparePartSuppliers,
  compositeScore,
  confidenceFor,
  normalizeName,
  riskLevelFor,
} from './supplierIntelligence';
import type {
  GoodsReceiptWithItems,
  PartInfo,
  PurchaseOrderWithItems,
  SupplierInput,
} from './supplierIntelligence';
import type { Vendor } from './procurement';
import type { InventoryForecastRow, InventoryVendor } from './inventory';
import type { MarketSource } from './partsMarket';

const NOW = new Date('2026-10-05T12:00:00Z');
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
const dateIn = (d: number) => new Date(NOW.getTime() + d * DAY).toISOString().slice(0, 10);

// ---------- fixture builders ----------

const vendor = (id: string, name: string, over: Partial<Vendor> = {}): Vendor => ({
  id, user_id: 'u1', name, contact_name: null, email: null, phone: null, address: null,
  category: null, payment_terms: null, notes: null, active: true,
  created_at: daysAgo(500), updated_at: daysAgo(500), ...over,
});

const part = (id: string, name = `Part ${id}`, over: Partial<PartInfo> = {}): PartInfo => ({
  id, name, part_number: `PN-${id}`, category: null, unit_cost_cents: 1000,
  reorder_point: 5, reorder_quantity: 10, ...over,
});

let seq = 0;
const nid = (p: string) => `${p}${++seq}`;

/** A fully received PO with one line, created `ageDays` ago. */
function deliveredPo(
  vendorId: string,
  partId: string,
  o: { price: number; qty?: number; ageDays: number; leadDays: number; promisedDays?: number; receivedQty?: number; damaged?: boolean },
): { po: PurchaseOrderWithItems; receipt: GoodsReceiptWithItems } {
  const qty = o.qty ?? 20;
  const poId = nid('po');
  const itemId = nid('it');
  const created = daysAgo(o.ageDays);
  const subtotal = o.price * qty;
  const po: PurchaseOrderWithItems = {
    id: poId, user_id: 'u1', po_number: poId, vendor_id: vendorId, rfq_id: null, vendor_quote_id: null,
    purchase_request_id: null, status: 'received', subtotal_cents: subtotal, shipping_cents: 0, tax_cents: 0,
    total_cents: subtotal,
    expected_delivery_date: new Date(NOW.getTime() - (o.ageDays - (o.promisedDays ?? o.leadDays)) * DAY).toISOString().slice(0, 10),
    approved_by: null, approved_at: created, sent_at: created, notes: null, created_at: created, updated_at: created,
    items: [{ id: itemId, po_id: poId, part_id: partId, description: 'x', quantity_ordered: qty, unit_price_cents: o.price, quantity_received: o.receivedQty ?? qty }],
  };
  const receipt: GoodsReceiptWithItems = {
    id: nid('gr'), po_id: poId, received_by: null,
    received_at: new Date(NOW.getTime() - (o.ageDays - o.leadDays) * DAY).toISOString(), notes: null,
    items: [{ id: nid('gri'), goods_receipt_id: 'x', po_item_id: itemId, quantity_received: o.receivedQty ?? qty, location_id: null, condition: o.damaged ? 'damaged' : 'good', notes: null }],
  };
  return { po, receipt };
}

function openPo(vendorId: string, partId: string, o: { owed: number; etaInDays: number; status?: 'sent' | 'approved' }): PurchaseOrderWithItems {
  const id = nid('po');
  return {
    id, user_id: 'u1', po_number: id, vendor_id: vendorId, rfq_id: null, vendor_quote_id: null, purchase_request_id: null,
    status: o.status ?? 'sent', subtotal_cents: 1000 * o.owed, shipping_cents: 0, tax_cents: 0, total_cents: 1000 * o.owed,
    expected_delivery_date: dateIn(o.etaInDays), approved_by: null, approved_at: daysAgo(2), sent_at: daysAgo(2),
    notes: null, created_at: daysAgo(2), updated_at: daysAgo(2),
    items: [{ id: nid('it'), po_id: id, part_id: partId, description: 'x', quantity_ordered: o.owed, unit_price_cents: 1000, quantity_received: 0 }],
  };
}

const forecastRow = (partId: string, o: { available: number; usage: number; trend?: 'rising' | 'falling' | 'flat' }): InventoryForecastRow => ({
  user_id: 'u1', part_id: partId, part_name: `Part ${partId}`, part_number: `PN-${partId}`, location_id: 'loc1',
  location_name: 'Warehouse', quantity_on_hand: o.available, quantity_reserved: 0, quantity_available: o.available,
  avg_daily_usage_30d: o.usage, avg_daily_usage_90d: o.usage, demand_trend: o.trend ?? 'flat',
  estimated_days_of_stock: null, suggested_par_level: 10,
});

const input = (over: Partial<SupplierInput> = {}): SupplierInput => ({
  now: NOW, vendors: [], inventoryVendors: [], evaluations: [], purchaseOrders: [], receipts: [], rfqVendors: [],
  quotes: [], purchaseRequests: [], catalog: [], parts: [], marketSources: [], offers: [], priceHistory: [],
  forecast: [], ...over,
});

/** n delivered POs for one vendor/part, spaced 10 days apart starting 15 days ago. */
function history(vendorId: string, partId: string, n: number, o: { price: number; leadDays: number; promisedDays?: number }) {
  const pos: PurchaseOrderWithItems[] = [];
  const receipts: GoodsReceiptWithItems[] = [];
  for (let i = 0; i < n; i++) {
    const { po, receipt } = deliveredPo(vendorId, partId, { ...o, ageDays: 15 + i * 10 });
    pos.push(po);
    receipts.push(receipt);
  }
  return { pos, receipts };
}

const merge = (...hs: ReturnType<typeof history>[]) => ({
  purchaseOrders: hs.flatMap((h) => h.pos),
  receipts: hs.flatMap((h) => h.receipts),
});

const profile = (res: ReturnType<typeof analyzeSuppliers>, name: string) => {
  const p = res.profiles.find((x) => x.name === name);
  if (!p) throw new Error(`profile ${name} missing`);
  return p;
};

// ---------- tests ----------

describe('helpers', () => {
  it('normalizes supplier names across legal suffixes and punctuation', () => {
    expect(normalizeName('ACME Supply, Inc.')).toBe(normalizeName('acme supply'));
    expect(normalizeName('Smith & Sons LLC')).toBe('smith and sons');
    expect(normalizeName('Inc')).toBe('inc');
  });

  it('maps confidence and risk thresholds', () => {
    expect(confidenceFor(0)).toBe('none');
    expect(confidenceFor(3)).toBe('low');
    expect(confidenceFor(8)).toBe('medium');
    expect(confidenceFor(20)).toBe('high');
    expect(riskLevelFor(10)).toBe('low');
    expect(riskLevelFor(30)).toBe('moderate');
    expect(riskLevelFor(50)).toBe('high');
    expect(riskLevelFor(80)).toBe('critical');
  });

  it('renormalises composite weights over available dimensions', () => {
    const full = compositeScore({ reliability: 80, quality: 80, price: 80, leadTime: 80, responsiveness: 80 }, 'balanced');
    expect(full.composite).toBe(80);
    expect(full.coverage).toBe(1);
    const partial = compositeScore({ reliability: 90, quality: null, price: null, leadTime: null, responsiveness: null }, 'balanced');
    expect(partial.composite).toBe(90);
    expect(partial.coverage).toBeLessThan(0.5);
    expect(compositeScore({ reliability: null, quality: null, price: null, leadTime: null, responsiveness: null }, 'cost').composite).toBeNull();
  });
});

describe('empty and degenerate input', () => {
  it('does not throw and returns zeroed summary', () => {
    const res = analyzeSuppliers(buildSupplierContext(input()));
    expect(res.profiles).toHaveLength(0);
    expect(res.outlook).toHaveLength(0);
    expect(res.recommendations).toHaveLength(0);
    expect(res.summary.totalSpend12mCents).toBe(0);
    expect(res.summary.concentrationLevel).toBe('low');
    expect(res.summary.weightedOnTimeRate).toBeNull();
  });

  it('a supplier with no history gets null scores, not invented ones', () => {
    const res = analyzeSuppliers(buildSupplierContext(input({ vendors: [vendor('v1', 'Brand New Co')] })));
    const p = profile(res, 'Brand New Co');
    expect(p.scores.reliability).toBeNull();
    expect(p.composite).toBeNull();
    expect(p.confidence).toBe('none');
  });
});

describe('entity resolution', () => {
  it('links inventory vendors and market sources to the procurement vendor by name', () => {
    const iv: InventoryVendor = {
      id: 'iv1', user_id: 'u1', name: 'acme supply', contact_name: null, email: null, phone: null,
      address: null, default_lead_time_days: 4, notes: null, active: true, created_at: daysAgo(100),
    };
    const src = {
      id: 's1', user_id: 'u1', name: 'Acme Supply Inc', source_type: 'distributor', vendor_id: null, phone: null,
      address: null, distance_miles: 3, typical_response_minutes: 20, reliability_score: 0.9, delivery_fee_cents: 0,
      borrow_fee_pct: 0, return_in_kind: false, notes: null, active: true, created_at: daysAgo(10), updated_at: daysAgo(10),
    } as MarketSource;
    const res = analyzeSuppliers(
      buildSupplierContext(input({ vendors: [vendor('v1', 'Acme Supply, Inc.')], inventoryVendors: [iv], marketSources: [src] })),
    );
    expect(res.profiles).toHaveLength(1);
    expect(res.profiles[0].linkedInventoryVendorIds).toEqual(['iv1']);
    expect(res.profiles[0].linkedSourceIds).toEqual(['s1']);
    expect(res.profiles[0].leadTime.basis).toBe('catalog');
  });

  it('ignores contractor sources (borrowing belongs to Parts Market)', () => {
    const src = { id: 's2', name: 'Bob the Contractor', source_type: 'contractor', vendor_id: null, active: true } as MarketSource;
    const res = analyzeSuppliers(buildSupplierContext(input({ marketSources: [src] })));
    expect(res.profiles).toHaveLength(0);
  });
});

describe('delivery, fill and reliability', () => {
  it('derives on-time rate from promise vs receipt and counts overdue open orders as late', () => {
    const onTime = history('v1', 'p1', 4, { price: 1000, leadDays: 5, promisedDays: 6 });
    const late = history('v1', 'p1', 1, { price: 1000, leadDays: 9, promisedDays: 5 });
    const overdue = openPo('v1', 'p1', { owed: 5, etaInDays: -4 });
    const m = merge(onTime, late);
    const res = analyzeSuppliers(
      buildSupplierContext(input({ vendors: [vendor('v1', 'Slow Co')], purchaseOrders: [...m.purchaseOrders, overdue], receipts: m.receipts })),
    );
    const p = profile(res, 'Slow Co');
    expect(p.onTimeSource).toBe('receipts');
    expect(p.onTimeSample).toBe(6);
    expect(p.onTimeRate).toBeCloseTo(4 / 6, 2);
    expect(p.overdueOpenOrders).toBe(1);
    expect(p.avgDelayDays).toBeGreaterThan(0);
  });

  it('computes fill rate and damage rate', () => {
    const short = deliveredPo('v1', 'p1', { price: 1000, qty: 10, receivedQty: 6, ageDays: 20, leadDays: 4, damaged: true });
    const ok = deliveredPo('v1', 'p1', { price: 1000, qty: 10, ageDays: 40, leadDays: 4 });
    const res = analyzeSuppliers(
      buildSupplierContext(input({ vendors: [vendor('v1', 'Short Co')], purchaseOrders: [short.po, ok.po], receipts: [short.receipt, ok.receipt] })),
    );
    const p = profile(res, 'Short Co');
    expect(p.fillRate).toBeCloseTo(16 / 20, 2);
    expect(p.damageRate).toBeCloseTo(0.5, 2);
    expect(p.scores.quality).not.toBeNull();
  });

  it('shrinks small samples: one perfect delivery never outranks a long perfect record', () => {
    const a = history('v1', 'p1', 1, { price: 1000, leadDays: 5 });
    const b = history('v2', 'p1', 12, { price: 1000, leadDays: 5 });
    const m = merge(a, b);
    const res = analyzeSuppliers(
      buildSupplierContext(input({ vendors: [vendor('v1', 'Newbie'), vendor('v2', 'Veteran')], ...m })),
    );
    expect(profile(res, 'Veteran').scores.reliability as number).toBeGreaterThan(profile(res, 'Newbie').scores.reliability as number);
    expect(profile(res, 'Veteran').confidence).toBe('high');
    expect(profile(res, 'Newbie').confidence).toBe('low');
  });
});

describe('pricing', () => {
  it('computes a market-relative price index and flags renegotiation', () => {
    const parts = ['p1', 'p2', 'p3'].map((id) => part(id));
    const cheap = merge(...parts.map((p) => history('v1', p.id, 3, { price: 1000, leadDays: 5 })));
    const dear = merge(...parts.map((p) => history('v2', p.id, 3, { price: 1300, leadDays: 5 })));
    const res = analyzeSuppliers(
      buildSupplierContext(
        input({
          vendors: [vendor('v1', 'Cheap Co'), vendor('v2', 'Dear Co')], parts,
          purchaseOrders: [...cheap.purchaseOrders, ...dear.purchaseOrders],
          receipts: [...cheap.receipts, ...dear.receipts],
        }),
      ),
    );
    const c = profile(res, 'Cheap Co');
    const d = profile(res, 'Dear Co');
    expect(c.priceIndex as number).toBeLessThan(1);
    expect(d.priceIndex as number).toBeGreaterThan(1.08);
    expect(c.scores.price as number).toBeGreaterThan(d.scores.price as number);
    const rec = res.recommendations.find((r) => r.kind === 'renegotiate' && r.supplierKey === d.key);
    expect(rec).toBeDefined();
    expect(rec?.impactCents as number).toBeGreaterThan(0);
    expect(res.recommendations.find((r) => r.kind === 'renegotiate' && r.supplierKey === c.key)).toBeUndefined();
  });

  it('detects a rising price trend from dated observations', () => {
    const pos: PurchaseOrderWithItems[] = [];
    const receipts: GoodsReceiptWithItems[] = [];
    [0, 1, 2, 3, 4].forEach((i) => {
      const { po, receipt } = deliveredPo('v1', 'p1', { price: 1000 + i * 60, ageDays: 100 - i * 20, leadDays: 3 });
      pos.push(po);
      receipts.push(receipt);
    });
    const ctx = buildSupplierContext(input({ vendors: [vendor('v1', 'Climber')], parts: [part('p1')], purchaseOrders: pos, receipts }));
    expect(ctx.partTrend.get('p1') as number).toBeGreaterThan(8);
  });
});

describe('part sourcing comparison', () => {
  const build = () => {
    const slowCheap = history('v1', 'p1', 6, { price: 1000, leadDays: 10, promisedDays: 10 });
    const fastDear = history('v2', 'p1', 6, { price: 1300, leadDays: 2, promisedDays: 2 });
    const m = merge(slowCheap, fastDear);
    return buildSupplierContext(
      input({ vendors: [vendor('v1', 'Slow & Cheap'), vendor('v2', 'Fast & Dear')], parts: [part('p1')], ...m }),
    );
  };

  it('ranks differently depending on the sourcing priority', () => {
    const ctx = build();
    expect(comparePartSuppliers(ctx, 'p1', 10, 'cost').primary?.name).toBe('Slow & Cheap');
    expect(comparePartSuppliers(ctx, 'p1', 10, 'speed').primary?.name).toBe('Fast & Dear');
  });

  it('exposes landed cost, backup and rationale', () => {
    const r = comparePartSuppliers(build(), 'p1', 10, 'balanced');
    expect(r.candidates).toHaveLength(2);
    expect(r.primary).not.toBeNull();
    expect(r.backup).not.toBeNull();
    expect(r.primary?.key).not.toBe(r.backup?.key);
    expect(r.singleSource).toBe(false);
    expect(r.rationale.length).toBeGreaterThan(0);
    r.candidates.forEach((c) => expect(c.landedCostCents).toBeGreaterThan(0));
  });

  it('flags a single-source part and handles a part with no supplier', () => {
    const h = history('v1', 'p1', 3, { price: 1000, leadDays: 4 });
    const ctx = buildSupplierContext(input({ vendors: [vendor('v1', 'Only One')], parts: [part('p1'), part('p2')], ...merge(h) }));
    expect(comparePartSuppliers(ctx, 'p1', 5).singleSource).toBe(true);
    const none = comparePartSuppliers(ctx, 'p2', 5);
    expect(none.primary).toBeNull();
    expect(none.candidates).toHaveLength(0);
  });

  it('excludes inactive suppliers from candidates', () => {
    const a = history('v1', 'p1', 3, { price: 900, leadDays: 4 });
    const b = history('v2', 'p1', 3, { price: 1000, leadDays: 4 });
    const ctx = buildSupplierContext(
      input({ vendors: [vendor('v1', 'Closed', { active: false }), vendor('v2', 'Open')], parts: [part('p1')], ...merge(a, b) }),
    );
    const r = comparePartSuppliers(ctx, 'p1', 5);
    expect(r.candidates.map((c) => c.name)).toEqual(['Open']);
  });
});

describe('supply outlook and recommendations', () => {
  const base = () => {
    const a = history('v1', 'p1', 4, { price: 1000, leadDays: 7, promisedDays: 7 });
    const b = history('v2', 'p1', 4, { price: 1100, leadDays: 6, promisedDays: 6 });
    return { vendors: [vendor('v1', 'Main Supply'), vendor('v2', 'Backup Supply')], parts: [part('p1', 'Capacitor', { reorder_quantity: 10 })], ...merge(a, b) };
  };

  it('flags order_now when stock cannot cover lead time + buffer and proposes a purchase request', () => {
    const res = analyzeSuppliers(buildSupplierContext(input({ ...base(), forecast: [forecastRow('p1', { available: 5, usage: 1 })] })));
    const row = res.outlook[0];
    expect(row.status).toBe('order_now');
    expect(row.daysOfStock).toBe(5);
    expect(row.recommendedQty).toBeGreaterThanOrEqual(30);
    expect(row.primary).not.toBeNull();
    const rec = res.recommendations.find((r) => r.kind === 'reorder_now');
    expect(rec).toBeDefined();
    expect(rec?.severity).toBe('critical'); // 5 days of stock < ~6-7 day lead time
    expect(rec?.action.type).toBe('create_purchase_request');
    expect(res.summary.partsToOrderNow).toBe(1);
  });

  it('treats inbound orders that arrive in time as cover, and late ones as no cover', () => {
    const covered = analyzeSuppliers(
      buildSupplierContext(input({ ...base(), purchaseOrders: [...base().purchaseOrders, openPo('v1', 'p1', { owed: 60, etaInDays: 3 })], forecast: [forecastRow('p1', { available: 5, usage: 1 })] })),
    );
    expect(covered.outlook[0].status).not.toBe('order_now');
    expect(covered.outlook[0].inboundQty).toBe(60);

    const late = analyzeSuppliers(
      buildSupplierContext(input({ ...base(), purchaseOrders: [...base().purchaseOrders, openPo('v1', 'p1', { owed: 60, etaInDays: 20 })], forecast: [forecastRow('p1', { available: 5, usage: 1 })] })),
    );
    expect(late.outlook[0].inboundLate).toBe(true);
    expect(late.outlook[0].status).toBe('order_now');
  });

  it('does not recommend ordering when a purchase request is already open', () => {
    const pr = {
      id: 'pr1', user_id: 'u1', part_id: 'p1', description: null, quantity_requested: 40, reason: 'low_stock' as const,
      job_id: null, requested_by: null, needed_by: null, status: 'draft' as const, notes: null, created_at: daysAgo(1), updated_at: daysAgo(1),
    };
    const res = analyzeSuppliers(buildSupplierContext(input({ ...base(), purchaseRequests: [pr], forecast: [forecastRow('p1', { available: 5, usage: 1 })] })));
    expect(res.outlook[0].status).toBe('request_open');
    expect(res.recommendations.find((r) => r.kind === 'reorder_now')).toBeUndefined();
  });

  it('asks to find a supplier when a part in demand has none', () => {
    const res = analyzeSuppliers(buildSupplierContext(input({ parts: [part('p9', 'Orphan')], forecast: [forecastRow('p9', { available: 2, usage: 1 })] })));
    expect(res.outlook[0].noSupplier).toBe(true);
    expect(res.recommendations.find((r) => r.kind === 'source_part')).toBeDefined();
  });

  it('reports no_demand for parts that are not used', () => {
    const res = analyzeSuppliers(buildSupplierContext(input({ ...base(), forecast: [forecastRow('p1', { available: 50, usage: 0 })] })));
    expect(res.outlook[0].status).toBe('no_demand');
    expect(res.outlook[0].daysOfStock).toBeNull();
  });

  it('rising demand shortens the runway', () => {
    const flat = analyzeSuppliers(buildSupplierContext(input({ ...base(), forecast: [forecastRow('p1', { available: 40, usage: 1, trend: 'flat' })] })));
    const rising = analyzeSuppliers(buildSupplierContext(input({ ...base(), forecast: [forecastRow('p1', { available: 40, usage: 1, trend: 'rising' })] })));
    expect(rising.outlook[0].daysOfStock as number).toBeLessThan(flat.outlook[0].daysOfStock as number);
  });
});

describe('risk and concentration', () => {
  it('rates a sole-source, high-share, unreliable supplier worse than a diversified, reliable one', () => {
    const risky = merge(history('v1', 'p1', 5, { price: 1000, leadDays: 12, promisedDays: 5 }), history('v1', 'p2', 5, { price: 1000, leadDays: 12, promisedDays: 5 }));
    const safe = merge(history('v2', 'p3', 5, { price: 100, leadDays: 3, promisedDays: 4 }), history('v3', 'p3', 5, { price: 100, leadDays: 3, promisedDays: 4 }));
    const res = analyzeSuppliers(
      buildSupplierContext(
        input({
          vendors: [vendor('v1', 'Risky'), vendor('v2', 'Safe A'), vendor('v3', 'Safe B')],
          parts: [part('p1'), part('p2'), part('p3')],
          purchaseOrders: [...risky.purchaseOrders, ...safe.purchaseOrders],
          receipts: [...risky.receipts, ...safe.receipts],
        }),
      ),
    );
    const r = profile(res, 'Risky');
    const s = profile(res, 'Safe A');
    expect(r.risk.score).toBeGreaterThan(s.risk.score);
    expect(r.singleSourcePartIds.sort()).toEqual(['p1', 'p2']);
    expect(r.spendShare).toBeGreaterThan(0.5);
    expect(res.summary.topSupplierShare).toBe(r.spendShare);
    expect(res.recommendations.find((x) => x.kind === 'diversify' && x.supplierKey === r.key)).toBeDefined();
    expect(res.recommendations.find((x) => x.kind === 'review_supplier' && x.supplierKey === r.key)).toBeDefined();
    expect(['high', 'critical']).toContain(res.summary.concentrationLevel);
  });

  it('sorts recommendations by severity and gives every one an action', () => {
    const base = merge(history('v1', 'p1', 4, { price: 1000, leadDays: 7, promisedDays: 7 }));
    const res = analyzeSuppliers(
      buildSupplierContext(input({ vendors: [vendor('v1', 'Main')], parts: [part('p1')], ...base, forecast: [forecastRow('p1', { available: 3, usage: 1 })] })),
    );
    const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    for (let i = 1; i < res.recommendations.length; i++) {
      expect(order[res.recommendations[i - 1].severity]).toBeLessThanOrEqual(order[res.recommendations[i].severity]);
    }
    res.recommendations.forEach((r) => expect(r.action).toBeDefined());
    const ids = res.recommendations.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
