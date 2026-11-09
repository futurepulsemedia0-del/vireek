import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { createEntitlementStore, isEntitled, passesModuleGate, resolveEntitlement, type EntitlementResult, type EntitlementSnapshot } from '@/lib/entitlements';
import { fetchMyEntitlements } from '@/lib/entitlementsApi';

// One store for the whole app: every component shares a single request (all modules at once) and cache.
const store = createEntitlementStore({ fetchRows: fetchMyEntitlements });

let activeUserId: string | null = null;
let focusListenerInstalled = false;

function installFocusRefresh() {
  if (focusListenerInstalled || typeof window === 'undefined') return;
  focusListenerInstalled = true;
  // The store's TTL makes this a no-op most of the time; it picks up staff grants/revokes after a tab switch.
  window.addEventListener('focus', () => { void store.refresh(activeUserId); });
}

function useSnapshot(): { snap: EntitlementSnapshot; uid: string | null } {
  const { user } = useAuth();
  const uid = user?.id ?? null;
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    activeUserId = uid;
    installFocusRefresh();
    void store.refresh(uid);
  }, [uid]);
  return { snap, uid };
}

/**
 * Is this module available to the signed-in account? Default deny: false while loading, signed out,
 * on a failed first load, when there is no row, or when the grant has expired.
 * `status` lets screens show a skeleton / retry instead of a false "not available".
 * Gating the UI is a convenience; the data layer must still enforce with has_module() / requireEntitlement().
 */
export function useEntitlement(moduleId: string): EntitlementResult {
  const { snap, uid } = useSnapshot();
  return resolveEntitlement(snap, uid, moduleId, Date.now());
}

/** For lists (nav, command palette): one subscription, many checks, no extra requests. `has` is stable per snapshot. */
export function useEntitlements(): { ready: boolean; has: (moduleId: string) => boolean } {
  const { snap, uid } = useSnapshot();
  const ready = uid !== null && snap.userId === uid && snap.fetchedAt > 0;
  const has = useCallback((id: string) => ready && isEntitled(snap.rows.get(id), Date.now()), [ready, snap]);
  return { ready, has };
}

/** Nav helper: items without `requiresModule` always pass. */
export function useModuleGate() {
  const { has } = useEntitlements();
  return (requiresModule: string | undefined) => passesModuleGate(requiresModule, has);
}

/** Force a refetch (e.g. right after checkout or a staff grant). */
export function refreshEntitlements(): Promise<void> {
  return store.refresh(activeUserId, true);
}
