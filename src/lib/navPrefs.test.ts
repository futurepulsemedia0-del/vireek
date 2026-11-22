import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_NAV_PREFS,
  MAX_PINNED,
  clearPins,
  isPinned,
  loadNavPrefs,
  movePin,
  navPrefsKey,
  parseNavPrefs,
  resetNavPrefsMemory,
  saveNavPrefs,
  togglePin,
  visiblePinned,
} from './navPrefs';

const allowed = new Set(['/dashboard/calls', '/dashboard/calendar', '/dashboard/jobs', '/dashboard/quotes']);
const make = (...pinned: string[]) => ({ v: 1 as const, pinned });

describe('parseNavPrefs', () => {
  it('returns empty for null, junk, wrong version and oversized input', () => {
    expect(parseNavPrefs(null)).toEqual(EMPTY_NAV_PREFS);
    expect(parseNavPrefs('{not json')).toEqual(EMPTY_NAV_PREFS);
    expect(parseNavPrefs('"x"')).toEqual(EMPTY_NAV_PREFS);
    expect(parseNavPrefs(JSON.stringify({ v: 2, pinned: ['/dashboard/calls'] }))).toEqual(EMPTY_NAV_PREFS);
    expect(parseNavPrefs(`{"v":1,"pinned":["${'a'.repeat(9000)}"]}`)).toEqual(EMPTY_NAV_PREFS);
  });

  it('normalises, de-duplicates and drops anything that is not a dashboard path', () => {
    const raw = JSON.stringify({
      v: 1,
      pinned: ['/dashboard/Calls/', '/dashboard/calls', 42, null, 'https://evil.example/x', '//evil.example', '/dashboard//x', '/dashboard/a b', '/dashboard/jobs?x=1'],
    });
    expect(parseNavPrefs(raw).pinned).toEqual(['/dashboard/calls', '/dashboard/jobs']);
  });

  it('caps the list at MAX_PINNED', () => {
    const many = Array.from({ length: 40 }, (_, i) => `/dashboard/p${i}`);
    expect(parseNavPrefs(JSON.stringify({ v: 1, pinned: many })).pinned).toHaveLength(MAX_PINNED);
  });
});

