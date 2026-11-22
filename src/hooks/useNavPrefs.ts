import { useCallback, useEffect, useState } from 'react';
import {
  NAV_PREFS_EVENT,
  clearPins,
  loadNavPrefs,
  movePin,
  navPrefsKey,
  saveNavPrefs,
  togglePin,
  type NavPrefs,
  type PinResult,
} from '@/lib/navPrefs';

/**
 * The person's menu shortcuts. Every mounted copy (sidebar, mobile drawer, Navigation Center) stays in sync: changes are
 * announced on a same-tab event and, for other tabs, on the native `storage` event. Reads always come from the store,
 * so two quick clicks can never overwrite each other with a stale snapshot.
 */
export function useNavPrefs(userId: string | null | undefined) {
  const [prefs, setPrefs] = useState<NavPrefs>(() => loadNavPrefs(userId));

  useEffect(() => {
    setPrefs(loadNavPrefs(userId));
    const key = navPrefsKey(userId);
    const sync = () => setPrefs(loadNavPrefs(userId));
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === key) sync();
    };
    window.addEventListener(NAV_PREFS_EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(NAV_PREFS_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, [userId]);

  const commit = useCallback(
    (next: NavPrefs, current: NavPrefs) => {
      if (next === current) return;
      saveNavPrefs(userId, next);
      setPrefs(next);
      window.dispatchEvent(new Event(NAV_PREFS_EVENT));
    },
    [userId],
  );

  const toggle = useCallback(
    (href: string, allowed: ReadonlySet<string>): PinResult => {
      const current = loadNavPrefs(userId);
      const result = togglePin(current, href, allowed);
      if (result.ok) commit(result.prefs, current);
      return result;
    },
    [userId, commit],
  );

  const move = useCallback(
    (href: string, delta: -1 | 1) => {
      const current = loadNavPrefs(userId);
      commit(movePin(current, href, delta), current);
    },
    [userId, commit],
  );

  const clear = useCallback(() => {
    const current = loadNavPrefs(userId);
    commit(clearPins(current), current);
  }, [userId, commit]);

  return { prefs, toggle, move, clear };
}
