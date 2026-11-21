import { describe, expect, it } from 'vitest';
import {
  FREQUENT_DEBOUNCE_MS, FREQUENT_HALF_LIFE_MS, FREQUENT_MAX_ENTRIES, normalizeHref, parseStore, recordVisit, topFrequent,
  type FrequentStore,
} from './navFrequent';

const ALLOWED = new Set(['/dashboard/calls', '/dashboard/jobs', '/dashboard/customers']);
const T0 = 1_700_000_000_000;
const visit = (s: FrequentStore, href: string, at: number) => recordVisit(s, href, ALLOWED, at);

describe('navFrequent', () => {
  it('normalises query, hash, case and trailing slash', () => {
    expect(normalizeHref('/Dashboard/Calls/?a=1#x')).toBe('/dashboard/calls');
  });

  it('ignores Overview and hrefs the person cannot see', () => {
    let s: FrequentStore = {};
    s = visit(s, '/dashboard', T0);
    s = visit(s, '/dashboard/secret-admin', T0);
    expect(s).toEqual({});
  });

  it('debounces rapid re-opens but counts spaced visits', () => {
    let s = visit({}, '/dashboard/calls', T0);
    s = visit(s, '/dashboard/calls', T0 + FREQUENT_DEBOUNCE_MS - 1);
    expect(s['/dashboard/calls'].score).toBe(1);
    s = visit(s, '/dashboard/calls', T0 + FREQUENT_DEBOUNCE_MS + 1);
    expect(s['/dashboard/calls'].score).toBeGreaterThan(1.9);
  });

  it('needs repeat visits before a page qualifies', () => {
    const s = visit({}, '/dashboard/calls', T0);
    expect(topFrequent(s, ALLOWED, T0)).toEqual([]);
  });

  it('ranks by recent habit: old heavy use decays below new use', () => {
    let s: FrequentStore = {};
    for (let i = 0; i < 6; i++) s = visit(s, '/dashboard/jobs', T0 + i * 60_000);
    const later = T0 + 6 * FREQUENT_HALF_LIFE_MS;
    for (let i = 0; i < 3; i++) s = visit(s, '/dashboard/calls', later + i * 60_000);
    expect(topFrequent(s, ALLOWED, later + 5 * 60_000)[0]).toBe('/dashboard/calls');
  });

  it('never returns pages outside the allowed set, even if stored', () => {
    const s: FrequentStore = { '/dashboard/gone': { score: 50, last: T0 } };
    expect(topFrequent(s, ALLOWED, T0)).toEqual([]);
  });

  it('caps the store size', () => {
    const many = new Set(Array.from({ length: 100 }, (_, i) => `/dashboard/p${i}`));
    let s: FrequentStore = {};
    for (let i = 0; i < 100; i++) s = recordVisit(s, `/dashboard/p${i}`, many, T0 + i * 60_000);
    expect(Object.keys(s).length).toBe(FREQUENT_MAX_ENTRIES);
  });

  it('parseStore survives garbage and drops invalid entries', () => {
    expect(parseStore(null)).toEqual({});
    expect(parseStore('{not json')).toEqual({});
    expect(parseStore('[1,2]')).toEqual({});
    const out = parseStore(JSON.stringify({
      '/dashboard/calls': { score: 3, last: T0 },
      '/evil': { score: 3, last: T0 },
      '/dashboard/jobs': { score: 'x', last: T0 },
      '/dashboard/customers': { score: -1, last: T0 },
    }));
    expect(Object.keys(out)).toEqual(['/dashboard/calls']);
  });

  it('does not mutate its input', () => {
    const s = visit({}, '/dashboard/calls', T0);
    const frozen = JSON.stringify(s);
    visit(s, '/dashboard/jobs', T0 + 60_000);
    expect(JSON.stringify(s)).toBe(frozen);
  });
});
