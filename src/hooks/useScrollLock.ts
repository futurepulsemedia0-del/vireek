// src/hooks/useScrollLock.ts — reference-counted page scroll lock for sheets/dialogs.
// Locks <html> scrolling without layout jump (compensates the classic scrollbar width) and stops scroll chaining.
// Several overlays can lock at once; the page unlocks only when the last one releases.
import { useEffect } from 'react';

let locks = 0;
let saved: { overflow: string; paddingRight: string; overscroll: string } | null = null;

function lock(): void {
  if (locks++ > 0) return;
  const el = document.documentElement;
  const scrollbar = window.innerWidth - el.clientWidth; // 0 on overlay-scrollbar (mobile) browsers
  saved = { overflow: el.style.overflow, paddingRight: el.style.paddingRight, overscroll: el.style.overscrollBehavior };
  el.style.overflow = 'hidden';
  el.style.overscrollBehavior = 'none';
  if (scrollbar > 0) el.style.paddingRight = `${scrollbar}px`;
}

function unlock(): void {
  if (locks === 0 || --locks > 0) return;
  const el = document.documentElement;
  if (saved) {
    el.style.overflow = saved.overflow;
    el.style.paddingRight = saved.paddingRight;
    el.style.overscrollBehavior = saved.overscroll;
  }
  saved = null;
}

export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    lock();
    return unlock;
  }, [active]);
}
