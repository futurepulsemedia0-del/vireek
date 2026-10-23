import { describe, it, expect } from 'vitest';
import {
  applyCandidate,
  applyManualPrice,
  applyQuantityEdit,
  buildCatalogIndex,
  buildItemRows,
  buildQuoteDraft,
  buildQuotePayload,
  buildTierLines,
  calibrateConfidence,
  computeLabor,
  computeOverallConfidence,
  computeTierTotals,
  confidenceBand,
  createManualItem,
  DEFAULT_SETTINGS,
  evaluateReviewGate,
  extractJson,
  finalQuantity,
  matchItem,
  normalizeTakeoff,
  normalizeUnit,
  pickLaborRate,
  repriceForMarkup,
  requiresReview,
  resolveLaborHours,
  summarizeAccuracy,
  tokenize,
  type Catalog,
  type ProjectSettings,
  type TakeoffItem,
} from './engine.ts';

// ---------------------------------------------------------------- fixtures --

const SETTINGS: ProjectSettings = { ...DEFAULT_SETTINGS, labor_rate_cents: 10_000, labor_cost_rate_cents: 4_500, markup_percent: 30 };

function item(over: Partial<TakeoffItem> = {}): TakeoffItem {
  return {
    id: over.id ?? 'i1',
    room_id: null,
    sort_order: 0,
    kind: 'material',
    description: 'Duplex outlet 15A',
    category: 'Electrical',
    unit: 'ea',
    net_quantity: 10,
    waste_percent: 0,
    quantity: 10,
    ai_quantity: 10,
    basis: 'counted',
    confidence: 0.9,
    evidence: 'Legend shows 10 duplex symbols',
    source_ref: 'p2',
    source: 'ai',
    tier_scope: 'all',
    labor_hours_each: 0.4,
    labor_included: false,
    price_source: 'supplier_catalog',
    price_locked: false,
    price_book_item_id: null,
    inventory_part_id: 'part-outlet',
    vendor_id: 'v1',
    vendor_name: 'Acme Supply',
    vendor_sku: 'AC-100',
    lead_time_days: 2,
    unit_cost_cents: 200,
    unit_price_cents: 260,
    price_confidence: 0.9,
    match_status: 'matched',
    match_candidates: [],
    flags: [],
    review_status: 'confirmed',
    ...over,
  };
}

const CATALOG: Catalog = {
  priceBook: [
    { id: 'pb-labor', service_name: 'Electrician hourly rate', category: 'Electrical', pricing_model: 'hourly', price_cents: 12_500, price_max_cents: null, cost_cents: 5_000, unit_label: '/hr', keywords: [] },
    { id: 'pb-fan', service_name: 'Install ceiling fan', category: 'Electrical', pricing_model: 'flat', price_cents: 28_000, price_max_cents: null, cost_cents: 12_000, unit_label: 'each', keywords: ['paddle fan'] },
    { id: 'pb-toilet', service_name: 'Toilet replacement', category: 'Plumbing', pricing_model: 'starting_at', price_cents: 35_000, price_max_cents: null, cost_cents: null, unit_label: 'each', keywords: ['commode'] },
    { id: 'pb-drain', service_name: 'Drain cleaning', category: 'Plumbing', pricing_model: 'range', price_cents: 15_000, price_max_cents: 25_000, cost_cents: null, unit_label: null, keywords: [] },
  ],
  parts: [
    { id: 'part-outlet', part_number: 'AC-100', name: 'Duplex receptacle 15A white', category: 'Electrical', unit_label: 'each', unit_cost_cents: 250, price_book_item_id: null,
      offers: [
        { vendor_id: 'v-cheap', vendor_name: 'Cheap Co', vendor_sku: 'CH-1', unit_cost_cents: 180, lead_time_days: 5, is_preferred: false },
        { vendor_id: 'v-pref', vendor_name: 'Preferred Inc', vendor_sku: 'PF-1', unit_cost_cents: 210, lead_time_days: 1, is_preferred: true },
      ] },
    { id: 'part-dw-half', part_number: null, name: 'Drywall sheet 1/2" 4x8', category: 'Drywall', unit_label: 'sheet', unit_cost_cents: 1200, price_book_item_id: null,
      offers: [{ vendor_id: 'v1', vendor_name: 'Acme', vendor_sku: 'DW12', unit_cost_cents: 1100, lead_time_days: 2, is_preferred: false }] },
    { id: 'part-dw-58', part_number: null, name: 'Drywall sheet 5/8" 4x8', category: 'Drywall', unit_label: 'sheet', unit_cost_cents: 1500, price_book_item_id: null, offers: [] },
    { id: 'part-linked', part_number: null, name: 'LED recessed light 6in', category: 'Electrical', unit_label: 'each', unit_cost_cents: 900, price_book_item_id: 'pb-fan', offers: [] },
  ],
};

