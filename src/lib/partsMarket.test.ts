import { describe, it, expect } from 'vitest';
import { evaluateMarket, onTimeProbability } from './partsMarket';
import type { MarketInput, MarketOfferRow, DecisionContext } from './partsMarket';
import type { PartsAvailabilityRow } from './inventory';

const NOW = new Date('2026-09-28T10:00:00Z');
const inMinutes = (m: number) => new Date(NOW.getTime() + m * 60000).toISOString();

const PART = { id: 'p1', name: 'Capacitor 45/5', part_number: 'CAP-45', unit_cost_cents: 2500 };
const SUB = { id: 'p2', name: 'Capacitor 45/5 (universal)', part_number: 'CAP-45U', unit_cost_cents: 2000 };

function offer(over: Partial<MarketOfferRow>): MarketOfferRow {
  return {
    offer_id: 'o1',
    user_id: 'u1',
    part_id: 'p1',
    part_name: PART.name,
    part_number: PART.part_number,
    source_id: 's1',
    source_name: 'Vendor A',
    source_type: 'vendor',
    vendor_id: null,
    source_phone: null,
    distance_miles: 5,
    typical_response_minutes: 20,
    reliability_score: 0.95,
    delivery_fee_cents: 0,
    borrow_fee_pct: 0,
    return_in_kind: true,
    source_active: true,
    unit_price_cents: 2800,
    quantity_available: 10,
    eta_minutes: null,
    fulfillment: 'pickup',
    origin: 'manual',
    observed_at: NOW.toISOString(),
    expires_at: null,
    note: null,
    age_minutes: 5,
    is_expired: false,
    ...over,
  };
}

function stock(over: Partial<PartsAvailabilityRow>): PartsAvailabilityRow {
  return {
    stock_level_id: 'sl1',
    user_id: 'u1',
    part_id: 'p1',
    part_name: PART.name,
    part_number: PART.part_number,
    category: null,
    reorder_point: 2,
    reorder_quantity: 10,
    unit_cost_cents: PART.unit_cost_cents,
    location_id: 'l-wh',
    location_name: 'Main Warehouse',
    location_type: 'warehouse',
    quantity_on_hand: 5,
    quantity_reserved: 0,
    quantity_available: 5,
    avg_daily_usage_30d: 0.5,
    estimated_days_of_stock: 10,
    stockout_risk: 'ok',
    ...over,
  };
}

function base(over: Partial<MarketInput> = {}): MarketInput {
  return {
    requestedPart: PART,
    parts: [PART, SUB],
    substituteIds: [],
    availability: [],
    locations: [
      { id: 'l-wh', name: 'Main Warehouse', location_type: 'warehouse', assigned_technician_id: null },
      { id: 'l-van', name: 'Van 3', location_type: 'van', assigned_technician_id: 'tech1' },
    ],
    offers: [],
    priceHistory: [],
    ...over,
  };
}

const ctx = (over: Partial<DecisionContext> = {}): DecisionContext => ({
  quantity: 1,
  deadline: inMinutes(180),
  technicianId: 'tech1',
  now: NOW,
  ...over,
});

describe('onTimeProbability', () => {
  it('is the reliability itself with no deadline', () => {
    expect(onTimeProbability(0.9, 500, null, 15)).toBe(0.9);
  });
  it('collapses when the part arrives after the deadline', () => {
    expect(onTimeProbability(0.99, 120, 60, 15)).toBe(0.05);
  });
  it('de-rates tight slack', () => {
    const p = onTimeProbability(1, 30, 75, 15); // slack 30
    expect(p).toBeGreaterThan(0.6);
    expect(p).toBeLessThan(1);
  });
});

