// src/lib/askVireek/useBodyScrollLock.ts
//
// Locks page scroll while a full-height sheet is open, compensating for the
// scrollbar width so the page does not shift (no layout shift on open/close).

import { useEffect } from 'react';

export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevPad = body.style.paddingInlineEnd;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (gap > 0) body.style.paddingInlineEnd = `${gap}px`;
    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingInlineEnd = prevPad;
    };
  }, [active]);
}
