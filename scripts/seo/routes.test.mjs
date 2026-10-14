// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ALIAS_PATHS, DATA_ROUTE_PATTERNS, STATIC_PUBLIC_PATHS, appRoutePaths, classifyRoute, collectRoutes,
} from './routes.mjs';

const appPaths = appRoutePaths();

describe('route classification (App.tsx is the source of truth)', () => {
  it('every route in App.tsx is explicitly classified', () => {
    const unclassified = appPaths.filter((p) => classifyRoute(p) === null);
    expect(
      unclassified,
      `Classify these in scripts/seo/routes.mjs (public, alias or private): ${unclassified.join(', ')}`,
    ).toEqual([]);
  });

  it('every listed public path / alias exists in App.tsx', () => {
    for (const p of [...STATIC_PUBLIC_PATHS, ...ALIAS_PATHS]) expect(appPaths, p).toContain(p);
  });

  it('data patterns that exist in App.tsx are classified as data', () => {
    for (const p of DATA_ROUTE_PATTERNS.filter((x) => appPaths.includes(x))) {
      expect(classifyRoute(p)).toBe('data');
    }
    for (const p of ['/blog/:slug', '/industries/:slug', '/compare/:slug', '/integrations/:slug', '/switch/:slug']) {
      expect(appPaths, p).toContain(p);
    }
  });

  it('dashboard, tech, staff, auth and token routes are never public', () => {
    for (const p of appPaths.filter((x) => /^\/(dashboard|tech|staff|partner-portal|onboarding)/.test(x))) {
      expect(classifyRoute(p), p).toBe('private');
    }
    for (const p of ['/login', '/signup', '/reset-password', '/portal/:token', '/sign/:token']) {
      expect(classifyRoute(p), p).toBe('private');
    }
  });
});

describe('collectRoutes()', () => {
  it('builds unique, valid, non-private URLs from the real data modules', async () => {
    const routes = await collectRoutes();
    const paths = routes.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const kind of ['static', 'blog', 'industry', 'compare', 'integration', 'switch']) {
      expect(routes.some((r) => r.kind === kind), kind).toBe(true);
    }
    for (const r of routes) {
      expect(r.path).toMatch(/^\/[a-z0-9\-/]*$/);
      expect(['static', 'data']).toContain(
        classifyRoute(r.path) ?? classifyRoute(`${r.path.replace(/\/[^/]+$/, '')}/:slug`),
      );
      if (r.lastmod) expect(r.lastmod).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  }, 30000);
});
