/**
 * Lightweight GA4 wrapper.
 * Nothing is loaded until analytics consent is granted via CookieConsent.tsx.
 */

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}

const GA_ID = import.meta.env.VITE_GA4_MEASUREMENT_ID;

let scriptLoaded = false;
let consentGranted = false;

function ensureDataLayer() {
  window.dataLayer = window.dataLayer || [];
  if (!window.gtag) {
    window.gtag = function gtag(...args: unknown[]) {
      window.dataLayer.push(args);
    };
  }
}

function loadGaScript() {
  if (scriptLoaded || !GA_ID) return;
  scriptLoaded = true;

  ensureDataLayer();
  window.gtag('js', new Date());
  window.gtag('config', GA_ID, {
    send_page_view: false, // pageviews are sent manually on route change
    anonymize_ip: true,
  });

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);
}

/** Called from CookieConsent.tsx whenever the "analytics" toggle changes. */
export function setAnalyticsConsent(granted: boolean) {
  consentGranted = granted;
  if (granted) loadGaScript();
  // Revoking after grant: we simply stop sending further events —
  // GA's own script can't be safely unloaded once injected.
}

export function trackPageview(path: string, title?: string) {
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

export function hasAnalyticsConsent() {
  return consentGranted;
}
