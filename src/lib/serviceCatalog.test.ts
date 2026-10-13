import { describe, expect, it } from 'vitest';
import {
  EMPTY_CATALOG_FORM,
  EMPTY_FILTERS,
  UNCATEGORIZED_FILTER,
  appendTag,
  catalogStats,
  collectKnownSkills,
  describeCatalogError,
  estimateTotalCents,
  filterCatalog,
  formatCatalogPrice,
  formatDuration,
  groupCatalog,
  itemToForm,
  normalizeCatalogItem,
  parseMoneyToCents,
  parseTags,
  resolveAiQuote,
  validateCatalogForm,
  type CatalogCategory,
  type CatalogFormState,
  type CatalogItem,
} from '@/lib/serviceCatalog';

const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  id: 'i1',
  category_id: null,
  name: 'Drain cleaning',
  description: null,
  pricing_model: 'flat',
  price_cents: 20000,
  min_charge_cents: null,
  duration_minutes: 60,
  required_skills: [],
  tax_class: 'taxable',
  bookable: true,
  ai_quote_mode: 'quote',
  ai_range_pct: 15,
  ai_max_discount_pct: 0,
  ai_price_floor_cents: null,
  ai_approval_above_cents: null,
  ai_keywords: [],
  ai_notes: null,
  sort_order: 0,
  ...over,
});

const form = (over: Partial<CatalogFormState> = {}): CatalogFormState => ({
  ...EMPTY_CATALOG_FORM,
  name: 'Drain cleaning',
  price: '149.50',
  ...over,
});

describe('parsing helpers', () => {
  it('parses money into integer cents', () => {
    expect(parseMoneyToCents('149')).toBe(14900);
    expect(parseMoneyToCents('$1,250.5')).toBe(125050);
    expect(parseMoneyToCents('0')).toBe(0);
  });

  it('rejects malformed, negative and oversized amounts', () => {
    for (const bad of ['', 'abc', '-5', '1.234', '.5', '1e3', '1000001']) {
      expect(parseMoneyToCents(bad)).toBeNull();
    }
  });

  it('parses tags trimmed and case-insensitively de-duplicated', () => {
    expect(parseTags(' HVAC, refrigerant\nhvac ,, ')).toEqual(['HVAC', 'refrigerant']);
    expect(appendTag('HVAC', 'hvac')).toBe('HVAC');
    expect(appendTag('HVAC', 'Gas')).toBe('HVAC, Gas');
  });

  it('formats durations and prices', () => {
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(120)).toBe('2 h');
    expect(formatDuration(90)).toBe('1 h 30 min');
    expect(formatCatalogPrice(item({ price_cents: 14950 }))).toBe('$149.50');
    expect(formatCatalogPrice(item({ pricing_model: 'hourly', price_cents: 9500, min_charge_cents: 7500 }))).toBe(
      '$95/hr · $75 min',
    );
  });

  it('estimates hourly totals with the minimum charge', () => {
    const hourly = { pricing_model: 'hourly' as const, price_cents: 10000, min_charge_cents: 15000, duration_minutes: 60 };
    expect(estimateTotalCents(hourly)).toBe(15000);
    expect(estimateTotalCents({ ...hourly, duration_minutes: 180 })).toBe(30000);
    expect(estimateTotalCents(item())).toBe(20000);
  });
});

describe('validateCatalogForm', () => {
  it('builds a clean payload', () => {
    const { errors, payload } = validateCatalogForm(
      form({ required_skills: 'Plumbing, plumbing, Drains', ai_notes: '  note  ', description: ' d ' }),
    );
    expect(errors).toEqual({});
    expect(payload).toMatchObject({
      name: 'Drain cleaning',
      price_cents: 14950,
      duration_minutes: 60,
      required_skills: ['Plumbing', 'Drains'],
      ai_notes: 'note',
      description: 'd',
      category_id: null,
      min_charge_cents: null,
    });
  });

  it('flags required and out-of-range fields', () => {
    const { errors, payload } = validateCatalogForm(form({ name: ' ', price: '', duration: '2' }));
    expect(payload).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(['duration', 'name', 'price']);
  });

  it('keeps the minimum charge for hourly only', () => {
    expect(validateCatalogForm(form({ pricing_model: 'hourly', min_charge: '75' })).payload?.min_charge_cents).toBe(7500);
    expect(validateCatalogForm(form({ pricing_model: 'flat', min_charge: '75' })).payload?.min_charge_cents).toBeNull();
    expect(validateCatalogForm(form({ pricing_model: 'hourly', min_charge: 'x' })).errors.min_charge).toBeTruthy();
  });

  it('rejects a price floor above the price and too many skills', () => {
    expect(validateCatalogForm(form({ ai_price_floor: '200' })).errors.ai_price_floor).toBeTruthy();
    const many = Array.from({ length: 21 }, (_, i) => `skill${i}`).join(',');
    expect(validateCatalogForm(form({ required_skills: many })).errors.required_skills).toBeTruthy();
  });

  it('caps the AI discount at 50%', () => {
    expect(validateCatalogForm(form({ ai_max_discount_pct: '51' })).errors.ai_max_discount_pct).toBeTruthy();
    expect(validateCatalogForm(form({ ai_max_discount_pct: '50' })).errors.ai_max_discount_pct).toBeUndefined();
  });

  it('round-trips an item through the form', () => {
    const original = item({
      category_id: 'c1',
      pricing_model: 'hourly',
      price_cents: 9550,
      min_charge_cents: 7500,
      required_skills: ['HVAC'],
      ai_price_floor_cents: 5000,
      ai_keywords: ['no cooling'],
      ai_notes: 'Parts extra',
    });
    const { payload } = validateCatalogForm(itemToForm(original));
    const { id, sort_order, ...expected } = original;
    expect(id).toBe('i1');
    expect(sort_order).toBe(0);
    expect(payload).toEqual(expected);
  });
});

