import { useSyncExternalStore } from 'react';

/**
 * Subscribes to a CSS media query. `fallback` is used where matchMedia does not exist
 * (SSR, jsdom) and for the server snapshot. Signature unchanged: useMediaQuery(query, fallback = false).
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener('change', notify);
      return () => mql.removeEventListener('change', notify);
    },
    () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}

/** Tablet = icon rail (md..lg). Mobile < md uses the bottom bar + drawer, desktop >= lg the full sidebar. */
export const useIsTabletRail = (): boolean => useMediaQuery('(min-width: 768px) and (max-width: 1023.98px)');
