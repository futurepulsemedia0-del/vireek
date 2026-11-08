import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { usePrefersReducedMotion } from '@/lib/usePrefersReducedMotion';

export interface MotionLoop<T extends HTMLElement> {
  /** Attach to the element that contains the moving content. */
  ref: RefObject<T | null>;
  /** Motion is reduced by the OS or the Accessibility Center: the content must not move at all. */
  reduced: boolean;
  /** The visitor pressed Pause (WCAG 2.2.2). */
  userPaused: boolean;
  /** True only when the content may move: not reduced, not paused, on screen, tab visible. */
  running: boolean;
  toggle: () => void;
}

/**
 * Controller for any auto-moving content longer than 5 seconds (marquee, ticker, auto-scroll, live stream).
 * Pauses automatically when the tab is hidden or the element is off-screen, and never runs when motion is reduced.
 */
export function useMotionLoop<T extends HTMLElement = HTMLElement>(options?: { defaultPaused?: boolean }): MotionLoop<T> {
  const ref = useRef<T | null>(null);
  const reduced = usePrefersReducedMotion();
  const [userPaused, setUserPaused] = useState(options?.defaultPaused ?? false);
  const [inView, setInView] = useState(true);
  const [tabVisible, setTabVisible] = useState(() => (typeof document === 'undefined' ? true : !document.hidden));

  useEffect(() => {
    const onVisibility = (): void => setTabVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setInView(last.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const toggle = useCallback(() => setUserPaused((p) => !p), []);
  return { ref, reduced, userPaused, running: !reduced && !userPaused && inView && tabVisible, toggle };
}
