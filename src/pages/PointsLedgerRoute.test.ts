import { describe, expect, it } from 'vitest';
import appSrc from '@/App.tsx?raw';
import navSrc from '@/components/DashboardNav.tsx?raw';
import pageSrc from './PointsLedgerPage.tsx?raw';

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('Points Ledger wiring', () => {
  it('registers /dashboard/points-ledger exactly once, behind ProtectedRoute', () => {
    expect(count(appSrc, 'path="/dashboard/points-ledger"')).toBe(1);
    const i = appSrc.indexOf('path="/dashboard/points-ledger"');
    expect(appSrc.slice(i, i + 220)).toContain('<ProtectedRoute>');
    expect(appSrc).toContain("import('@/pages/PointsLedgerPage')");
  });

  it('nav label matches the page activeLabel so the item highlights', () => {
    const label = pageSrc.match(/activeLabel="([^"]+)"/)?.[1];
    expect(label).toBe('Points Ledger');
    expect(navSrc).toContain(`label: '${label}', href: '/dashboard/points-ledger'`);
  });
});
