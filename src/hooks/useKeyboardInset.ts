// src/hooks/useKeyboardInset.ts — height (px) of the on-screen keyboard / any UI covering the bottom of the
// layout viewport, from window.visualViewport. Returns 0 on desktop and when the API is unavailable.
// While `enabled`, also publishes it as --vk-kb-inset on <html> so non-React CSS can react (e.g. hide launchers).
import { useEffect, useState } from 'react';

const KEYBOARD_THRESHOLD_PX = 80; // ignore browser-chrome resizes (URL bar collapse) which are far smaller than a keyboard

export function useKeyboardInset(enabled = true): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!enabled || !vv) {
      setInset(0);
      return undefined;
    }
    const root = document.documentElement;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        const next = covered > KEYBOARD_THRESHOLD_PX ? Math.round(covered) : 0;
        setInset((prev) => (prev === next ? prev : next));
        root.style.setProperty('--vk-kb-inset', `${next}px`);
      });
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--vk-kb-inset');
    };
  }, [enabled]);

  return inset;
}
