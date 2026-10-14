import { describe, expect, it } from 'vitest';
import {
  analyzePricing,
  buildFailureIndex,
  classifyDemand,
  forecastDemand,
  normalizeDetail,
  normalizeOverview,
  partMatchesTag,
  patternsForPart,
  rankSubstitutes,
  recallSignal,
  scoreOverviewRow,
  scoreRisk,
  summarizeFailureHistory,
  summarizeSuppliers,
  wilsonLower,
} from './partsIntelligence';
import type { InstallOutcomeRow, PartFailureEvent, PatternLite } from './partsIntelligence';
import type { MarketOfferRow, PriceHistoryRow } from './partsMarket';

const NOW = new Date('2027-06-01T12:00:00Z');

const baseRisk = {
  maxRecallSeverity: null,
  hasRecall: false,
  stockRisk: 'ok' as const,
  daysOfCover: null,
  hasInStockSubstitute: false,
  hasSubstitutes: true,
  emergingPatterns: 0,
  elevatedPatterns: 0,
  failureTrend: null,
  priceSignal: null,
  worstSupplierConfidentPct: null,
  supplierSampleSize: 0,
};

describe('classifyDemand', () => {
  it('detects no demand, thin data, smooth and lumpy demand', () => {
    expect(classifyDemand([0, 0, 0, 0, 0])).toBe('none');
    expect(classifyDemand([3, 0, 0])).toBe('insufficient');
    expect(classifyDemand([4, 5, 4, 5, 4, 5, 4, 5])).toBe('smooth');
    expect(classifyDemand([0, 0, 0, 1, 0, 0, 0, 0, 12, 0, 0, 0, 0])).toBe('lumpy');
  });
});

describe('forecastDemand', () => {
  it('forecasts steady demand and computes cover', () => {
    const f = forecastDemand({
      weekly: [7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7],
      scheduled30d: 0,
      available: 8,
      reorderPoint: 5,
      reorderQuantity: 10,
      now: NOW,
    });
    expect(f.pattern).toBe('smooth');
    expect(f.weeklyLevel).toBeCloseTo(7, 1);
    expect(f.expected30d).toBeCloseTo(30, 0);
    expect(f.daysOfCover).toBeCloseTo(8, 0);
    expect(f.stockoutDate).toBe('2027-06-09');
    expect(f.stockRisk).toBe('high');
    expect(f.suggestedOrderQty % 10).toBe(0); // rounded to the configured lot size
    expect(f.suggestedOrderQty).toBeGreaterThan(0);
  });

  it('does not suggest an order while cover is comfortable', () => {
    const f = forecastDemand({ weekly: new Array(13).fill(7), scheduled30d: 0, available: 28, reorderPoint: 5, reorderQuantity: 0, now: NOW });
    expect(f.stockRisk).toBe('watch');
    expect(f.suggestedOrderQty).toBe(0);
  });

  it('never double-counts scheduled jobs: takes the larger signal', () => {
    const f = forecastDemand({ weekly: [1, 1, 1, 1, 1, 1, 1, 1], scheduled30d: 20, available: 50, reorderPoint: 0, reorderQuantity: 0, now: NOW });
    expect(f.expected30d).toBe(20);
    expect(f.low30d).toBeGreaterThanOrEqual(20);
    expect(f.notes.join(' ')).toMatch(/Scheduled jobs/);
  });

  it('flags a stock-out when nothing is available but demand exists', () => {
    const f = forecastDemand({ weekly: [2, 3, 2, 3, 2, 3, 2, 3], scheduled30d: 0, available: 0, reorderPoint: 2, reorderQuantity: 0, now: NOW });
    expect(f.stockRisk).toBe('critical');
    expect(f.daysOfCover).toBe(0);
    expect(f.suggestedOrderQty).toBeGreaterThan(0);
  });

  it('handles parts with no usage without NaN or Infinity', () => {
    const f = forecastDemand({ weekly: new Array(13).fill(0), scheduled30d: 0, available: 3, reorderPoint: 0, reorderQuantity: 0, now: NOW });
    expect(f.pattern).toBe('none');
    expect(f.daysOfCover).toBeNull();
    expect(f.stockoutDate).toBeNull();
    expect(f.confidence).toBe(0);
    expect(f.stockRisk).toBe('ok');
    for (const v of [f.expected30d, f.low30d, f.high30d, f.safetyStock, f.dynamicReorderPoint]) expect(Number.isFinite(v)).toBe(true);
  });

  it('keeps the range ordered and non-negative', () => {
    const f = forecastDemand({ weekly: [0, 5, 0, 9, 1, 0, 6, 0, 2, 0, 8, 0, 3], scheduled30d: 0, available: 5, reorderPoint: 3, reorderQuantity: 0, now: NOW });
    expect(f.low30d).toBeGreaterThanOrEqual(0);
    expect(f.low30d).toBeLessThanOrEqual(f.expected30d);
    expect(f.high30d).toBeGreaterThanOrEqual(f.expected30d);
    expect(f.next4Weeks.every((x) => x >= 0)).toBe(true);
  });
});

