import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useConsentT } from '@/i18n/consentNamespace';
import { BANNER_EXIT_MS, clearBannerDismissal, markBannerDismissed, readBannerDismissed } from '@/lib/consent/bannerTiming';
import { OPEN_PREFERENCES_EVENT } from '@/lib/consent/engine';
import { linkConsentToAccount, startConsentSync } from '@/lib/consent/sync';
import { useConsent } from '@/lib/consent/useConsent';
import { ConsentBanner } from '@/components/consent/ConsentBanner';
import { useBannerReveal } from '@/components/consent/useBannerReveal';

// Loaded only when the visitor opens the settings: keeps the first load light.
const PreferenceCenter = lazy(() => import('@/components/consent/PreferenceCenter'));


const SKIP_LINK_CLASS =
  'sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[200] focus:rounded-xl focus:bg-accent focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-white';

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Mount once (src/main.tsx). Owns the banner, the settings dialog, focus return and the live announcement. */
export function ConsentManager() {
  const consent = useConsent();
  const { t } = useConsentT();
  const { user } = useAuth();
  const { pathname } = useLocation();
  const [centerOpen, setCenterOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => startConsentSync(), []);
  useEffect(() => {
    void linkConsentToAccount(user?.id);
  }, [user?.id]);

  const openCenter = useCallback(() => {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setCenterOpen(true);
  }, []);

  useEffect(() => {
    window.addEventListener(OPEN_PREFERENCES_EVENT, openCenter);
    return () => window.removeEventListener(OPEN_PREFERENCES_EVENT, openCenter);
  }, [openCenter]);

  const closeCenter = useCallback(
    (saved: boolean) => {
      setCenterOpen(false);
      if (saved) setAnnouncement(t('center.saved'));
      requestAnimationFrame(() => {
        const opener = openerRef.current;
        if (opener && document.contains(opener)) opener.focus();
        else document.getElementById('main-content')?.focus?.();
      });
    },
    [t],
  );

  useEffect(() => {
    if (!announcement) return;
    const timer = window.setTimeout(() => setAnnouncement(''), 5000);
    return () => window.clearTimeout(timer);
  }, [announcement]);

  const bannerAllowed = !pathname.startsWith('/wallboard/');
  const decide = (action: () => void) => {
    action();
    setAnnouncement(t('center.saved'));
  };

  return (
    <>
      <div id="consent-live-region" role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {consent.needsPrompt && !centerOpen && bannerAllowed && (
        <ConsentBanner
          onAcceptAll={() => decide(consent.acceptAll)}
          onReject={() => decide(consent.rejectNonEssential)}
          onCustomize={openCenter}
        />
      )}
      {centerOpen && (
        <Suspense fallback={null}>
          <PreferenceCenter onClose={closeCenter} />
        </Suspense>
      )}
    </>
  );
}