const INDEX = buildCatalogIndex(CATALOG);

const RAW = {
  project: { summary: 'Two-room remodel', scale_detected: '1/4" = 1\'', scale_confidence: 0.9, plan_quality: 'clear', total_area_sqft: 400 },
  rooms: [
    { ref: 'R1', name: 'Kitchen', room_type: 'kitchen', level: 'Main', length_ft: 15, width_ft: 12, height_ft: 9, area_sqft: 180, confidence: 0.9, evidence: 'Dimension string 15\'x12\'', source_ref: 'p1' },
    { ref: 'R2', name: 'Bath', room_type: 'bathroom', length_ft: 10, width_ft: 8, area_sqft: 120, confidence: 0.8, evidence: 'Dimension label', source_ref: 'p1' },
  ],
  items: [
    { room_ref: 'R1', kind: 'fixture', description: 'Duplex outlet 15A', category: 'electrical', unit: 'each', net_quantity: 8, basis: 'counted', confidence: 0.9, evidence: '8 outlet symbols', source_ref: 'p2', search_terms: ['receptacle'], tier_scope: 'all', labor_hours_each: 0.4, ballpark_unit_price_cents: 300 },
    { room_ref: 'R1', kind: 'material', description: 'Drywall 1/2" sheet', category: 'Drywall', unit: 'sheet', net_quantity: 30, basis: 'inferred', confidence: 0.7, evidence: 'wall perimeter from scale', source_ref: 'p1', search_terms: ['sheetrock'], tier_scope: 'all', labor_hours_each: 0.4, ballpark_unit_price_cents: 1300 },
    { room_ref: 'R2', kind: 'fixture', description: 'Toilet', category: 'Plumbing', unit: 'ea', net_quantity: 1, basis: 'counted', confidence: 0.95, evidence: 'WC symbol', source_ref: 'p3', search_terms: ['commode'], tier_scope: 'all', labor_hours_each: 1.5, ballpark_unit_price_cents: 18000 },
    { room_ref: 'R1', kind: 'fixture', description: 'Ceiling fan', category: 'Electrical', unit: 'ea', net_quantity: 1, basis: 'counted', confidence: 0.85, evidence: 'fan symbol', source_ref: 'p2', search_terms: [], tier_scope: 'better_plus', labor_hours_each: 1.25, ballpark_unit_price_cents: 20000 },
    { room_ref: null, kind: 'material', description: 'Heated floor mat', category: 'Flooring', unit: 'sqft', net_quantity: 40, basis: 'assumed', confidence: 0.4, evidence: '', tier_scope: 'best_only', labor_hours_each: 0.05, ballpark_unit_price_cents: 1500 },
  ],
  assumptions: ['Standard 9ft ceilings'],
  missing_info: [],
};

// ------------------------------------------------------------------- units --

describe('normalizeUnit / tokenize', () => {
  it('maps common spellings to canonical units', () => {
    expect(normalizeUnit('Sq Ft')).toBe('sqft');
    expect(normalizeUnit('each')).toBe('ea');
    expect(normalizeUnit('per linear ft')).toBe('lf');
    expect(normalizeUnit('')).toBe('ea');
    expect(normalizeUnit(undefined)).toBe('ea');
  });

  it('keeps sizes, applies synonyms and stems plurals', () => {
    const t = tokenize('Receptacles 15A, 1/2" Sheetrock');
    expect(t).toContain('outlet');
    expect(t).toContain('15a');
    expect(t).toContain('1/2');
    expect(t).toContain('drywall');
  });
});

// -------------------------------------------------------------- confidence --

