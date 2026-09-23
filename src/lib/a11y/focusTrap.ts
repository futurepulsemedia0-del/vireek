// src/lib/a11y/focusTrap.ts
//
// Reusable focus trap for any dialog/modal/drawer. Keeps Tab/Shift+Tab
// cycling inside the trap element only (WCAG 2.4.3 Focus Order — the
// "good" kind of keyboard trap, contained on purpose), moves focus into
// the trap when it opens, and returns focus to whatever triggered it
// when it closes.
import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(active: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;

    triggerRef.current = document.activeElement as HTMLElement | null;

    const container = containerRef.current;
    if (!container) return;

    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    const first = focusables()[0];
    (first ?? container).focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];

      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      triggerRef.current?.focus?.();
    };
  }, [active]);

  return containerRef;
}

/** Escape بستن یک دیالوگ/دراور/منو رو صدا می‌زنه — همیشه کنار useFocusTrap استفاده بشه. */
export function useEscapeToClose(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, onClose]);
}
