// src/lib/askVireek/useBottomReserve.ts
//
// Fixed bottom bars (cookie/consent banner, sticky mobile CTA, ...) publish their
// height as --vk-bottom-bar-h on <html> so floating launchers lift above them
// instead of overlapping. Heights of several bars do not add up: the tallest wins,
// because the bars are pinned to the same edge.

import { useEffect, type RefObject } from 'react';

const VAR = '--vk-bottom-bar-h';
const heights = new Map<symbol, number>();

function publish(): void {
  const max = Math.max(0, ...heights.values());
  document.documentElement.style.setProperty(VAR, `${Math.ceil(max)}px`);
}

/** `maxViewport`: the bar only exists below this viewport width (px), so wider screens reserve nothing. */
export function useBottomReserve(ref: RefObject<HTMLElement>, active: boolean, maxViewport = Infinity): void {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const key = Symbol('bottom-bar');
    const measure = () => {
      heights.set(key, window.innerWidth <= maxViewport ? el.getBoundingClientRect().height : 0);
      publish();
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      heights.delete(key);
      publish();
    };
  }, [ref, active, maxViewport]);
}
