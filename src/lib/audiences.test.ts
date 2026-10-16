import { describe, it, expect, vi } from 'vitest';

// The pure helpers under test never touch the network.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  applyScoreFilter,
  createRule,
  describeFilter,
  filterToRules,
  inactiveCutoffIso,
  neutralizeFormula,
  rulesToFilter,
  sanitizeValue,
  validateRules,
  type AudienceRule,
} from './audiences';

const rule = (field: AudienceRule['field'], patch: Partial<AudienceRule>): AudienceRule => ({ ...createRule(field), ...patch });

describe('rulesToFilter', () => {
  it('emits exactly the keys the server segment evaluator understands', () => {
    const f = rulesToFilter('customer', [
      rule('lifecycle_stage', { values: ['vip', 'active'] }),
      rule('tags', { values: ['hvac'] }),
      rule('inactive_days', { number: 90 }),
      rule('min_score', { number: 40 }),
    ]);
    expect(f).toEqual({ entity: 'customer', lifecycle_stage: ['vip', 'active'], tags: ['hvac'], inactive_days: 90, min_score: 40 });
  });

  it('skips incomplete rules and rules that do not apply to the entity', () => {
    const f = rulesToFilter('lead', [rule('stage', { values: [] }), rule('tags', { values: ['x'] }), rule('max_score', { number: 70 })]);
    expect(f).toEqual({ entity: 'lead', max_score: 70 });
  });

  it('strips characters that would break PostgREST syntax', () => {
    expect(sanitizeValue('a,b){"c"}')).toBe('a b c');
    expect(rulesToFilter('customer', [rule('tags', { values: ['x,y', 'x y'] })]).tags).toEqual(['x y']);
  });
});

describe('filterToRules (round trip, legacy rows)', () => {
  it('round-trips a stored filter', () => {
    const stored = { entity: 'customer', source: ['call'], inactive_days: 30 };
    const { entity, rules } = filterToRules(stored);
    expect(rulesToFilter(entity, rules)).toEqual(stored);
  });

  it('defaults empty/unknown filters to "all customers"', () => {
    expect(filterToRules({})).toMatchObject({ entity: 'customer', rules: [] });
    expect(filterToRules(null).rules).toEqual([]);
    expect(describeFilter({})).toBe('Customers · everyone');
  });
});

describe('validateRules', () => {
  it('rejects min > max score', () => {
    expect(validateRules('customer', [rule('min_score', { number: 80 }), rule('max_score', { number: 20 })])).toMatch(/Minimum/);
  });
  it('rejects duplicates, incomplete and out-of-range rules', () => {
    expect(validateRules('customer', [rule('tags', { values: ['a'] }), rule('tags', { values: ['b'] })])).toMatch(/more than once/);
    expect(validateRules('customer', [rule('source', {})])).toMatch(/Finish/);
    expect(validateRules('customer', [rule('min_score', { number: 500 })])).toMatch(/between/);
  });
  it('accepts a valid list', () => {
    expect(validateRules('lead', [rule('stage', { values: ['new'] })])).toBeNull();
  });
});

describe('applyScoreFilter', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const scores = new Map([['a', 80], ['b', 30]]);
  it('treats unscored contacts as 0, like the server', () => {
    expect(applyScoreFilter(rows, scores, 50).map((r) => r.id)).toEqual(['a']);
    expect(applyScoreFilter(rows, scores, undefined, 30).map((r) => r.id)).toEqual(['b', 'c']);
    expect(applyScoreFilter(rows, scores)).toBe(rows);
  });
});

describe('helpers', () => {
  it('computes the inactivity cutoff', () => {
    expect(inactiveCutoffIso(1, Date.parse('2026-01-02T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z');
  });
  it('neutralizes CSV formula injection', () => {
    expect(neutralizeFormula('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(neutralizeFormula('Jane')).toBe('Jane');
    expect(neutralizeFormula(null)).toBe('');
  });
});
