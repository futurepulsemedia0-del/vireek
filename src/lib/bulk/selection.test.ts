import { describe, it, expect } from 'vitest';
import { EMPTY_SELECTION, applyClick, checkState, pruneSelection, rangeIds, toggleMany } from './selection';

const ids = ['a', 'b', 'c', 'd', 'e'];

describe('bulk selection', () => {
  it('toggles a single row and sets the anchor', () => {
    const s = applyClick(EMPTY_SELECTION, ids, 'b');
    expect([...s.selected]).toEqual(['b']);
    expect(s.anchor).toBe('b');
    expect(applyClick(s, ids, 'b').selected.size).toBe(0);
  });

  it('shift-click selects the inclusive range in display order (both directions)', () => {
    const first = applyClick(EMPTY_SELECTION, ids, 'b');
    expect([...applyClick(first, ids, 'd', { shiftKey: true }).selected].sort()).toEqual(['b', 'c', 'd']);
    const rev = applyClick(applyClick(EMPTY_SELECTION, ids, 'd'), ids, 'b', { shiftKey: true });
    expect([...rev.selected].sort()).toEqual(['b', 'c', 'd']);
  });

  it('shift-click on a selected row deselects the range', () => {
    let s = applyClick(EMPTY_SELECTION, ids, 'a');
    s = applyClick(s, ids, 'e', { shiftKey: true });
    expect(s.selected.size).toBe(5);
    s = applyClick(s, ids, 'b', { shiftKey: true });
    expect([...s.selected].sort()).toEqual(['a']);
  });

  it('shift-click without an anchor behaves like a plain click', () => {
    expect([...applyClick(EMPTY_SELECTION, ids, 'c', { shiftKey: true }).selected]).toEqual(['c']);
  });

  it('ignores ids that are not displayed', () => {
    expect(applyClick(EMPTY_SELECTION, ids, 'zzz')).toBe(EMPTY_SELECTION);
    expect(rangeIds(ids, 'a', 'zzz')).toEqual([]);
  });

  it('prunes hidden ids and keeps the same Set when nothing changed', () => {
    const sel = new Set(['a', 'x']);
    expect([...pruneSelection(sel, ids)]).toEqual(['a']);
    const clean = new Set(['a']);
    expect(pruneSelection(clean, ids)).toBe(clean);
  });

  it('header toggle selects all, then clears all, and reports tri-state', () => {
    let s = toggleMany(EMPTY_SELECTION, ids);
    expect(checkState(s.selected, ids)).toBe('all');
    s = toggleMany(s, ids);
    expect(checkState(s.selected, ids)).toBe('none');
    expect(checkState(new Set(['a']), ids)).toBe('some');
    expect(checkState(new Set(), [])).toBe('none');
  });
});
