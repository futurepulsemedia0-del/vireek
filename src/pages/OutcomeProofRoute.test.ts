import { describe, expect, it } from 'vitest';
import appSrc from '@/App.tsx?raw';
import navSrc from '@/components/DashboardNav.tsx?raw';
import pageSrc from './OutcomeProofPage.tsx?raw';
import outcomeEn from '@/locales/en/outcomeProof.json';

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('Outcome Cases wiring', () => {
  it('registers /dashboard/outcome-cases exactly once, behind ProtectedRoute', () => {
    expect(count(appSrc, 'path="/dashboard/outcome-cases"')).toBe(1);
    const i = appSrc.indexOf('path="/dashboard/outcome-cases"');
    expect(appSrc.slice(i, i + 220)).toContain('<ProtectedRoute>');
    expect(appSrc).toContain("import('@/pages/OutcomeProofPage')");
  });

  it('nav label matches the page activeLabel so the item highlights', () => {
    const label = pageSrc.match(/activeLabel="([^"]+)"/)?.[1];
    expect(label).toBe('Outcome Cases');
    expect(navSrc).toContain(`label: '${label}', href: '/dashboard/outcome-cases'`);
  });

  it('ships its English strings', () => {
    expect(Object.keys(outcomeEn as Record<string, unknown>).length).toBeGreaterThan(0);
  });
});