describe('resolveAiQuote', () => {
  it('quotes the exact price and clamps discounts to the maximum and the floor', () => {
    const rule = item({ ai_max_discount_pct: 10, ai_price_floor_cents: 19000 });
    expect(resolveAiQuote(rule).minCents).toBe(20000);
    expect(resolveAiQuote(rule, { requestedDiscountPct: 5 }).minCents).toBe(19000);
    expect(resolveAiQuote(rule, { requestedDiscountPct: 40 }).minCents).toBe(19000);
    expect(resolveAiQuote(item({ ai_max_discount_pct: 10 }), { requestedDiscountPct: 40 }).minCents).toBe(18000);
  });

  it('quotes a range around the price, respecting the floor', () => {
    const d = resolveAiQuote(item({ ai_quote_mode: 'range', ai_range_pct: 15 }));
    expect(d).toMatchObject({ action: 'range', minCents: 17000, maxCents: 23000 });
    const floored = resolveAiQuote(item({ ai_quote_mode: 'range', ai_range_pct: 15, ai_price_floor_cents: 19000 }));
    expect(floored.minCents).toBe(19000);
  });

  it('never states a price when set to visit or never', () => {
    expect(resolveAiQuote(item({ ai_quote_mode: 'visit_required' }))).toMatchObject({ action: 'visit', minCents: null, maxCents: null });
    expect(resolveAiQuote(item({ ai_quote_mode: 'never' }))).toMatchObject({ action: 'handoff', minCents: null, maxCents: null });
  });

  it('flags quotes above the approval threshold', () => {
    expect(resolveAiQuote(item({ ai_approval_above_cents: 15000 })).requiresApproval).toBe(true);
    expect(resolveAiQuote(item({ ai_approval_above_cents: 20000 })).requiresApproval).toBe(false);
    expect(resolveAiQuote(item({ ai_quote_mode: 'range', ai_approval_above_cents: 22000 })).requiresApproval).toBe(true);
  });

  it('describes hourly rates per hour', () => {
    const d = resolveAiQuote(item({ pricing_model: 'hourly', price_cents: 9500, min_charge_cents: 7500 }));
    expect(d.unit).toBe('hour');
    expect(d.message).toContain('/hr');
    expect(d.message).toContain('minimum charge $75');
  });
});

describe('grouping and filtering', () => {
  const cats: CatalogCategory[] = [
    { id: 'b', name: 'Plumbing', sort_order: 1 },
    { id: 'a', name: 'HVAC', sort_order: 0 },
    { id: 'z', name: 'Empty', sort_order: 2 },
  ];
  const items = [
    item({ id: '1', name: 'Zeta', category_id: 'b', required_skills: ['Gas'] }),
    item({ id: '2', name: 'Alpha', category_id: 'b', bookable: false }),
    item({ id: '3', name: 'Tune-up', category_id: 'a', ai_keywords: ['no cooling'] }),
    item({ id: '4', name: 'Loose', category_id: 'deleted-category' }),
  ];

  it('orders sections, skips empty ones and puts orphans under Uncategorized', () => {
    const sections = groupCatalog(items, cats);
    expect(sections.map((s) => s.name)).toEqual(['HVAC', 'Plumbing', 'Uncategorized']);
    expect(sections[1].items.map((i) => i.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('filters by query, category and bookable', () => {
    expect(filterCatalog(items, { ...EMPTY_FILTERS, query: 'GAS' }).map((i) => i.id)).toEqual(['1']);
    expect(filterCatalog(items, { ...EMPTY_FILTERS, query: 'no cooling' }).map((i) => i.id)).toEqual(['3']);
    expect(filterCatalog(items, { ...EMPTY_FILTERS, categoryId: 'b', bookable: 'no' }).map((i) => i.id)).toEqual(['2']);
    expect(filterCatalog([item({ id: '9' }), ...items], { ...EMPTY_FILTERS, categoryId: UNCATEGORIZED_FILTER }).map((i) => i.id)).toEqual(['9']);
  });

  it('computes stats and known skills', () => {
    const withMode = [...items, item({ id: '5', ai_quote_mode: 'never', required_skills: ['gas', 'Drains'] })];
    expect(catalogStats(withMode, cats)).toEqual({ services: 5, bookable: 4, restrictedByAi: 1, categories: 3 });
    expect(collectKnownSkills(withMode)).toEqual(['Gas', 'Drains']);
  });
});

describe('normalizeCatalogItem and describeCatalogError', () => {
  it('tolerates nulls and unknown enum values', () => {
    const n = normalizeCatalogItem({
      id: 'x',
      name: 'N',
      pricing_model: 'weird',
      tax_class: null,
      required_skills: null,
      ai_keywords: ['a', 3],
      price_cents: '1500',
      bookable: null,
    });
    expect(n).toMatchObject({
      pricing_model: 'flat',
      tax_class: 'taxable',
      required_skills: [],
      ai_keywords: ['a'],
      price_cents: 1500,
      bookable: true,
      ai_quote_mode: 'quote',
      duration_minutes: 60,
    });
  });

  it('maps database errors to readable sentences', () => {
    expect(describeCatalogError({ code: '23505', message: 'dup' })).toMatch(/already exists/);
    expect(describeCatalogError({ code: '42501', message: 'rls' })).toMatch(/permission/);
    expect(describeCatalogError({ code: '23514', message: 'service_catalog: category limit reached (100)' })).toBe(
      'Category limit reached (100).',
    );
    expect(describeCatalogError(new Error('boom'))).toMatch(/try again/i);
    expect(describeCatalogError(null)).toMatch(/try again/i);
  });
});
