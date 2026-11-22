import { describe, expect, it } from 'vitest';
import { firstLoadError, hitRowCap, prependUnique, removeById, replaceById } from './overviewLoad';

describe('firstLoadError', () => {
  it('is null when every query succeeded or returned nothing', () => {
    expect(firstLoadError([{ error: null }, {}, null, undefined])).toBe(null);
    expect(firstLoadError([])).toBe(null);
  });
  it('returns the first failure message, with a fallback when the message is empty', () => {
    expect(firstLoadError([{ error: null }, { error: { message: 'permission denied' } }, { error: { message: 'later' } }])).toBe('permission denied');
    expect(firstLoadError([{ error: { message: '' } }])).toBe('Query failed');
  });
});

describe('hitRowCap', () => {
  it('flags results that fill the cap', () => {
    expect(hitRowCap(2000, 2000)).toBe(true);
    expect(hitRowCap(1999, 2000)).toBe(false);
    expect(hitRowCap(0, 0)).toBe(false);
  });
});

describe('row helpers', () => {
  const rows = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c', n: 3 }];
  it('prependUnique never double-counts a row and respects the cap', () => {
    expect(prependUnique(rows, { id: 'b', n: 9 }, 10).map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(prependUnique(rows, { id: 'z', n: 0 }, 3).map((r) => r.id)).toEqual(['z', 'a', 'b']);
    expect(prependUnique(rows, { id: 'z', n: 0 }, 3)).toHaveLength(3);
  });
  it('does not mutate its input', () => {
    const snapshot = JSON.stringify(rows);
    prependUnique(rows, { id: 'z', n: 0 }, 2);
    replaceById(rows, { id: 'a', n: 5 });
    removeById(rows, 'a');
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
  it('replaceById and removeById touch only the matching row', () => {
    expect(replaceById(rows, { id: 'b', n: 7 }).map((r) => r.n)).toEqual([1, 7, 3]);
    expect(removeById(rows, 'b').map((r) => r.id)).toEqual(['a', 'c']);
    expect(removeById(rows, undefined)).toHaveLength(3);
  });
});