describe('calibrateConfidence', () => {
  const base = { model: 0.9, hasEvidence: true, planQuality: 'clear' as const, scaleConfidence: 0.9 };

  it('trusts counted > measured > inferred > assumed at equal model confidence', () => {
    const c = (basis: 'counted' | 'measured' | 'inferred' | 'assumed') => calibrateConfidence({ ...base, basis });
    expect(c('counted')).toBeGreaterThan(c('measured'));
    expect(c('measured')).toBeGreaterThan(c('inferred'));
    expect(c('inferred')).toBeGreaterThan(c('assumed'));
  });

  it('never reports certainty and haircuts missing evidence, poor plans and unknown scale', () => {
    expect(calibrateConfidence({ ...base, model: 1, basis: 'counted' })).toBeLessThan(1);
    const clean = calibrateConfidence({ ...base, basis: 'inferred' });
    expect(calibrateConfidence({ ...base, basis: 'inferred', hasEvidence: false })).toBeLessThan(clean);
    expect(calibrateConfidence({ ...base, basis: 'inferred', planQuality: 'poor' })).toBeLessThan(clean);
    expect(calibrateConfidence({ ...base, basis: 'inferred', scaleConfidence: 0.2 })).toBeLessThan(clean);
    // a printed dimension label does not depend on the scale
    expect(calibrateConfidence({ ...base, basis: 'measured', scaleConfidence: 0.2 })).toBe(calibrateConfidence({ ...base, basis: 'measured' }));
  });

  it('bands confidence', () => {
    expect(confidenceBand(0.9)).toBe('high');
    expect(confidenceBand(0.6)).toBe('medium');
    expect(confidenceBand(0.2)).toBe('low');
  });
});

// ---------------------------------------------------------- normalizeTakeoff --

describe('normalizeTakeoff', () => {
  it('rejects non-objects and empty output', () => {
    expect(normalizeTakeoff(null)).toBeNull();
    expect(normalizeTakeoff('nope')).toBeNull();
    expect(normalizeTakeoff({ rooms: [], items: [] })).toBeNull();
  });

  it('normalizes a realistic response', () => {
    const n = normalizeTakeoff(RAW)!;
    expect(n.rooms).toHaveLength(2);
    expect(n.items).toHaveLength(5);
    expect(n.items[0].unit).toBe('ea');
    expect(n.items[0].category).toBe('Electrical');
    expect(n.items.every((i) => i.confidence < 1 && i.confidence > 0)).toBe(true);
    expect(n.items[4].confidence).toBeLessThan(n.items[0].confidence);
  });

  it('drops invalid items and unknown room refs, clamps numbers', () => {
    const n = normalizeTakeoff({
      rooms: [{ ref: 'R1', name: 'Hall' }],
      items: [
        { description: '', net_quantity: 3 },
        { description: 'Bad qty', net_quantity: -2 },
        { description: 'NaN qty', net_quantity: 'abc' },
        { description: 'Ghost room', net_quantity: 2, room_ref: 'R9', basis: 'wat', kind: 'labor', tier_scope: 'nonsense', labor_hours_each: 999, ballpark_unit_price_cents: 9e12 },
      ],
    })!;
    expect(n.items).toHaveLength(1);
    expect(n.items[0].room_ref).toBeNull();
    expect(n.items[0].basis).toBe('inferred');
    expect(n.items[0].kind).toBe('material'); // the model may not create labor lines
    expect(n.items[0].tier_scope).toBe('all');
    expect(n.items[0].labor_hours_each).toBe(40);
    expect(n.items[0].ballpark_unit_price_cents).toBe(50_000_00);
  });

  it('flags area mismatch and derives a missing area', () => {
    const n = normalizeTakeoff({
      rooms: [
        { name: 'A', length_ft: 10, width_ft: 10, area_sqft: 200 },
        { name: 'B', length_ft: 10, width_ft: 12 },
      ],
      items: [{ description: 'x', net_quantity: 1 }],
    })!;
    expect(n.rooms[0].flags).toContain('area_mismatch');
    expect(n.rooms[1].area_sqft).toBe(120);
    expect(n.rooms[1].flags).toContain('area_derived');
    expect(n.rooms[0].confidence).toBeLessThan(n.rooms[1].confidence);
  });

  it('adds a missing-scale note and caps scale confidence', () => {
    const n = normalizeTakeoff({ project: { scale_confidence: 0.95 }, items: [{ description: 'x', net_quantity: 1 }] })!;
    expect(n.scale_detected).toBeNull();
    expect(n.scale_confidence).toBeLessThanOrEqual(0.3);
    expect(n.missing_info.some((m) => /scale/i.test(m))).toBe(true);
  });

  it('flags absurd sqft quantities against the plan area', () => {
    const n = normalizeTakeoff({
      project: { total_area_sqft: 100, scale_detected: 'x' },
      items: [{ description: 'Flooring', unit: 'sqft', net_quantity: 5000, confidence: 0.9, evidence: 'e', basis: 'measured' }],
    })!;
    expect(n.items[0].flags).toContain('quantity_outlier');
    expect(n.items[0].confidence).toBeLessThan(0.6);
  });

  it('drops exact repeats, flags near-duplicates, caps upgrades', () => {
    const dup = { room_ref: null, description: 'Outlet', net_quantity: 4, evidence: 'same', source_ref: 'p1' };
    const n = normalizeTakeoff({
      items: [dup, dup, { ...dup, evidence: 'different page', source_ref: 'p2' }],
    })!;
    expect(n.items).toHaveLength(2);
    expect(n.items.every((i) => i.flags.includes('possible_duplicate'))).toBe(true);

    const many = normalizeTakeoff({
      items: Array.from({ length: 20 }, (_, i) => ({ description: `Upgrade ${i}`, net_quantity: 1, tier_scope: 'better_plus' })),
    })!;
    expect(many.items).toHaveLength(12);
    expect(many.warnings.join(' ')).toMatch(/dropped/);
  });
});

