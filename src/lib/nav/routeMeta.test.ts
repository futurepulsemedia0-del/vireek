import { describe, expect, it } from 'vitest';
import { buildBreadcrumbJsonLd, buildBreadcrumbs, collapseCrumbs, isPublicPath, resolveNavCurrent, truncateLabel } from '@/lib/nav/routeMeta';

describe('buildBreadcrumbs', () => {
  it('uses dashboard root and marks the last crumb current', () => {
    const c = buildBreadcrumbs('/dashboard/jobs');
    expect(c.map((x) => x.href)).toEqual(['/dashboard', '/dashboard/jobs']);
    expect(c[0]!.fallback).toBe('Dashboard');
    expect(c[1]!.current).toBe(true);
  });
  it('uses entity labels for id segments and a generic fallback otherwise', () => {
    const id = '3f2b8c1e-0a4d-4e8b-9c1a-1b2c3d4e5f60';
    expect(buildBreadcrumbs(`/dashboard/customers/${id}`, { entityLabels: { [`/dashboard/customers/${id}`]: 'Acme Plumbing' } }).at(-1)!.fallback).toBe('Acme Plumbing');
    expect(buildBreadcrumbs(`/dashboard/customers/${id}`).at(-1)!.fallback).toBe('Details');
  });
  it('prepends Home on public pages only', () => {
    expect(buildBreadcrumbs('/pricing')[0]!.href).toBe('/');
    expect(buildBreadcrumbs('/dashboard')[0]!.href).toBe('/dashboard');
    expect(isPublicPath('/dashboard/x')).toBe(false);
    expect(isPublicPath('/pricing')).toBe(true);
  });
  it('tolerates trailing slashes and encoded segments', () => {
    expect(buildBreadcrumbs('/blog/hello%20world/').at(-1)!.fallback).toBe('Hello world');
  });
});

describe('collapseCrumbs / truncateLabel', () => {
  const trail = buildBreadcrumbs('/dashboard/a/b/c/d');
  it('keeps first and tail, hides the middle', () => {
    const r = collapseCrumbs(trail, 3);
    expect(r).toHaveLength(3);
    expect('ellipsis' in r[1]!).toBe(true);
  });
  it('does nothing for short trails', () => expect(collapseCrumbs(trail.slice(0, 2), 3)).toHaveLength(2));
  it('truncates by code point', () => {
    expect(truncateLabel('abcdef', 4)).toBe('abc…');
    expect(truncateLabel('abc', 4)).toBe('abc');
  });
});

describe('JSON-LD', () => {
  it('builds absolute positions', () => {
    const ld = buildBreadcrumbJsonLd([{ name: 'Home', href: '/' }, { name: 'Pricing', href: '/pricing' }], 'https://x.com/');
    expect(JSON.stringify(ld)).toContain('"position":2');
    expect(JSON.stringify(ld)).toContain('https://x.com/pricing');
  });
  it('returns null for a single crumb', () => expect(buildBreadcrumbJsonLd([{ name: 'Home', href: '/' }], 'https://x.com')).toBeNull());
});

describe('resolveNavCurrent', () => {
  const items = [{ path: '/dashboard', end: true }, { path: '/dashboard/jobs' }, { path: '/dashboard/jobs/archive' }];
  it('exact => page', () => expect(resolveNavCurrent(items, '/dashboard/jobs').get('/dashboard/jobs')).toBe('page'));
  it('nested => parent true, never dashboard', () => {
    const m = resolveNavCurrent(items, '/dashboard/jobs/123');
    expect(m.get('/dashboard/jobs')).toBe('true');
    expect(m.get('/dashboard')).toBeNull();
  });
  it('longest match wins', () => expect(resolveNavCurrent(items, '/dashboard/jobs/archive').get('/dashboard/jobs')).toBeNull());
});
