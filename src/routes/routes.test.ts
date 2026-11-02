// Run after `node scripts/split-routes.mjs --write`. Guards the route groups against drift.
import { describe, expect, it } from 'vitest';
import { ROUTES } from '@/routes/paths';

const groupSources = import.meta.glob('./groups/*Routes.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const PATH_RE = /\bpath=(?:"([^"]+)"|\{'([^']+)'\})/g;

const allPaths = Object.values(groupSources).flatMap((src) => [...src.matchAll(PATH_RE)].map((m) => (m[1] ?? m[2])!));

describe('route groups', () => {
  it('has the six groups', () => {
    expect(Object.keys(groupSources).map((f) => f.replace('./groups/', '').replace('Routes.tsx', '')).sort()).toEqual(
      ['admin', 'auth', 'dashboard', 'marketing', 'portal', 'tech'],
    );
  });
  it('every registered path has a typed constant and every constant is registered', () => {
    const constants = new Set<string>(Object.values(ROUTES));
    expect([...new Set(allPaths)].filter((p) => !constants.has(p))).toEqual([]);
    expect([...constants].filter((p) => !allPaths.includes(p))).toEqual([]);
  });
  it('keeps each group inside its own URL space', () => {
    const only = (name: string) => [...(groupSources[`./groups/${name}Routes.tsx`] ?? '').matchAll(PATH_RE)].map((m) => (m[1] ?? m[2])!);
    expect(only('tech').every((p) => p.startsWith('/tech'))).toBe(true);
    expect(only('admin').every((p) => p.startsWith('/staff'))).toBe(true);
  });
  it('lists no duplicate constants', () => {
    const values = Object.values(ROUTES);
    expect(new Set(values).size).toBe(values.length);
  });
});
