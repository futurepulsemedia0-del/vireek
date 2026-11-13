// Recreated: verify against original intent (recovered verbatim from homepage-redesign.patch)
import { useEffect } from 'react';
import { trackEvent } from '@/lib/analytics';

/**
 * Homepage analytics. Every call goes through trackEvent(), which is a no-op until the visitor has
 * granted analytics consent in CookieConsent — nothing here can fire before consent.
 */
export type HomeCtaId =
  | 'hero_primary'
  | 'hero_demo'
  | 'header_primary'
  | 'sticky_primary'
  | 'sticky_call'
  | 'calculator_primary'
  | 'pricing_plan'
  | 'founding_primary'
  | 'final_primary'
  | 'final_call';

export function trackHomeCta(id: HomeCtaId, extra: Record<string, unknown> = {}) {
  trackEvent('home_cta_click', { cta_id: id, ...extra });
}

export function trackDemoStart(mode: 'voice' | 'chat' | 'phone' | 'fallback_transcript') {
  trackEvent('demo_start', { mode });
}

const SCROLL_STEPS = [25, 50, 75, 100] as const;

/** Fires `home_scroll_depth` once per threshold (25/50/75/100 %) per page view. */
export function useScrollDepthTracking() {
  useEffect(() => {
    const fired = new Set<number>();
    let ticking = false;

    const check = () => {
      ticking = false;
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - window.innerHeight;
      if (scrollable <= 0) return;
      const pct = Math.min(100, Math.round((window.scrollY / scrollable) * 100));
      for (const step of SCROLL_STEPS) {
        if (pct >= step && !fired.has(step)) {
          fired.add(step);
          trackEvent('home_scroll_depth', { percent: step });
        }
      }
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(check);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
}