describe('extractJson', () => {
  it('survives code fences and surrounding prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a":2} thanks')).toEqual({ a: 2 });
    expect(extractJson('no json')).toBeNull();
  });
});

// ------------------------------------------------------------ waste / labor --

describe('quantity and labor', () => {
  it('rounds up to whole units after waste', () => {
    expect(finalQuantity(30, 10)).toBe(33);
    expect(finalQuantity(10, 10)).toBe(11);
    expect(finalQuantity(0.2, 0)).toBe(1);
    expect(finalQuantity(0, 10)).toBe(0);
  });

  it('keeps the model hours only inside 0.5x-2x of the table', () => {
    const base = { kind: 'fixture' as const, description: 'Toilet', category: 'Plumbing', unit: 'ea', labor_included: false };
    expect(resolveLaborHours({ ...base, ai_hours: 1.5 })).toEqual({ hours: 1.5, flag: null });
    expect(resolveLaborHours({ ...base, ai_hours: 0.1 })).toEqual({ hours: 0.75, flag: 'labor_clamped' });
    expect(resolveLaborHours({ ...base, ai_hours: 20 })).toEqual({ hours: 3, flag: 'labor_clamped' });
    expect(resolveLaborHours({ ...base, ai_hours: null }).hours).toBe(1.5);
    expect(resolveLaborHours({ ...base, ai_hours: 5, labor_included: true }).hours).toBe(0);
  });

  it('adds overhead, rounds up to a quarter hour, honours overrides and missing rate', () => {
    const items = [
      item({ id: 'a', quantity: 10, labor_hours_each: 0.4, category: 'Electrical' }), // 4h -> 4.4 -> 4.5
      item({ id: 'b', quantity: 2, labor_hours_each: 1.5, category: 'Plumbing' }), // 3h -> 3.3 -> 3.5
      item({ id: 'c', quantity: 5, labor_hours_each: 1, labor_included: true, category: 'Plumbing' }), // excluded
    ];
    const labor = computeLabor(items, SETTINGS);
    expect(labor.groups.map((g) => [g.category, g.hours])).toEqual([['Electrical', 4.5], ['Plumbing', 3.5]]);
    expect(labor.sellCents).toBe(Math.round(4.5 * 10_000) + Math.round(3.5 * 10_000));
    expect(labor.costCents).toBe(Math.round(4.5 * 4_500) + Math.round(3.5 * 4_500));

    const overridden = computeLabor(items, { ...SETTINGS, labor_overrides: { Electrical: 6 } });
    expect(overridden.groups[0]).toMatchObject({ hours: 6, computedHours: 4.5, overridden: true });

    expect(computeLabor(items, { ...SETTINGS, labor_rate_cents: 0 }).missingRate).toBe(true);
    expect(computeLabor([], { ...SETTINGS, labor_rate_cents: 0 }).missingRate).toBe(false);
  });

  it('picks the hourly rate that fits the trade', () => {
    const rate = pickLaborRate(CATALOG.priceBook, 'electrical');
    expect(rate).toMatchObject({ rate_cents: 12_500, cost_cents: 5_000 });
    expect(pickLaborRate([], 'electrical')).toBeNull();
  });
});

