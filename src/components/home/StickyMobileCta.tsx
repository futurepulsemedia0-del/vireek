// Recreated: verify against original intent (recovered verbatim from homepage-redesign.patch)
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Phone } from 'lucide-react';
import { ButtonAnchor, ButtonLink } from '@/components/ui/ButtonLink';
import { SARAH_PHONE } from '@/lib/site';
import { trackHomeCta } from '@/lib/homeAnalytics';
import { useBottomReserve } from '@/lib/askVireek/useBottomReserve';

export const STICKY_CTA_HEIGHT_CLASS = 'h-[calc(4.5rem+env(safe-area-inset-bottom))]';

/** True while any element matching `selector` is on screen. `initial` avoids a flash before the first observation. */
function useAnyVisible(selector: string, initial: boolean): boolean {
  const [visible, setVisible] = useState(initial);
  useEffect(() => {
    const targets = Array.from(document.querySelectorAll(selector));
    if (targets.length === 0 || typeof IntersectionObserver === 'undefined') {
      setVisible(false);
      return undefined;
    }
    const inView = new Set<Element>();
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) inView.add(entry.target);
        else inView.delete(entry.target);
      }
      setVisible(inView.size > 0);
    });
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, [selector]);
  return visible;
}

function readConsentOpen(): boolean {
  const root = document.documentElement;
  return root.hasAttribute('data-cookie-banner') || root.style.getPropertyValue('--vk-consent-h') !== '';
}

/** The cookie banner publishes --vk-consent-h on <html> while visible; the legacy attribute/event are still honoured. */
function useConsentBannerOpen(): boolean {
  const [open, setOpen] = useState(() => typeof document !== 'undefined' && readConsentOpen());
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setOpen(readConsentOpen());
    const onEvent = (e: Event) => setOpen(Boolean((e as CustomEvent<{ open: boolean }>).detail?.open));
    const mo = new MutationObserver(sync);
    mo.observe(root, { attributes: true, attributeFilter: ['style', 'data-cookie-banner'] });
    window.addEventListener('vireek:cookie-banner', onEvent);
    sync();
    return () => {
      mo.disconnect();
      window.removeEventListener('vireek:cookie-banner', onEvent);
    };
  }, []);
  return open;
}

/** On-screen keyboard open (not pinch-zoom): a fixed bottom bar would ride on top of the keyboard. */
function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const check = () => setOpen(vv.scale <= 1.01 && window.innerHeight - vv.height > 150);
    vv.addEventListener('resize', check);
    return () => vv.removeEventListener('resize', check);
  }, []);
  return open;
}

export function StickyMobileCta() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const heroVisible = useAnyVisible('[data-hero-cta]', true);
  const footerVisible = useAnyVisible('footer', false);
  const cookieOpen = useConsentBannerOpen();
  const keyboardOpen = useKeyboardOpen();

  const show = !heroVisible && !footerVisible && !cookieOpen && !keyboardOpen;

  // Publishes the bar height as --vk-bottom-bar-h so floating launchers (Support) sit above it instead of covering "Call".
  useBottomReserve(ref, show, 767);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          ref={ref}
          data-testid="sticky-cta"
          initial={reduce ? false : { y: '100%' }}
          animate={{ y: 0 }}
          exit={reduce ? { opacity: 0 } : { y: '100%' }}
          transition={{ duration: reduce ? 0 : 0.28, ease: [0.16, 1, 0.3, 1] }}
          className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg-secondary/90 px-4 pt-3 shadow-[0_-8px_24px_-14px_rgb(0_0_0/0.35)] backdrop-blur-xl md:hidden"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <div className="mx-auto flex max-w-md items-stretch gap-2">
            <ButtonLink to="/signup" className="min-w-0 flex-1" onClick={() => trackHomeCta('sticky_primary')}>
              Start free trial
            </ButtonLink>
            <ButtonAnchor
              href={SARAH_PHONE}
              variant="secondary"
              aria-label="Call Sarah"
              className="shrink-0 px-4"
              onClick={() => trackHomeCta('sticky_call')}
            >
              <Phone size={18} aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Call</span>
            </ButtonAnchor>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
