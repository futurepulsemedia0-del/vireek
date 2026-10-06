import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));

import {
  buildChains,
  buildInsights,
  comparePrice,
  confidenceFor,
  shrink,
  summarize,
  tierFor,
  type ChainInput,
  type ChainInstall,
  type ChainLot,
} from './supplyChainOutcome';

const lot = (over: Partial<ChainLot>): ChainLot => ({
  id: 'l1', part_id: 'p1', part_name: 'Capacitor', manufacturer: 'Genteq', distributor: null,
  supplier_name: 'Ace Supply', vendor_id: null, market_source_id: null, authenticity: 'verified',
  promised_at: '2027-01-01T10:00:00Z', received_at: '2027-01-01T09:00:00Z', quantity_received: 50,
  unit_cost_cents: 1900, custody_stages: [], ...over,
});

const inst = (n: number, lotId: string, outcome: ChainInstall['outcome_class'], extra: Partial<ChainInstall> = {}): ChainInstall[] =>
  Array.from({ length: n }, (_, k) => ({
    install_id: `${lotId}-${outcome}-${k}`, job_id: `${lotId}-${outcome}-j${k}`, part_id: 'p1', part_name: 'Capacitor',
    lot_id: lotId, quantity: 1, outcome_class: outcome, caused_callback: outcome === 'failure',
    is_rework: false, customer_rating: null, defect_attributed: false, installed_at: '2027-01-02T00:00:00Z', ...extra,
  }));

/** cheap chain fails often; premium chain almost never. */
const input = (): ChainInput => ({
  lots: [
    lot({ id: 'cheap', supplier_name: 'Discount Parts', manufacturer: 'NoName', unit_cost_cents: 1200 }),
    lot({ id: 'prem', supplier_name: 'Ace Supply', manufacturer: 'Genteq', unit_cost_cents: 1900 }),
  ],
  installs: [
    ...inst(12, 'cheap', 'success'), ...inst(8, 'cheap', 'failure'),
    ...inst(19, 'prem', 'success'), ...inst(1, 'prem', 'failure'),
  ],
  events: [],
});

describe('shrink', () => {
  it('pulls tiny samples toward the baseline', () => {
    expect(shrink(1, 1, 0.8)).toBeLessThan(0.9);
    expect(shrink(0, 0, 0.8)).toBeCloseTo(0.8);
  });
  it('lets large samples dominate', () => {
    expect(shrink(95, 100, 0.5)).toBeGreaterThan(0.9);
  });
});

describe('tiers & confidence', () => {
  it('quarantines any counterfeit chain regardless of score', () => expect(tierFor(99, 1)).toBe('quarantine'));
  it('maps score bands', () => {
    expect(tierFor(85, 0)).toBe('preferred');
    expect(tierFor(70, 0)).toBe('approved');
    expect(tierFor(55, 0)).toBe('watch');
    expect(tierFor(30, 0)).toBe('avoid');
  });
  it('grades confidence by decided jobs', () => {
    expect(confidenceFor(2)).toBe('low');
    expect(confidenceFor(8)).toBe('medium');
    expect(confidenceFor(40)).toBe('high');
  });
});

describe('cheapest part ≠ best part', () => {
  it('ranks the premium chain first by expected cost per outcome', () => {
    const chains = buildChains(input());
    expect(chains[0].supplier).toBe('Ace Supply');
    expect(chains[0].successProbability).toBeGreaterThan(chains[1].successProbability);
  });
  it('explains why the cheapest chain loses', () => {
    const r = comparePrice(buildChains(input()));
    expect(r.cheapest?.supplier).toBe('Discount Parts');
    expect(r.best?.supplier).toBe('Ace Supply');
    expect(r.savingPerRepairCents).toBeGreaterThan(0);
    expect(r.insight).toContain('cheapest');
  });
  it('gives no insight when the cheapest chain is also the best', () => {
    const only = { ...input(), lots: [input().lots[1]] };
    expect(comparePrice(buildChains(only)).insight).toBeNull();
  });
  it('a pricier failure cost widens the gap', () => {
    const lo = comparePrice(buildChains(input(), { failureCostCents: 10_000 })).savingPerRepairCents;
    const hi = comparePrice(buildChains(input(), { failureCostCents: 60_000 })).savingPerRepairCents;
    expect(hi).toBeGreaterThan(lo);
  });
});

describe('authenticity', () => {
  it('caps a counterfeit chain and ranks it last', () => {
    const data = input();
    data.lots.push(lot({ id: 'fake', supplier_name: 'Grey Market', manufacturer: 'Genteq', authenticity: 'counterfeit', unit_cost_cents: 400 }));
    const chains = buildChains(data);
    const fake = chains.find((c) => c.supplier === 'Grey Market')!;
    expect(fake.tier).toBe('quarantine');
    expect(fake.score).toBeLessThanOrEqual(35);
    expect(chains[chains.length - 1].supplier).toBe('Grey Market');
    expect(comparePrice(chains).cheapest?.supplier).not.toBe('Grey Market');
  });
  it('emits a critical insight for quarantined chains', () => {
    const data = input();
    data.lots.push(lot({ id: 'fake', supplier_name: 'Grey Market', authenticity: 'counterfeit' }));
    const chains = buildChains(data);
    const insights = buildInsights(chains, summarize(chains, data.installs), data.lots);
    expect(insights[0].severity).toBe('critical');
  });
});

describe('delivery & events', () => {
  it('penalises late deliveries', () => {
    const late = lot({ id: 'late', supplier_name: 'Slow Co', manufacturer: 'Genteq', received_at: '2027-01-03T10:00:00Z' });
    const ok = lot({ id: 'ok', supplier_name: 'Fast Co', manufacturer: 'Genteq' });
    const chains = buildChains({ lots: [late, ok], installs: [], events: [] });
    const d = (name: string) => chains.find((c) => c.supplier === name)!.dimensions.find((x) => x.key === 'delivery')!.score;
    expect(d('Slow Co')).toBeLessThan(d('Fast Co'));
  });
  it('lowers defect-free score when defects are recorded', () => {
    const base = buildChains({ lots: [lot({})], installs: [], events: [] })[0];
    const bad = buildChains({ lots: [lot({})], installs: [], events: [{ id: 'e', lot_id: 'l1', event_type: 'doa', quantity: 5 }] })[0];
    expect(bad.score).toBeLessThan(base.score);
  });
});

describe('traceability', () => {
  it('counts installs with no lot as untraced', () => {
    const installs = [...inst(3, 'prem', 'success'), ...inst(1, 'x', 'success', { lot_id: null })];
    const s = summarize(buildChains({ lots: [lot({ id: 'prem' })], installs, events: [] }), installs);
    expect(s.untracedInstalls).toBe(1);
    expect(s.traceability).toBeCloseTo(0.75);
  });
  it('is safe with no data at all', () => {
    const s = summarize(buildChains({ lots: [], installs: [], events: [] }), []);
    expect(s).toEqual({ chains: 0, avgSuccessProbability: 0, traceability: 0, untracedInstalls: 0, quarantined: 0 });
  });
});
