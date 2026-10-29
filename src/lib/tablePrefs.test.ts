import { describe, expect, it } from 'vitest';
import { DEFAULT_TABLE_PREFS, isValidTableKey, normalizeTablePrefs, pickNewer, readLocal, writeLocal } from '@/lib/tablePrefs';

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
