import { useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { createFlagStore, type FlagSnapshot } from '@/lib/featureFlags';
import { fetchMyFlagKeys } from '@/lib/featureFlagsApi';

// One store for the whole app: every component shares a single request and cache.
const store = createFlagStore({ fetchKeys: fetchMyFlagKeys });

let activeUserId: string | null = null;
let focusListenerInstalled = false;

function installFocusRefresh() {
  if (focusListenerInstalled || typeof window === 'undefined') return;
  focusListenerInstalled = true;
  // Re-checks when the tab regains focus; the store's TTL makes this a no-op most of the time.
  window.addEventListener('focus', () => { void store.refresh(activeUserId); });
}

export interface FeatureFlagsState {
  /** True once flags have been fetched for the current user. */
  ready: boolean;
  isEnabled: (key: string, fallback?: boolean) => boolean;
}

/**
 * Feature flags for the signed-in tenant (team members share their account's flags).
 * Flags are evaluated server-side; this only reads the result. Before the first
 * fetch finishes — and for signed-out visitors — `isEnabled` returns the fallback
 * (default: off), so unreleased UI never flashes.
 */
export function useFeatureFlags(): FeatureFlagsState {
  const { user } = useAuth();
  const uid = user?.id ?? null;
  const snap: FlagSnapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    activeUserId = uid;
    installFocusRefresh();
    void store.refresh(uid);
  }, [uid]);

  // Never serve another user's flags during a user switch.
  const known = uid !== null && snap.userId === uid && snap.fetchedAt > 0;
  return {
    ready: known,
    isEnabled: (key, fallback = false) => (known ? snap.keys.has(key) : fallback),
  };
}

/** Convenience: `const showNewHome = useFeatureFlag('new_dashboard');` */
export function useFeatureFlag(key: string, fallback = false): boolean {
  return useFeatureFlags().isEnabled(key, fallback);
}

/** Force a refetch (e.g. right after an action that may change a flag). */
export function refreshFeatureFlags(): Promise<void> {
  return store.refresh(activeUserId, true);
}
