import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));

import {
  buildVarianceCsvColumns,
  classifyLine,
  countErrorMessage,
  filterLines,
  formatSigned,
  formatSignedCents,
  isNoMatchError,
  normalizeScanCode,
  parseQuantityInput,
  shouldIgnoreRescan,
  sortByVarianceImpact,
  summarizeLines,
  variancePct,
  type InventoryCountLine,
} from './inventoryCounts';

let seq = 0;
const line = (over: Partial<InventoryCountLine> = {}): InventoryCountLine => {
  seq += 1;
  return {
    line_id: `l${seq}`,
    part_id: `p${seq}`,
    part_name: `Part ${seq}`,
    part_number: null,
    category: null,
    expected_qty: 10,
    counted_qty: 10,
    variance_qty: null,
    unit_cost_cents: 1000,
    variance_value_cents: null,
    note: null,
    counted_at: null,
    added_during_count: false,
    applied_delta: null,
    ...over,
  };
};

describe('classifyLine', () => {
  it('separates uncounted, hidden (blind), match, over and short', () => {
    expect(classifyLine(line({ counted_qty: null }))).toBe('uncounted');
    expect(classifyLine(line({ expected_qty: null, counted_qty: 4 }))).toBe('hidden');
    expect(classifyLine(line({ expected_qty: 5, counted_qty: 5 }))).toBe('match');
    expect(classifyLine(line({ expected_qty: 5, counted_qty: 7 }))).toBe('over');
    expect(classifyLine(line({ expected_qty: 5, counted_qty: 2 }))).toBe('short');
  });

  it('treats a counted zero as counted, not missing', () => {
    expect(classifyLine(line({ expected_qty: 3, counted_qty: 0 }))).toBe('short');
  });
});

describe('summarizeLines', () => {
  it('computes progress, accuracy, net/gross value', () => {
    const s = summarizeLines([
      line({ expected_qty: 10, counted_qty: 10 }), // match
      line({ expected_qty: 10, counted_qty: 12, unit_cost_cents: 500 }), // +2 → +1000
      line({ expected_qty: 10, counted_qty: 7, unit_cost_cents: 200 }), // -3 → -600
      line({ counted_qty: null }), // uncounted
    ]);
    expect(s).toMatchObject({
      total: 4,
      counted: 3,
      uncounted: 1,
      matched: 1,
      over: 1,
      short: 1,
      varianceLines: 2,
      netUnits: -1,
      netValueCents: 400,
      grossValueCents: 1600,
      progressPct: 75,
    });
    expect(s.accuracyPct).toBeCloseTo(33.3, 1);
  });

  it('returns null value totals when costs are masked', () => {
    const s = summarizeLines([line({ expected_qty: 5, counted_qty: 6, unit_cost_cents: null })]);
    expect(s.netValueCents).toBeNull();
    expect(s.grossValueCents).toBeNull();
    expect(s.netUnits).toBe(1);
  });

  it('does not invent accuracy for blind (hidden-expected) lines', () => {
    const s = summarizeLines([line({ expected_qty: null, counted_qty: 4, unit_cost_cents: null })]);
    expect(s.counted).toBe(1);
    expect(s.accuracyPct).toBeNull();
    expect(s.netValueCents).toBeNull();
    expect(s.varianceLines).toBe(0);
  });

  it('handles an empty sheet', () => {
    expect(summarizeLines([])).toMatchObject({ total: 0, progressPct: 0, accuracyPct: null, netUnits: 0 });
  });
});

describe('sortByVarianceImpact', () => {
  it('orders by absolute value, then units, then name — without mutating input', () => {
    const small = line({ part_name: 'B', expected_qty: 5, counted_qty: 4, variance_value_cents: -1000 });
    const big = line({ part_name: 'A', expected_qty: 5, counted_qty: 0, variance_value_cents: -90000 });
    const input = [small, big];
    expect(sortByVarianceImpact(input).map((l) => l.part_name)).toEqual(['A', 'B']);
    expect(input[0]).toBe(small);
  });
});