describe('evaluateMarket', () => {
  it('prefers the technician’s own van over everything else', () => {
    const d = evaluateMarket(
      base({
        availability: [
          stock({ location_id: 'l-van', location_name: 'Van 3', location_type: 'van', quantity_available: 2 }),
          stock({}),
        ],
        offers: [offer({})],
      }),
      ctx(),
    );
    expect(d.recommended?.action).toBe('use_van_stock');
    expect(d.buyVsBorrow.verdict).toBe('internal');
    expect(d.recommended?.marginErosionCents).toBeLessThanOrEqual(200);
  });

  it('recommends borrowing when a contractor is far faster than any purchase before a tight appointment', () => {
    const d = evaluateMarket(
      base({
        offers: [
          offer({ offer_id: 'buy', source_name: 'Distant Vendor', distance_miles: 30, unit_price_cents: 2400, eta_minutes: 200 }),
          offer({
            offer_id: 'borrow',
            source_id: 's2',
            source_name: 'Bob’s Heating',
            source_type: 'contractor',
            fulfillment: 'handoff',
            distance_miles: 3,
            unit_price_cents: 2800,
            borrow_fee_pct: 10,
            eta_minutes: 20,
          }),
        ],
      }),
      ctx({ deadline: inMinutes(90) }),
    );
    expect(d.buyVsBorrow.verdict).toBe('borrow');
    expect(d.recommended?.label).toBe('Bob’s Heating');
    expect(d.buyVsBorrow.savingsCents).toBeGreaterThan(0);
  });

  it('recommends buying when there is time and the vendor is cheapest', () => {
    const d = evaluateMarket(
      base({
        offers: [
          offer({ offer_id: 'buy', unit_price_cents: 2500, distance_miles: 4 }),
          offer({
            offer_id: 'borrow',
            source_id: 's2',
            source_type: 'contractor',
            source_name: 'Bob’s Heating',
            fulfillment: 'handoff',
            unit_price_cents: 3500,
            borrow_fee_pct: 25,
          }),
        ],
      }),
      ctx({ deadline: inMinutes(600) }),
    );
    expect(d.buyVsBorrow.verdict).toBe('buy');
  });

  it('excludes expired, inactive and out-of-stock offers with a reason', () => {
    const d = evaluateMarket(
      base({
        offers: [
          offer({ offer_id: 'a', is_expired: true, source_name: 'Old' }),
          offer({ offer_id: 'b', source_active: false, source_name: 'Inactive' }),
          offer({ offer_id: 'c', quantity_available: 0, source_name: 'Empty' }),
        ],
      }),
      ctx(),
    );
    expect(d.recommended).toBeNull();
    expect(d.excluded.map((e) => e.label).sort()).toEqual(['Empty', 'Inactive', 'Old']);
  });

  it('flags stale quotes and lowers confidence', () => {
    const fresh = evaluateMarket(base({ offers: [offer({})] }), ctx());
    const stale = evaluateMarket(base({ offers: [offer({ age_minutes: 900 })] }), ctx());
    expect(stale.recommended?.stale).toBe(true);
    expect(stale.recommended?.flags.join(' ')).toMatch(/stale/i);
    expect(stale.confidence).toBeLessThan(fresh.confidence);
  });

  it('uses substitutes only when enabled', () => {
    const input = base({
      substituteIds: ['p2'],
      offers: [offer({ offer_id: 'sub', part_id: 'p2', part_name: SUB.name, unit_price_cents: 1500 })],
    });
    expect(evaluateMarket(input, ctx({ allowSubstitutes: false })).recommended).toBeNull();
    const on = evaluateMarket(input, ctx({ allowSubstitutes: true }));
    expect(on.recommended?.isSubstitute).toBe(true);
  });

  it('builds a split plan when no single source covers the quantity', () => {
    const d = evaluateMarket(
      base({
        offers: [
          offer({ offer_id: 'a', quantity_available: 2 }),
          offer({ offer_id: 'b', source_id: 's2', source_name: 'Vendor B', quantity_available: 3 }),
        ],
      }),
      ctx({ quantity: 5 }),
    );
    expect(d.recommended).toBeNull();
    expect(d.splitPlan?.reduce((s, l) => s + l.quantity, 0)).toBe(5);
  });

  it('returns no viable source when nothing exists', () => {
    const d = evaluateMarket(base(), ctx());
    expect(d.buyVsBorrow.verdict).toBe('none');
    expect(d.confidence).toBeLessThan(0.5);
  });
});