// ----------------------------------------------------------------- matching --

describe('matchItem', () => {
  const q = (description: string, over = {}) => ({ description, category: '', unit: 'ea', search_terms: [], ...over });

  it('matches through synonyms and the price-book keywords', () => {
    const m = matchItem(q('Commode', { category: 'Plumbing' }), INDEX);
    expect(m.status).toBe('matched');
    expect(m.best?.entry_id).toBe('pb-toilet');
    expect(m.best?.flags).toContain('starting_at');
  });

  it('never matches hourly (labor-rate) price-book entries as an item', () => {
    const m = matchItem(q('Electrician hourly rate'), INDEX);
    expect(m.candidates.every((c) => c.entry_id !== 'pb-labor')).toBe(true);
  });

  it('does not let 5/8" drywall price 1/2" drywall', () => {
    const m = matchItem(q('Drywall 1/2" sheet', { unit: 'sheet', category: 'Drywall' }), INDEX);
    expect(m.best?.entry_id).toBe('part-dw-half');
    const wrong = matchItem(q('Drywall 3/4" sheet', { unit: 'sheet', category: 'Drywall' }), INDEX);
    expect(wrong.status).not.toBe('matched');
  });

  it('picks the preferred vendor, not the cheapest', () => {
    const m = matchItem(q('Duplex outlet 15A', { category: 'Electrical' }), INDEX);
    expect(m.best?.entry_id).toBe('part-outlet');
    expect(m.best).toMatchObject({ vendor_id: 'v-pref', cost_cents: 210, lead_time_days: 1 });
  });

  it('an exact part number is a certain match', () => {
    const m = matchItem(q('Receptacle AC-100 for kitchen'), INDEX);
    expect(m.best?.entry_id).toBe('part-outlet');
    expect(m.best?.score).toBe(1);
  });

  it('returns unmatched for things the business does not stock or price', () => {
    const m = matchItem(q('Heated towel rail'), INDEX);
    expect(m.status).toBe('unmatched');
    expect(m.best).toBeNull();
  });

  it('uses a price-book price linked to a catalog part as the sell price', () => {
    const m = matchItem(q('LED recessed light 6in', { category: 'Electrical' }), INDEX);
    expect(m.best?.entry_id).toBe('part-linked');
    expect(m.best).toMatchObject({ fixed_sell_cents: 28_000, cost_cents: 900, labor_included: false });
  });
});

// ------------------------------------------------------------------ pricing --

describe('buildItemRows', () => {
  const rows = buildItemRows(normalizeTakeoff(RAW)!.items, INDEX, SETTINGS);
  const byDesc = (d: string) => rows.find((r) => r.description === d)!;

  it('prices supplier parts as cost + markup and rounds quantity up with waste', () => {
    const outlet = byDesc('Duplex outlet 15A');
    expect(outlet.price_source).toBe('supplier_catalog');
    expect(outlet.unit_cost_cents).toBe(210);
    expect(outlet.unit_price_cents).toBe(Math.round(210 * 1.3));
    expect(outlet.quantity).toBe(8);

    const drywall = byDesc('Drywall 1/2" sheet');
    expect(drywall.waste_percent).toBe(10);
    expect(drywall.quantity).toBe(33);
    expect(drywall.unit_price_cents).toBe(Math.round(1100 * 1.3));
  });

  it('uses the price book as authoritative and folds labor into it', () => {
    const toilet = byDesc('Toilet');
    expect(toilet.price_source).toBe('price_book');
    expect(toilet.unit_price_cents).toBe(35_000);
    expect(toilet.labor_included).toBe(true);
    expect(toilet.labor_hours_each).toBe(0);
    expect(toilet.flags).toContain('starting_at');
  });

  it('falls back to the AI ballpark, clearly marked and low-confidence', () => {
    const mat = byDesc('Heated floor mat');
    expect(mat.price_source).toBe('ai_estimate');
    expect(mat.unit_price_cents).toBe(1500);
    expect(mat.price_confidence).toBeLessThan(0.5);
    expect(mat.flags).toContain('price_estimated');
    expect(mat.match_status).toBe('unmatched');
  });

  it('leaves no-price items unpriced rather than inventing a number', () => {
    const r = buildItemRows(normalizeTakeoff({ items: [{ description: 'Mystery widget', net_quantity: 2 }] })!.items, INDEX, SETTINGS)[0];
    expect(r.price_source).toBe('none');
    expect(r.unit_price_cents).toBeNull();
  });

  it('starts every AI line as pending review', () => {
    expect(rows.every((r) => r.review_status === 'pending' && r.source === 'ai')).toBe(true);
  });
});

