// Recreated: verify against original intent (recovered verbatim from homepage-redesign.patch)
import { useEffect, useState } from 'react';
import { Phone } from 'lucide-react';
import { ButtonAnchor, ButtonLink } from '@/components/ui/ButtonLink';
import { SARAH_PHONE } from '@/lib/site';
import { trackHomeCta } from '@/lib/homeAnalytics';

export const STICKY_CTA_HEIGHT_CLASS = 'h-[calc(4.5rem+env(safe-area-inset-bottom))]';

/**
 * Mobile-only bottom bar. It never covers content (a spacer of equal height is rendered while visible)
 * and never covers the cookie banner (it hides while the banner is open, signalled by CookieConsent through
 * <html data-cookie-banner> and the `vireek:cookie-banner` event). It also stays hidden while the hero CTA
 * is on screen, so there is no duplicate CTA above the fold.
 */
export function StickyMobileCta() {
  const [heroVisible, setHeroVisible] = useState(true);
  const [cookieOpen, setCookieOpen] = useState(
    () => typeof document !== 'undefined' && document.documentElement.hasAttribute('data-cookie-banner'),
  );

  useEffect(() => {
    const target = document.querySelector('[data-hero-cta]');
    if (!target || typeof IntersectionObserver === 'undefined') {
      setHeroVisible(false);
      return;
    }
    const io = new IntersectionObserver(([e]) => setHeroVisible(e.isIntersecting));
    io.observe(target);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const onChange = (e: Event) => setCookieOpen(Boolean((e as CustomEvent<{ open: boolean }>).detail?.open));
    window.addEventListener('vireek:cookie-banner', onChange);
    return () => window.removeEventListener('vireek:cookie-banner', onChange);
  }, []);

  const show = !heroVisible && !cookieOpen;
  if (!show) return null;

  return (
    <>
      <div aria-hidden="true" className={`md:hidden ${STICKY_CTA_HEIGHT_CLASS}`} />
      <div
        data-testid="sticky-cta"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg-secondary/95 px-4 pt-3 backdrop-blur md:hidden"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
      >
        <div className="mx-auto flex max-w-md gap-2">
          <ButtonLink to="/signup" className="flex-1" onClick={() => trackHomeCta('sticky_primary')}>
            Start free trial
          </ButtonLink>
          <ButtonAnchor href={SARAH_PHONE} variant="secondary" aria-label="Call Sarah" className="px-4" onClick={() => trackHomeCta('sticky_call')}>
            <Phone size={18} aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Call</span>
          </ButtonAnchor>
        </div>
      </div>
    </>
  );
}