describe('filterLines', () => {
  const lines = [
    line({ part_name: 'Capacitor 45/5', part_number: 'CAP-455', counted_qty: null }),
    line({ part_name: 'Contactor', expected_qty: 4, counted_qty: 4 }),
    line({ part_name: 'Fan motor', category: 'Motors', expected_qty: 2, counted_qty: 1 }),
  ];
  it('searches name, part number and category', () => {
    expect(filterLines(lines, { query: 'cap-455' })).toHaveLength(1);
    expect(filterLines(lines, { query: 'motors' })).toHaveLength(1);
  });
  it('filters uncounted and variances', () => {
    expect(filterLines(lines, { mode: 'uncounted' })).toHaveLength(1);
    expect(filterLines(lines, { mode: 'variances' }).map((l) => l.part_name)).toEqual(['Fan motor']);
  });
});

describe('parseQuantityInput', () => {
  it('accepts whole numbers and blank (clear)', () => {
    expect(parseQuantityInput('12')).toEqual({ ok: true, value: 12 });
    expect(parseQuantityInput(' 0 ')).toEqual({ ok: true, value: 0 });
    expect(parseQuantityInput('')).toEqual({ ok: true, value: null });
  });
  it('rejects negatives, decimals, text and oversize values', () => {
    for (const bad of ['-1', '1.5', 'abc', '1e3', '1000001']) {
      expect(parseQuantityInput(bad).ok).toBe(false);
    }
  });
});

describe('scanner input helpers', () => {
  it('strips scanner control characters', () => {
    expect(normalizeScanCode('  ABC-123\r\n')).toBe('ABC-123');
    expect(normalizeScanCode('A\u001dB\t')).toBe('AB');
  });
  it('ignores the same code only inside the window', () => {
    const last = { code: 'X1', at: 1000 };
    expect(shouldIgnoreRescan(last, 'X1', 1500)).toBe(true);
    expect(shouldIgnoreRescan(last, 'X1', 2600)).toBe(false);
    expect(shouldIgnoreRescan(last, 'X2', 1100)).toBe(false);
    expect(shouldIgnoreRescan(null, 'X1', 1100)).toBe(false);
  });
});

describe('number formatting', () => {
  it('signs variances', () => {
    expect(formatSigned(3)).toBe('+3');
    expect(formatSigned(-2)).toBe('−2');
    expect(formatSigned(0)).toBe('0');
  });
  it('signs money in cents', () => {
    expect(formatSignedCents(1250)).toBe('+$12.50');
    expect(formatSignedCents(-300)).toBe('−$3');
    expect(formatSignedCents(0)).toBe('$0');
  });
  it('returns null % when expected is zero or masked', () => {
    expect(variancePct(0, 5)).toBeNull();
    expect(variancePct(null, 5)).toBeNull();
    expect(variancePct(10, 8)).toBe(-20);
  });
});

describe('errors', () => {
  it('recognises the no-match SQLSTATE and surfaces server messages', () => {
    expect(isNoMatchError({ code: 'P0002' })).toBe(true);
    expect(isNoMatchError({ code: 'P0001' })).toBe(false);
    expect(countErrorMessage({ code: 'P0004', message: 'This count is no longer open for counting' })).toBe(
      'This count is no longer open for counting',
    );
  });
  it('gives a permission message and a safe fallback', () => {
    expect(countErrorMessage({ code: '42501', message: 'Not authorised' })).toMatch(/permission/);
    expect(countErrorMessage({ code: 'XX000', message: 'internal stack trace' })).toBe(
      'Something went wrong. Please try again.',
    );
  });
});

describe('csv columns', () => {
  it('omits cost columns when the viewer cannot see costs', () => {
    expect(buildVarianceCsvColumns(false).map((c) => c.header)).not.toContain('Variance value');
    expect(buildVarianceCsvColumns(true).map((c) => c.header)).toContain('Variance value');
  });
});
