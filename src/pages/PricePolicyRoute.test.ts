import { describe, expect, it } from 'vitest';
import appSrc from '@/App.tsx?raw';
import navSrc from '@/components/DashboardNav.tsx?raw';
import e2eSrc from '../../e2e/price-playbook.spec.ts?raw';

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('Price Playbook wiring', () => {
  it('registers /dashboard/price-playbook exactly once, behind ProtectedRoute', () => {
    expect(count(appSrc, 'path="/dashboard/price-playbook"')).toBe(1);
    const i = appSrc.indexOf('path="/dashboard/price-playbook"');
    expect(appSrc.slice(i, i + 220)).toContain('<ProtectedRoute>');
    expect(appSrc).toContain("import('@/pages/PricePolicyPage')");
  });

  it('every nav link to the playbook points at a registered route', () => {
    const hrefs = [...navSrc.matchAll(/href: '(\/dashboard\/price-playbook)'/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(appSrc).toContain(`path="${h}"`);
  });

  it('the e2e spec targets the same path', () => {
    expect(e2eSrc).toContain("page.goto('/dashboard/price-playbook')");
  });
});
