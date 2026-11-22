import { lazy, Suspense, type ReactNode } from 'react';

const DashboardShellHost = lazy(() =>
  import('@/components/DashboardNav').then((m) => ({ default: m.DashboardShellHost })),
);

/**
 * These /dashboard routes never rendered <DashboardLayout> (full-bleed or
 * standalone pages), so they must keep rendering WITHOUT the shell.
 */
const SHELL_EXCLUDED_PREFIXES = [
  '/dashboard/today/tv',
  '/dashboard/business-kpis',
  '/dashboard/trade-packs',
  '/dashboard/landscaping',
  '/dashboard/pest-ops',
  '/dashboard/commercial',
  '/dashboard/packs',
  '/dashboard/expert-assist',
] as const;

export function shouldHostDashboardShell(pathname: string): boolean {
  if (pathname !== '/dashboard' && !pathname.startsWith('/dashboard/')) return false;
  return !SHELL_EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Hosts the dashboard chrome once, above <Routes>, so it survives page-to-page navigation. */
export function DashboardShellSwitch({
  enabled,
  fallback,
  children,
}: {
  enabled: boolean;
  fallback: ReactNode;
  children: ReactNode;
}) {
  if (!enabled) return <>{children}</>;
  return (
    <Suspense fallback={fallback}>
      <DashboardShellHost>{children}</DashboardShellHost>
    </Suspense>
  );
}
