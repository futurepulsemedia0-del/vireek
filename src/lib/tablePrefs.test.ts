import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TABLE_PREFS,
  clampPage,
  hiddenFromVisible,
  isValidTableKey,
  moveColumn,
  normalizeTablePrefs,
  pageCount,
  pickNewer,
  readLocal,
  resolveColumns,
  sliceForPage,
  writeLocal,
  type ColumnDef,
} from '@/lib/tablePrefs';

describe('normalizeTablePrefs', () => {
  it('returns defaults for junk', () => {
    expect(normalizeTablePrefs(null)).toEqual(DEFAULT_TABLE_PREFS);
    expect(normalizeTablePrefs('x')).toEqual(DEFAULT_TABLE_PREFS);
  });
  it('clamps and filters hostile values', () => {
    const p = normalizeTablePrefs({
      density: 'gigantic',
      pageSize: 7,
      sort: { key: 'name', dir: 'sideways' },
      columnWidths: { a: 5, b: 99999, c: 'wide' },
      hiddenColumns: ['x', 'x', 3, ''],
      filters: { q: 'ok', bad: { nested: 1 }, n: 3 },
    });
    expect(p.density).toBe('comfortable');
    expect(p.pageSize).toBe(25);
    expect(p.sort).toBeNull();
    expect(p.columnWidths).toEqual({ a: 48, b: 800 });
    expect(p.hiddenColumns).toEqual(['x']);
    expect(p.filters).toEqual({ q: 'ok', n: 3 });
  });
  it('keeps valid values', () => {
    const p = normalizeTablePrefs({ density: 'compact', pageSize: 100, sort: { key: 'date', dir: 'desc' } });
    expect(p.density).toBe('compact');
    expect(p.pageSize).toBe(100);
    expect(p.sort).toEqual({ key: 'date', dir: 'desc' });
  });
});

describe('sync helpers', () => {
  it('validates table keys', () => {
    expect(isValidTableKey('jobs.list')).toBe(true);
    expect(isValidTableKey('Jobs')).toBe(false);
    expect(isValidTableKey('')).toBe(false);
  });
  it('picks the newer side, remote on ties', () => {
    const a = { prefs: DEFAULT_TABLE_PREFS, updatedAt: 5 };
    const b = { prefs: { ...DEFAULT_TABLE_PREFS, pageSize: 50 }, updatedAt: 5 };
    expect(pickNewer(a, b)).toBe(b);
    expect(pickNewer({ ...a, updatedAt: 9 }, b)).toEqual({ ...a, updatedAt: 9 });
    expect(pickNewer(null, null)).toBeNull();
  });
  it('local round trip, scoped per user', () => {
    const m = new Map<string, string>();
    const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    writeLocal('u1', 'jobs', { prefs: { ...DEFAULT_TABLE_PREFS, pageSize: 50 }, updatedAt: 1 }, kv);
    expect(readLocal('u1', 'jobs', kv)?.prefs.pageSize).toBe(50);
    expect(readLocal('u2', 'jobs', kv)).toBeNull();
  });
});

describe('columns', () => {
  const cols: ColumnDef[] = [
    { key: 'name', label: 'Name', required: true },
    { key: 'contact', label: 'Contact' },
    { key: 'type', label: 'Type' },
  ];
  it('applies saved order, drops unknown keys, appends new columns', () => {
    const r = resolveColumns(cols, { columnOrder: ['type', 'ghost', 'name'], hiddenColumns: [] });
    expect(r.ordered.map((c) => c.key)).toEqual(['type', 'name', 'contact']);
  });
  it('hides columns but never required ones', () => {
    const r = resolveColumns(cols, { columnOrder: [], hiddenColumns: ['name', 'contact'] });
    expect(r.visible.map((c) => c.key)).toEqual(['name', 'type']);
  });
  it('moves columns within bounds', () => {
    expect(moveColumn(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveColumn(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveColumn(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
  });
  it('derives hidden from a saved-view visible list', () => {
    expect(hiddenFromVisible(cols, ['name', 'type'])).toEqual(['contact']);
    expect(hiddenFromVisible(cols, [])).toEqual(['contact', 'type']);
  });
});

describe('paging', () => {
  const rows = Array.from({ length: 53 }, (_, i) => i);
  it('counts and clamps pages', () => {
    expect(pageCount(53, 25)).toBe(3);
    expect(pageCount(0, 25)).toBe(1);
    expect(clampPage(99, 53, 25)).toBe(3);
    expect(clampPage(-2, 53, 25)).toBe(1);
  });
  it('slices the right window', () => {
    expect(sliceForPage(rows, 3, 25)).toEqual([50, 51, 52]);
    expect(sliceForPage(rows, 99, 25)).toEqual([50, 51, 52]);
  });
});
