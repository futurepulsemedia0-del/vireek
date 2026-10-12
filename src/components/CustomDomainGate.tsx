import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { isCustomLandingHost, parseAppHosts } from '@/lib/landingPageUtils';

const PublicLandingPage = lazy(() =>
  import('@/pages/PublicLandingPage').then((m) => ({ default: m.PublicLandingPage })),
);

const APP_HOSTS = parseAppHosts(import.meta.env.VITE_APP_HOSTS);

/**
 * When the site is opened on a customer's verified custom domain, render that
 * customer's landing page instead of the Vireek app. On every Vireek host (and
 * whenever VITE_APP_HOSTS is not configured) this is a transparent pass-through.
 */
export function CustomDomainGate({ children }: { children: ReactNode }) {
  const host = typeof window !== 'undefined' ? window.location.hostname.toLowerCase() : '';
  if (!host || !isCustomLandingHost(host, APP_HOSTS)) return <>{children}</>;

  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-bg-primary">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      }
    >
      <PublicLandingPage host={host} />
    </Suspense>
  );
}
