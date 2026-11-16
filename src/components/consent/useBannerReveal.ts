import { useEffect, useState } from 'react';
import {
  BANNER_IDLE_TIMEOUT_MS,
  BANNER_REVEAL_DELAY_MS,
  BANNER_SCROLL_REVEAL_RATIO,
  scrollRatio,
} from '@/lib/consent/bannerTiming';

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};
type PrerenderDocument = Document & { prerendering?: boolean };

/**
 * Decides WHEN the cookie banner may appear. It never decides whether (that stays with the consent engine).
 *
 * Reveal happens at the earlier of:
 *  - BANNER_REVEAL_DELAY_MS of tab-visible time after the page has fully loaded, or
 *  - the first click/tap, or the first scroll past BANNER_SCROLL_REVEAL_RATIO of the page (after load).
 * The final state change is scheduled with requestIdleCallback (setTimeout fallback), so it cannot
 * compete with LCP/INP. The timer pauses while the tab is hidden and while the page is prerendering.
 * Once revealed it stays revealed (SPA navigation does not restart the delay).
 */
export function useBannerReveal(enabled: boolean): boolean {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (!enabled || revealed) return undefined;

    const win = window as IdleWindow;
    const doc = document as PrerenderDocument;
    let loaded = false;
    let done = false;
    let timer: number | undefined;
    let startedAt = 0;
    let remaining = BANNER_REVEAL_DELAY_MS;
    let idleHandle: number | undefined;
    let fallbackHandle: number | undefined;

    const startTimer = () => {
      if (done || !loaded || timer !== undefined || doc.visibilityState !== 'visible') return;
      startedAt = performance.now();
      timer = window.setTimeout(finish, remaining);
    };
    const pauseTimer = () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
      remaining = Math.max(0, remaining - (performance.now() - startedAt));
    };
    const tryBegin = () => {
      if (loaded || doc.readyState !== 'complete' || doc.prerendering === true) return;
      loaded = true;
      startTimer();
    };
    const onVisibility = () => (doc.visibilityState === 'visible' ? startTimer() : pauseTimer());
    const onPointer = () => {
      if (loaded) finish();
    };
    const onScroll = () => {
      if (!loaded) return;
      const el = document.scrollingElement ?? document.documentElement;
      if (scrollRatio(el.scrollTop, el.scrollHeight, el.clientHeight) >= BANNER_SCROLL_REVEAL_RATIO) finish();
    };

    function finish() {
      if (done) return;
      done = true;
      removeListeners();
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (typeof win.requestIdleCallback === 'function') {
        idleHandle = win.requestIdleCallback(() => setRevealed(true), { timeout: BANNER_IDLE_TIMEOUT_MS });
      } else {
        fallbackHandle = window.setTimeout(() => setRevealed(true), 0);
      }
    }
    function removeListeners() {
      window.removeEventListener('load', tryBegin);
      doc.removeEventListener('prerenderingchange', tryBegin);
      doc.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('scroll', onScroll);
    }

    window.addEventListener('load', tryBegin);
    doc.addEventListener('prerenderingchange', tryBegin);
    doc.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pointerdown', onPointer, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    tryBegin();

    return () => {
      done = true;
      removeListeners();
      if (timer !== undefined) window.clearTimeout(timer);
      if (idleHandle !== undefined && typeof win.cancelIdleCallback === 'function') win.cancelIdleCallback(idleHandle);
      if (fallbackHandle !== undefined) window.clearTimeout(fallbackHandle);
    };
  }, [enabled, revealed]);

  return revealed;
}
