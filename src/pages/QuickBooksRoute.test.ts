import { describe, expect, it } from 'vitest';
import appSrc from '@/App.tsx?raw';
import navSrc from '@/components/DashboardNav.tsx?raw';
import callbackSrc from '../../supabase/functions/qbo-oauth-callback/index.ts?raw';

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('QuickBooks wiring', () => {
  it('registers /dashboard/quickbooks exactly once, behind ProtectedRoute', () => {
    expect(count(appSrc, 'path="/dashboard/quickbooks"')).toBe(1);
    const i = appSrc.indexOf('path="/dashboard/quickbooks"');
    expect(appSrc.slice(i, i + 200)).toContain('<ProtectedRoute>');
    expect(appSrc).toContain("import('@/pages/QuickBooksSyncPage')");
  });

  it('the OAuth callback redirects to a route that exists', () => {
    const m = callbackSrc.match(/\$\{siteUrl\}(\/dashboard\/[a-z-]+)/);
    expect(m?.[1]).toBe('/dashboard/quickbooks');
    expect(appSrc).toContain(`path="${m![1]}"`);
  });

  it('is reachable from the dashboard navigation with a billing permission', () => {
    expect(navSrc).toMatch(/href: '\/dashboard\/quickbooks'[^}]*requiresPermission: 'can_view_billing'/);
  });
});