// -------------------------------------------------------------- corrections --

describe('human corrections', () => {
  it('quantity edits recompute the billable quantity and mark the line edited', () => {
    const patch = applyQuantityEdit(item({ net_quantity: 30, waste_percent: 10, quantity: 33 }), { net_quantity: 40 });
    expect(patch).toMatchObject({ net_quantity: 40, quantity: 44, review_status: 'edited' });
    expect(applyQuantityEdit(item(), { waste_percent: 50, net_quantity: 10 }).quantity).toBe(15);
  });

  it('a manual price locks the line and clears estimate flags', () => {
    const patch = applyManualPrice(item({ flags: ['price_estimated', 'x'], match_status: 'unmatched' }), 1234);
    expect(patch).toMatchObject({ unit_price_cents: 1234, price_source: 'manual', price_locked: true, match_status: 'manual', price_confidence: 1 });
    expect(patch.flags).toEqual(['x']);
  });

  it('switching match re-prices and re-derives labor', () => {
    const toilet = buildItemRows(normalizeTakeoff({ items: [{ description: 'Toilet', unit: 'ea', net_quantity: 1, kind: 'fixture' }] })!.items, INDEX, SETTINGS)[0];
    expect(toilet.labor_included).toBe(true);
    const asItem = item({ ...toilet, id: 't', room_id: null, review_status: 'pending' } as Partial<TakeoffItem>);
    const part = CATALOG.parts[0];
    const cand = matchItem({ description: 'Duplex outlet', category: '', unit: 'ea', search_terms: [] }, INDEX).candidates.find((c) => c.entry_id === part.id)!;
    const patch = applyCandidate(asItem, cand, 40);
    expect(patch.unit_price_cents).toBe(Math.round(210 * 1.4));
    expect(patch.labor_included).toBe(false);
    expect(patch.labor_hours_each).toBeGreaterThan(0);
    expect(patch.review_status).toBe('edited');
    expect(patch.match_status).toBe('matched');
  });

  it('markup changes re-price supplier lines only (never locked, manual or price-book ones)', () => {
    const cand = CATALOG.parts[0].id;
    const items = [
      item({ id: 'a', unit_cost_cents: 200, unit_price_cents: 260, inventory_part_id: cand }),
      item({ id: 'b', unit_cost_cents: 200, unit_price_cents: 999, price_locked: true }),
      item({ id: 'c', price_source: 'price_book', unit_cost_cents: 100, unit_price_cents: 500 }),
      item({ id: 'd', unit_cost_cents: 200, unit_price_cents: 260, inventory_part_id: 'linked', match_candidates: [{ source: 'supplier_catalog', entry_id: 'linked', name: 'x', score: 1, fixed_sell_cents: 777, cost_cents: 200, price_book_item_id: 'pb', vendor_id: null, vendor_name: null, vendor_sku: null, lead_time_days: null, labor_included: false, flags: [] }] }),
    ];
    expect(repriceForMarkup(items, 50)).toEqual([{ id: 'a', unit_price_cents: 300 }]);
  });

  it('manual lines are born confirmed, priced and locked', () => {
    const m = createManualItem({ description: 'Permit', kind: 'fee', quantity: 1, unit_price_cents: 15_000 });
    expect(m).toMatchObject({ source: 'human', review_status: 'confirmed', price_locked: true, confidence: 1, ai_quantity: null });
  });
});

// --------------------------------------------------------------------- gate --