describe('togglePin', () => {
  it('pins an allowed page at the end and unpins it again', () => {
    const a = togglePin(EMPTY_NAV_PREFS, '/dashboard/calls', allowed);
    expect(a).toMatchObject({ ok: true, pinned: true });
    const b = togglePin(a.prefs, '/dashboard/jobs', allowed);
    expect(b.prefs.pinned).toEqual(['/dashboard/calls', '/dashboard/jobs']);
    const c = togglePin(b.prefs, '/dashboard/calls', allowed);
    expect(c).toMatchObject({ ok: true, pinned: false });
    expect(c.prefs.pinned).toEqual(['/dashboard/jobs']);
  });

  it('refuses a page the person cannot open (no privilege leak through pins)', () => {
    const r = togglePin(EMPTY_NAV_PREFS, '/dashboard/billing', allowed);
    expect(r).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(r.prefs).toBe(EMPTY_NAV_PREFS);
  });

  it('refuses invalid hrefs', () => {
    expect(togglePin(EMPTY_NAV_PREFS, 'https://evil.example', allowed)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(togglePin(EMPTY_NAV_PREFS, '/dashboard', allowed)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(togglePin(EMPTY_NAV_PREFS, 'javascript:alert(1)', allowed)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(togglePin(EMPTY_NAV_PREFS, '//evil.example/x', allowed)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('accepts the in-app pages that live outside /dashboard (technician and safety pages)', () => {
    const ok = new Set(['/tech/today', '/valuation']);
    expect(togglePin(EMPTY_NAV_PREFS, '/tech/today', ok)).toMatchObject({ ok: true, pinned: true });
    expect(togglePin(EMPTY_NAV_PREFS, '/valuation', ok)).toMatchObject({ ok: true, pinned: true });
  });

  it('refuses the 13th pin but still lets an existing pin be removed', () => {
    const everything = new Set(Array.from({ length: 20 }, (_, i) => `/dashboard/p${i}`));
    let prefs = EMPTY_NAV_PREFS;
    for (let i = 0; i < MAX_PINNED; i++) prefs = togglePin(prefs, `/dashboard/p${i}`, everything).prefs;
    expect(togglePin(prefs, '/dashboard/p19', everything)).toMatchObject({ ok: false, reason: 'limit' });
    expect(togglePin(prefs, '/dashboard/p0', everything)).toMatchObject({ ok: true, pinned: false });
  });

  it('lets a person unpin a page they lost access to', () => {
    const prefs = make('/dashboard/billing');
    expect(togglePin(prefs, '/dashboard/billing', allowed)).toMatchObject({ ok: true, pinned: false });
  });

  it('never mutates its input', () => {
    const prefs = make('/dashboard/calls');
    const snapshot = JSON.stringify(prefs);
    togglePin(prefs, '/dashboard/jobs', allowed);
    togglePin(prefs, '/dashboard/calls', allowed);
    movePin(make('/dashboard/calls', '/dashboard/jobs'), '/dashboard/jobs', -1);
    expect(JSON.stringify(prefs)).toBe(snapshot);
  });
});

describe('movePin / clearPins / visiblePinned / isPinned', () => {
  it('moves a pin one step and returns the same object at the edges', () => {
    const prefs = make('/dashboard/calls', '/dashboard/jobs', '/dashboard/quotes');
    expect(movePin(prefs, '/dashboard/quotes', -1).pinned).toEqual(['/dashboard/calls', '/dashboard/quotes', '/dashboard/jobs']);
    expect(movePin(prefs, '/dashboard/calls', -1)).toBe(prefs);
    expect(movePin(prefs, '/dashboard/quotes', 1)).toBe(prefs);
    expect(movePin(prefs, '/dashboard/missing', 1)).toBe(prefs);
  });

  it('clears pins (same object when already empty)', () => {
    expect(clearPins(make('/dashboard/calls')).pinned).toEqual([]);
    expect(clearPins(EMPTY_NAV_PREFS)).toBe(EMPTY_NAV_PREFS);
  });

  it('shows only pins the person can open, keeping their order', () => {
    const prefs = make('/dashboard/billing', '/dashboard/jobs', '/dashboard/calls');
    expect(visiblePinned(prefs, allowed)).toEqual(['/dashboard/jobs', '/dashboard/calls']);
    expect(prefs.pinned).toHaveLength(3);
  });

  it('matches hrefs regardless of case, query and trailing slash', () => {
    expect(isPinned(make('/dashboard/calls'), '/Dashboard/Calls/?tab=1')).toBe(true);
    expect(isPinned(make('/dashboard/calls'), '/dashboard/jobs')).toBe(false);
  });
});

describe('storage', () => {
  beforeEach(() => {
    resetNavPrefsMemory();
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('round-trips per user and keeps users apart', () => {
    saveNavPrefs('u1', make('/dashboard/calls'));
    saveNavPrefs('u2', make('/dashboard/jobs'));
    expect(loadNavPrefs('u1').pinned).toEqual(['/dashboard/calls']);
    expect(loadNavPrefs('u2').pinned).toEqual(['/dashboard/jobs']);
    expect(navPrefsKey(null)).toBe(navPrefsKey(undefined));
  });

  it('survives corrupted storage', () => {
    localStorage.setItem(navPrefsKey('u1'), '{{{');
    expect(loadNavPrefs('u1')).toEqual(EMPTY_NAV_PREFS);
  });

  it('keeps the choice in memory when storage is blocked and never throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => saveNavPrefs('u1', make('/dashboard/calls'))).not.toThrow();
    expect(loadNavPrefs('u1').pinned).toEqual(['/dashboard/calls']);
  });
});
