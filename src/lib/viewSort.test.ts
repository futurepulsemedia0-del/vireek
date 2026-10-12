import { describe, expect, it } from 'vitest';
import { coerceSort, sortRows, type SortValue } from '@/lib/viewSort';

interface Row {
  id: number;
  name: string | null;
  amount: number | null;
  at: string | null;
}

const acc: Record<string, (r: Row) => SortValue> = {
  name: (r) => r.name,
  amount: (r) => r.amount,
  at: (r) => (r.at ? new Date(r.at).getTime() : null),
};

const rows: Row[] = [
  { id: 1, name: 'bravo', amount: 20, at: '2026-03-01' },
  { id: 2, name: null, amount: null, at: null },
  { id: 3, name: 'Alpha', amount: 5, at: '2026-01-01' },
  { id: 4, name: 'charlie', amount: 20, at: '2026-02-01' },
];

describe('sortRows', () => {
  it('returns a copy in original order when there is no sort or an unknown key', () => {
    expect(sortRows(rows, null, acc).map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(sortRows(rows, { key: 'nope', dir: 'asc' }, acc).map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(sortRows(rows, null, acc)).not.toBe(rows);
  });

  it('sorts strings case-insensitively', () => {
    expect(sortRows(rows, { key: 'name', dir: 'asc' }, acc).map((r) => r.id)).toEqual([3, 1, 4, 2]);
  });

  it('keeps empty values last in BOTH directions', () => {
    expect(sortRows(rows, { key: 'name', dir: 'desc' }, acc).map((r) => r.id)).toEqual([4, 1, 3, 2]);
    expect(sortRows(rows, { key: 'amount', dir: 'asc' }, acc).at(-1)?.id).toBe(2);
    expect(sortRows(rows, { key: 'amount', dir: 'desc' }, acc).at(-1)?.id).toBe(2);
  });

  it('is stable for ties', () => {
    expect(sortRows(rows, { key: 'amount', dir: 'desc' }, acc).map((r) => r.id)).toEqual([1, 4, 3, 2]);
  });

  it('sorts dates numerically', () => {
    expect(sortRows(rows, { key: 'at', dir: 'desc' }, acc).map((r) => r.id)).toEqual([1, 4, 3, 2]);
  });

  it('does not mutate its input', () => {
    const before = rows.map((r) => r.id);
    sortRows(rows, { key: 'name', dir: 'asc' }, acc);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe('coerceSort', () => {
  it('accepts allowed keys and falls back otherwise', () => {
    const fb = { key: 'a', dir: 'asc' as const };
    expect(coerceSort({ key: 'b', dir: 'desc' }, ['a', 'b'], fb)).toEqual({ key: 'b', dir: 'desc' });
    expect(coerceSort({ key: 'z', dir: 'desc' }, ['a', 'b'], fb)).toBe(fb);
    expect(coerceSort(null, ['a'], null)).toBeNull();
  });
});
