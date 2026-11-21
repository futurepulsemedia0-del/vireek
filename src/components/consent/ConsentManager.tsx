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
  'sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[200] focus:rounded-xl focus:bg-accent focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-on-accent';

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
  const [dismissed, setDismissed] = useState(readBannerDismissed);
  const [bannerMounted, setBannerMounted] = useState(false);
  const [bannerLeaving, setBannerLeaving] = useState(false);
  const [skipHost, setSkipHost] = useState<HTMLElement | null>(null);
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

  // --- Banner timing: never at first paint, never on excluded routes, never right after a dismissal. ---
  const bannerAllowed = !pathname.startsWith('/wallboard/');
  const eligible = consent.needsPrompt && bannerAllowed && !dismissed;
  const revealed = useBannerReveal(eligible);
  const wantBanner = eligible && revealed && !centerOpen;

  useEffect(() => {
    if (wantBanner) {
      setBannerMounted(true);
      setBannerLeaving(false);
      return undefined;
    }
    if (!bannerMounted) return undefined;
    setBannerLeaving(true);
    const timer = window.setTimeout(
      () => {
        setBannerMounted(false);
        setBannerLeaving(false);
      },
      prefersReducedMotion() ? 0 : BANNER_EXIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [wantBanner, bannerMounted]);

  // Announce politely when the banner appears (focus is deliberately NOT moved).
  const bannerAnnouncedRef = useRef(false);
  useEffect(() => {
    if (!bannerMounted) {
      bannerAnnouncedRef.current = false;
      return;
    }
    if (bannerAnnouncedRef.current) return;
    bannerAnnouncedRef.current = true;
    setAnnouncement(`${t('banner.region')}: ${t('banner.title')}`);
  }, [bannerMounted, t]);

  // "Cookie choices" skip link: first in the tab order while the banner exists.
  useEffect(() => {
    if (!bannerMounted) return undefined;
    const host = document.createElement('div');
    host.id = 'consent-skip-host';
    document.body.insertBefore(host, document.body.firstChild);
    setSkipHost(host);
    return () => {
      host.remove();
      setSkipHost(null);
    };
  }, [bannerMounted]);

  const returnFocusFromBanner = () => {
    const banner = document.getElementById('consent-banner');
    if (banner?.contains(document.activeElement)) document.getElementById('main-content')?.focus?.();
  };

  const decide = (action: () => void) => {
    returnFocusFromBanner();
    action();
    clearBannerDismissal();
    setAnnouncement(t('center.saved'));
  };

  const dismissBanner = () => {
    returnFocusFromBanner();
    markBannerDismissed();
    setDismissed(true);
  };

  return (
    <>
      <div id="consent-live-region" role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {skipHost &&
        createPortal(
          <a
            href="#consent-banner"
            className={SKIP_LINK_CLASS}
            onClick={(event) => {
              event.preventDefault();
              document.getElementById('consent-banner')?.focus();
            }}
          >
            {t('banner.region')}
          </a>,
          skipHost,
        )}
      {bannerMounted && (
        <ConsentBanner
          leaving={bannerLeaving}
          onAcceptAll={() => decide(consent.acceptAll)}
          onReject={() => decide(consent.rejectNonEssential)}
          onCustomize={openCenter}
          onDismiss={dismissBanner}
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