describe('evaluateReviewGate', () => {
  const project = { customer_name: 'Ada' };

  it('blocks until every uncertain line has a human decision', () => {
    const items = [item({ id: 'a' }), item({ id: 'b', review_status: 'pending', confidence: 0.6 })];
    const gate = evaluateReviewGate(items, SETTINGS, project);
    expect(gate.canConvert).toBe(false);
    expect(gate.blockers.find((b) => b.code === 'pending_review')?.itemIds).toEqual(['b']);

    const done = evaluateReviewGate([items[0], { ...items[1], review_status: 'confirmed' }], SETTINGS, project);
    expect(done.canConvert).toBe(true);
    expect(done.warnings.join(' ')).not.toMatch(/low-confidence/);
  });

  it('high-confidence, well-matched lines do not need individual review', () => {
    const ok = item({ id: 'a', review_status: 'pending', confidence: 0.92, price_confidence: 0.95 });
    expect(requiresReview(ok)).toBe(false);
    expect(requiresReview({ ...ok, basis: 'assumed' })).toBe(true);
    expect(requiresReview({ ...ok, match_status: 'ambiguous' })).toBe(true);
  });

  it('blocks on missing prices even for confirmed lines, and on a missing labor rate', () => {
    const items = [item({ id: 'a', unit_price_cents: null, price_source: 'none' })];
    const gate = evaluateReviewGate(items, { ...SETTINGS, labor_rate_cents: 0 }, project);
    expect(gate.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['missing_price', 'missing_labor_rate']));
  });

  it('ignores rejected lines, and requires a customer name and at least one item', () => {
    const rejected = item({ id: 'r', review_status: 'rejected', unit_price_cents: null });
    const gate = evaluateReviewGate([rejected], SETTINGS, { customer_name: ' ' });
    expect(gate.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['no_items', 'no_customer']));
    expect(gate.counts.rejected).toBe(1);
  });

  it('allows $0 fees (waived) but not $0 materials', () => {
    const fee = item({ id: 'f', kind: 'fee', unit_price_cents: 0, labor_hours_each: null });
    expect(evaluateReviewGate([fee, item()], SETTINGS, project).blockers.some((b) => b.code === 'missing_price')).toBe(false);
    expect(evaluateReviewGate([item({ unit_price_cents: 0 })], SETTINGS, project).blockers.some((b) => b.code === 'missing_price')).toBe(true);
  });
});

// ------------------------------------------------------------ totals / tiers --

