import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchActiveLocationId, fetchBrands, fetchLocations, saveActiveLocationId } from '@/lib/locationsApi';
import { resolveActiveLocationId, sortLocations, type Brand, type BusinessLocation } from '@/lib/locations';

/**
 * Shared, lazily-loaded store for the organization switcher.
 *
 * A tiny module-level store (instead of a new React provider) so the switcher, the settings page and
 * any future page can read the active location without touching main.tsx. State is keyed by user id:
 * signing out / switching accounts resets it, so one user's locations can never leak to the next.
 */

export interface LocationStoreState {
  userId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  locations: BusinessLocation[];
  brands: Brand[];
  activeId: string | null;
}

const INITIAL: LocationStoreState = { userId: null, status: 'idle', error: null, locations: [], brands: [], activeId: null };

let state: LocationStoreState = INITIAL;
let inflight: Promise<void> | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function set(next: Partial<LocationStoreState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => state;

export function resetLocationStore() {
  generation++;
  inflight = null;
  state = INITIAL;
  listeners.forEach((l) => l());
}

/** Load (or reload with `force`) locations, brands and the user's saved selection. Safe to call often. */
export function loadLocations(userId: string, force = false): Promise<void> {
  if (state.userId !== userId) resetLocationStore();
  if (inflight) return inflight;
  if (!force && state.userId === userId && state.status === 'ready') return Promise.resolve();

  const myGeneration = generation;
  set({ userId, status: state.status === 'ready' ? 'ready' : 'loading', error: null });
  inflight = (async () => {
    try {
      const [locations, saved] = await Promise.all([fetchLocations(), fetchActiveLocationId(userId)]);
      const brands = await fetchBrands(locations).catch(() => [] as Brand[]);
      if (myGeneration !== generation) return;
      const sorted = sortLocations(locations);
      const activeId = resolveActiveLocationId(sorted, state.activeId ?? saved);
      set({ locations: sorted, brands, activeId, status: 'ready', error: null });
    } catch (e) {
      if (myGeneration !== generation) return;
      set({ status: 'error', error: e instanceof Error ? e.message : 'Could not load locations.' });
    } finally {
      if (myGeneration === generation) inflight = null;
    }
  })();
  return inflight;
}

export function useLocations() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (userId) void loadLocations(userId);
    else resetLocationStore();
  }, [userId]);

  const reload = useCallback(() => (userId ? loadLocations(userId, true) : Promise.resolve()), [userId]);

  const setActive = useCallback(
    async (locationId: string) => {
      if (!userId) return;
      const previous = state.activeId;
      set({ activeId: locationId }); // optimistic
      try {
        await saveActiveLocationId(userId, locationId);
      } catch {
        // Selection still works for this session; it just will not persist across devices.
        if (state.activeId !== locationId) set({ activeId: previous });
      }
    },
    [userId],
  );

  const mine = snap.userId === userId;
  const locations = mine ? snap.locations : [];
  return {
    status: mine ? snap.status : ('loading' as const),
    error: mine ? snap.error : null,
    locations,
    brands: mine ? snap.brands : [],
    activeId: mine ? snap.activeId : null,
    activeLocation: locations.find((l) => l.id === (mine ? snap.activeId : null)) ?? null,
    reload,
    setActive,
  };
}
