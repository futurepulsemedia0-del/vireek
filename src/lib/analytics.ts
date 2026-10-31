/**
 * Lightweight GA4 wrapper.
 * Nothing is loaded until analytics consent is granted (src/lib/consent/engine.ts).
 */

import { CATEGORY_FOOTPRINT, deleteCookiesMatching, onCategoryChange } from '@/lib/consent/engine';

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}

const GA_ID = import.meta.env.VITE_GA4_MEASUREMENT_ID;

let scriptLoaded = false;
let consentGranted = false;
const consentListeners = new Set<() => void>();

function ensureDataLayer() {
  window.dataLayer = window.dataLayer || [];
  if (!window.gtag) {
    // gtag.js only understands the `arguments` object; pushing a plain array is silently ignored.
    window.gtag = function gtag() {
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer.push(arguments);
    };
  }
}

/** Google's documented kill-switch: while true, gtag.js sends no hits at all. */
function setGaDisabled(disabled: boolean) {
  if (!GA_ID) return;
  (window as unknown as Record<string, unknown>)[`ga-disable-${GA_ID}`] = disabled;
}

function loadGaScript() {
  if (!GA_ID) return;
  ensureDataLayer();
  setGaDisabled(false);

  if (scriptLoaded) {
    // Consent was withdrawn earlier in this visit and is now granted again.
    window.gtag('consent', 'update', { analytics_storage: 'granted' });
    return;
  }
  scriptLoaded = true;

  // Consent Mode v2: everything denied first; only analytics storage is then granted.
  // Ad signals stay denied permanently: Vireek runs no advertising products.
  window.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
  });
  window.gtag('consent', 'update', { analytics_storage: 'granted' });
  window.gtag('js', new Date());
  window.gtag('config', GA_ID, {
    send_page_view: false, // pageviews are sent manually on route change
    anonymize_ip: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);
}

/** Withdrawal: stop all hits, tell Google, delete the _ga cookies. No reload needed. */
function disableGa() {
  setGaDisabled(true);
  if (scriptLoaded) window.gtag('consent', 'update', { analytics_storage: 'denied' });
  deleteCookiesMatching(CATEGORY_FOOTPRINT.analytics.cookies);
}

/** Driven by the consent engine (below); not meant to be called from UI code. */
export function setAnalyticsConsent(granted: boolean) {
  consentGranted = granted;
  if (granted) {
    loadGaScript();
    consentListeners.forEach((cb) => cb());
  } else {
    disableGa();
  }
}

export function trackPageview(path: string, title?: string) {
  if (/^\/wallboard\//.test(path)) return; // never send secret TV tokens to GA
  if (!consentGranted || !GA_ID) return;
  ensureDataLayer();
  window.gtag('event', 'page_view', {
    page_path: path,
    page_title: title ?? document.title,
    page_location: window.location.href,
  });
}

export function trackEvent(name: string, params: Record<string, unknown> = {}) {
  if (!consentGranted || !GA_ID) return;
  ensureDataLayer();
  window.gtag('event', name, params);
}

/** Runs `cb` whenever analytics consent is granted (flushes one-off conversion events). Returns an unsubscribe fn. */
export function onAnalyticsConsent(cb: () => void): () => void {
  consentListeners.add(cb);
  return () => {
    consentListeners.delete(cb);
  };
}
export function hasAnalyticsConsent() {
  return consentGranted;
}

// Follows the consent engine: stored consent applies on every route at boot, withdrawal applies instantly.
if (typeof window !== 'undefined') {
  onCategoryChange('analytics', setAnalyticsConsent);
}