describe('analyzePricing', () => {
  const offer = (price: number, age = 10, over: Partial<MarketOfferRow> = {}): MarketOfferRow =>
    ({
      offer_id: String(Math.random()), user_id: 'u', part_id: 'p', part_name: 'P', part_number: null, source_id: 's',
      source_name: 'S', source_type: 'vendor', vendor_id: null, source_phone: null, distance_miles: 1, typical_response_minutes: 10,
      reliability_score: 0.9, delivery_fee_cents: 0, borrow_fee_pct: 0, return_in_kind: true, source_active: true,
      unit_price_cents: price, quantity_available: 5, eta_minutes: 30, fulfillment: 'pickup', origin: 'manual',
      observed_at: '2027-06-01T00:00:00Z', expires_at: null, note: null, age_minutes: age, is_expired: false, ...over,
    }) as MarketOfferRow;
  const hist = (prices: number[]): PriceHistoryRow[] =>
    prices.map((p, i) => ({ part_id: 'p', source_id: 's', unit_price_cents: p, observed_at: `2027-05-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));

  it('reports a buy window when the best quote is well below the 30-day median', () => {
    const r = analyzePricing({ offers: [offer(900), offer(1200)], history: hist([1000, 1000, 1010, 990, 1000, 1005]), ownUnitCostCents: 1000, oemAvgPriceCents: 1500 });
    expect(r.signal).toBe('buy_window');
    expect(r.bestCents).toBe(900);
    expect(r.vsOemPct).toBe(-40);
    expect(r.spreadPct).toBeCloseTo(33.3, 1);
  });

  it('detects spikes and ignores expired / inactive / empty quotes', () => {
    const r = analyzePricing({
      offers: [offer(1400), offer(100, 5, { is_expired: true }), offer(100, 5, { source_active: false }), offer(100, 5, { quantity_available: 0 })],
      history: hist([1000, 1000, 1000, 1000, 1000, 1000]),
      ownUnitCostCents: 0,
      oemAvgPriceCents: null,
    });
    expect(r.signal).toBe('spiking');
    expect(r.freshOffers).toBe(1);
  });

  it('separates stale quotes and handles no data', () => {
    const stale = analyzePricing({ offers: [offer(1000, 600)], history: [], ownUnitCostCents: 0, oemAvgPriceCents: null });
    expect(stale.signal).toBe('no_data');
    expect(stale.staleOffers).toBe(1);
    expect(stale.notes.join(' ')).toMatch(/re-quote/);
  });
});

describe('supplier reliability', () => {
  const row = (supplier: string, outcome: InstallOutcomeRow['outcome_class'], defect = false): InstallOutcomeRow =>
    ({ install_id: Math.random().toString(), supplier_name: supplier, quantity: 1, installed_at: '2027-05-01', outcome_class: outcome, defect_attributed: defect });

  it('does not let a tiny perfect sample outrank a large strong one', () => {
    const rows = [
      ...Array.from({ length: 2 }, () => row('Tiny Co', 'success')),
      ...Array.from({ length: 45 }, () => row('Big Supply', 'success')),
      ...Array.from({ length: 5 }, () => row('Big Supply', 'failure', true)),
    ];
    const out = summarizeSuppliers(rows);
    expect(out[0].supplier).toBe('Big Supply');
    expect(out.find((s) => s.supplier === 'Tiny Co')?.successRatePct).toBe(100);
    expect(out[0].defectAttributed).toBe(5);
  });

  it('excludes non-attributable installs and keeps pending out of the rate', () => {
    const out = summarizeSuppliers([row('A', 'excluded'), row('A', 'pending'), row('A', 'success')]);
    expect(out[0].installs).toBe(2);
    expect(out[0].successRatePct).toBe(100);
  });

  it('wilsonLower is monotonic in sample size', () => {
    expect(wilsonLower(10, 10)).toBeGreaterThan(wilsonLower(3, 3));
    expect(wilsonLower(0, 0)).toBe(0);
  });
});

describe('failure history + matching', () => {
  const part = { name: 'Dual Run Capacitor', part_number: 'P291-4054RS' };

  it('matches conservatively', () => {
    expect(partMatchesTag(part, 'dual_run_capacitor')).toBe(true);
    expect(partMatchesTag(part, 'run_capacitor')).toBe(true);
    expect(partMatchesTag(part, 'p291_4054rs')).toBe(true);
    expect(partMatchesTag(part, 'capacity')).toBe(false);
    expect(partMatchesTag(part, 'cap')).toBe(false);
    expect(partMatchesTag(part, '')).toBe(false);
  });

  it('summarises events and trend', () => {
    const ev = (d: string, outcome = 'fixed', comp = 'capacitor'): PartFailureEvent => ({
      id: d + outcome, equipment_id: 'e', occurred_on: d, age_months: 60, failure_component: comp, failure_mode: null,
      repair_action: null, parts_replaced: ['capacitor'], outcome, repair_cost: 200, make: 'Carrier', model: 'X1',
    });
    const s = summarizeFailureHistory([ev('2027-05-01'), ev('2027-03-01', 'recurred'), ev('2027-01-10'), ev('2026-02-01')], NOW);
    expect(s.total).toBe(4);
    expect(s.last12m).toBe(3);
    expect(s.prior12m).toBe(1);
    expect(s.trend).toBe('up');
    expect(s.repeatRatePct).toBe(25);
    expect(s.topComponents[0]).toEqual({ component: 'capacitor', count: 4 });
  });

  it('indexes events per part without duplicates, newest first', () => {
    const ev = (id: string, d: string, tags: string[]): PartFailureEvent => ({
      id, equipment_id: 'e', occurred_on: d, age_months: null, failure_component: 'c', failure_mode: null,
      repair_action: null, parts_replaced: tags, outcome: 'fixed', repair_cost: null, make: null, model: null,
    });
    const idx = buildFailureIndex([ev('1', '2027-01-01', ['run_capacitor', 'dual_run_capacitor']), ev('2', '2027-03-01', ['contactor']), ev('3', '2027-05-01', ['capacitor_run'])]);
    expect(idx(part).map((e) => e.id)).toEqual(['3', '1']); // newest first; event 1 matches via two tags but counts once
    expect(idx({ name: 'Contactor 2P', part_number: null }).map((e) => e.id)).toEqual(['2']);
  });

  it('links population patterns by part tag, strongest lift first', () => {
    const p = (lift: number, tag: string): PatternLite => ({
      failure_component: 'x', model_key: 'm', status: 'emerging', lift, top_parts: [{ tag, share: 0.5 }], recent_events: 9, contributor_count: 6,
    });
    const out = patternsForPart(part, [p(2, 'run_capacitor'), p(5, 'dual_run_capacitor'), p(9, 'contactor')]);
    expect(out.map((x) => x.lift)).toEqual([5, 2]);
  });
});

describe('substitutes', () => {
  it('ranks in-stock first, then cheapest, and computes savings', () => {
    const out = rankSubstitutes(
      [
        { part_id: 'a', name: 'A', part_number: null, note: null, unit_cost_cents: 900, available: 0 },
        { part_id: 'b', name: 'B', part_number: null, note: null, unit_cost_cents: 1500, available: 4 },
        { part_id: 'c', name: 'C', part_number: null, note: null, unit_cost_cents: 1400, available: 2, best_offer_cents: 1100 },
      ],
      1800,
    );
    expect(out.map((x) => x.part_id)).toEqual(['c', 'b', 'a']);
    expect(out[0].savingsCents).toBe(700);
  });
});

describe('recall signal + risk score', () => {
  it('normalizers survive garbage', () => {
    expect(normalizeOverview(null)).toEqual([]);
    expect(normalizeOverview([{ nope: 1 }])).toEqual([]);
    expect(normalizeDetail(undefined).found).toBe(false);
    expect(normalizeDetail({ found: true, part: { id: 'p', name: 'N' }, issues: [{ severity: 'weird' }] }).issues[0].severity).toBe('medium');
  });

  it('separates part-linked recalls from model-level context', () => {
    const none = recallSignal(normalizeDetail({ found: true, part: { id: 'p', name: 'N' }, model_recalls: [{ recall_number: 'R', title: 'T', severity: 'high' }] }));
    expect(none.level).toBe('none');
    expect(none.modelLevelRecalls).toBe(1);
    const linked = recallSignal(
      normalizeDetail({
        found: true, part: { id: 'p', name: 'N' }, units: [{ equipment_id: 'e' }],
        issues: [{ issue_id: 'i', title: 'T', severity: 'medium', recall: { recall_number: 'R', title: 'T', severity: 'critical' } }],
      }),
    );
    expect(linked.level).toBe('critical');
    expect(linked.partLinkedRecalls).toBe(1);
    expect(linked.affectedUnits).toBe(1);
  });

  it('scores a healthy part low and a recalled, stock-critical part high', () => {
    expect(scoreRisk(baseRisk).tier).toBe('healthy');
    const hot = scoreRisk({ ...baseRisk, maxRecallSeverity: 'critical', hasRecall: true, stockRisk: 'critical', daysOfCover: 1, emergingPatterns: 1, priceSignal: 'spiking' });
    expect(hot.score).toBe(95);
    expect(hot.tier).toBe('critical');
    expect(hot.factors[0].key).toBe('recall');
  });

  it('rewards an in-stock substitute and penalises none', () => {
    const withSub = scoreRisk({ ...baseRisk, stockRisk: 'high', hasInStockSubstitute: true });
    const noSub = scoreRisk({ ...baseRisk, stockRisk: 'high', hasSubstitutes: false });
    expect(noSub.score - withSub.score).toBe(10);
  });

  it('list-level scoring never penalises on unknown data', () => {
    const { risk, forecast } = scoreOverviewRow(
      {
        part_id: 'p', name: 'N', part_number: null, category: null, unit_cost_cents: 100, reorder_point: 0, reorder_quantity: 0,
        on_hand: 100, available: 100, weekly_usage: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], scheduled_30d: 0, oem_matched: false,
        compatible_units: 0, issue_count: 0, recall_count: 0, bulletin_count: 0, max_severity: null,
      },
      NOW,
    );
    expect(forecast.stockRisk).toBe('ok');
    expect(risk.tier).toBe('healthy');
  });
});