describe('totals and tiered quote', () => {
  const good = item({ id: 'g', description: 'Duplex outlet', quantity: 10, unit_price_cents: 300, unit_cost_cents: 200, labor_hours_each: 0.4 });
  const better = item({ id: 'b', description: 'Ceiling fan', tier_scope: 'better_plus', quantity: 1, unit_price_cents: 28_000, unit_cost_cents: 12_000, labor_hours_each: 0 });
  const best = item({ id: 'x', description: 'Heated floor', tier_scope: 'best_only', quantity: 40, unit: 'sqft', unit_price_cents: 1500, unit_cost_cents: null, labor_hours_each: 0.1, category: 'Flooring' });
  const items = [good, better, best];
  const settings = { ...SETTINGS, tax_percent: 8 };

  it('totals include labor, tax and a margin qualified by cost coverage', () => {
    const t = computeTierTotals(items, settings, 'good');
    // materials 10 x 300 = 3000; labor 4h*1.1=4.4 -> 4.5h x 10000 = 45000
    expect(t.materialsCents).toBe(3000);
    expect(t.laborCents).toBe(45_000);
    expect(t.subtotalCents).toBe(48_000);
    expect(t.taxCents).toBe(3840);
    expect(t.totalCents).toBe(51_840);
    expect(t.costCoverage).toBe(1);
    expect(t.marginPercent).toBeCloseTo(((48_000 - (2000 + 4.5 * 4500)) / 48_000) * 100, 0);
  });

  it('prices never decrease from good to better to best', () => {
    const d = buildQuoteDraft(items, settings, (() => { let n = 0; return () => `id-${++n}`; })());
    expect(d.options.map((o) => o.tier)).toEqual(['good', 'better', 'best']);
    expect(d.totals.better.totalCents).toBeGreaterThan(d.totals.good.totalCents);
    expect(d.totals.best.totalCents).toBeGreaterThan(d.totals.better.totalCents);
    expect(d.options.filter((o) => o.recommended).map((o) => o.tier)).toEqual(['better']);
    expect(d.recommended_option_id).toBe('id-2');
    expect(d.line_items).toEqual(d.options[1].line_items);
    expect(d.options[1].highlights).toEqual(['Adds Ceiling fan']);
  });

  it('quote line totals equal the takeoff subtotal for every tier', () => {
    const d = buildQuoteDraft(items, settings, () => 'id');
    for (const o of d.options) {
      const sum = o.line_items.reduce((s, l) => s + l.quantity * l.unit_price_cents, 0);
      expect(sum).toBe(d.totals[o.tier].subtotalCents);
      expect(o.line_items.every((l) => Number.isInteger(l.quantity) && Number.isInteger(l.unit_price_cents) && l.quantity >= 1)).toBe(true);
    }
  });

  it('drops a tier that adds nothing and falls back to a classic quote with no upgrades', () => {
    const two = buildQuoteDraft([good, better], settings, () => 'id');
    expect(two.options.map((o) => o.tier)).toEqual(['good', 'better']);
    const skip = buildQuoteDraft([good, best], settings, () => 'id');
    expect(skip.options.map((o) => o.tier)).toEqual(['good', 'best']);
    expect(skip.options.find((o) => o.recommended)?.tier).toBe('best');

    const classic = buildQuoteDraft([good], settings, () => 'id');
    expect(classic.options).toEqual([]);
    expect(classic.recommended_option_id).toBeNull();
    expect(classic.line_items.length).toBeGreaterThan(0);
    expect(classic.warnings.join(' ')).toMatch(/single-price/);
  });

  it('rejected lines never reach the quote', () => {
    const d = buildQuoteDraft([good, { ...better, review_status: 'rejected' }], settings, () => 'id');
    expect(d.options).toEqual([]);
    expect(d.line_items.some((l) => l.description === 'Ceiling fan')).toBe(false);
  });

  it('consolidates identical lines across rooms and supports summary detail', () => {
    const a = item({ id: '1', room_id: 'r1', quantity: 4 });
    const b = item({ id: '2', room_id: 'r2', quantity: 6 });
    const lines = buildTierLines([a, b], SETTINGS as ProjectSettings, 'good');
    expect(lines.filter((l) => l.description === 'Duplex outlet 15A')).toHaveLength(1);
    expect(lines.find((l) => l.description === 'Duplex outlet 15A')?.quantity).toBe(10);

    const summary = buildTierLines([a, b], { ...SETTINGS, detail_level: 'summary' }, 'good');
    expect(summary[0]).toMatchObject({ description: 'Electrical — materials & fixtures', quantity: 1, unit_price_cents: 10 * 260 });
    expect(summary.some((l) => /installation labor/.test(l.description))).toBe(true);
  });

  it('builds a draft quote row linked back to the takeoff', () => {
    const d = buildQuoteDraft(items, settings, () => 'id');
    const payload = buildQuotePayload({
      userId: 'u1',
      projectId: 'p1',
      project: { name: 'Kitchen', customer_name: ' Ada ', customer_phone: '', customer_email: null, lead_id: null, overall_confidence: 0.82, ai_summary: 'Two-room remodel' },
      settings,
      draft: d,
    });
    expect(payload).toMatchObject({ status: 'draft', ai_generated: true, takeoff_project_id: 'p1', customer_name: 'Ada', customer_phone: null, tax_percent: 8, ai_confidence: 0.82 });
    expect(payload.options).toHaveLength(3);
  });
});

// ------------------------------------------------------------------- stats ---

describe('accuracy and overall confidence', () => {
  it('summarizes how often staff had to correct the AI', () => {
    const items = [
      item({ id: 'a', review_status: 'confirmed' }),
      item({ id: 'b', review_status: 'edited', ai_quantity: 10, net_quantity: 12 }),
      item({ id: 'c', review_status: 'rejected' }),
      item({ id: 'd', review_status: 'pending' }),
      item({ id: 'e', source: 'human', ai_quantity: null, review_status: 'confirmed' }),
    ];
    const s = summarizeAccuracy(items);
    expect(s).toMatchObject({ aiLines: 4, unchanged: 1, edited: 1, rejected: 1, addedByStaff: 1, meanQuantityErrorPercent: 20 });
    expect(s.hitRate).toBe(0.33);
  });

  it('weights confidence by value and treats human-verified lines as near-certain', () => {
    const big = item({ id: 'big', quantity: 1, unit_price_cents: 900_000, confidence: 0.9, review_status: 'pending' });
    const tiny = item({ id: 'tiny', quantity: 1, unit_price_cents: 100, confidence: 0.1, review_status: 'pending' });
    expect(computeOverallConfidence([big, tiny])!).toBeGreaterThan(0.85);
    expect(computeOverallConfidence([{ ...tiny, review_status: 'confirmed' }])!).toBeGreaterThanOrEqual(0.95);
    expect(computeOverallConfidence([])).toBeNull();
  });
});
