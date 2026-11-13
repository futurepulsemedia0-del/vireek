// Recreated: verify against original intent
// src/hooks/useChiefOverview.ts
//
// Loads the Chief of Staff overview (one edge-function aggregation) and exposes reload / refresh.
// - `reload` re-reads the overview without recomputing recommendations.
// - `refresh` asks the server to recompute (it may throttle), then re-reads.
// Only the latest request may update state, and nothing updates after unmount.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChiefOfStaffError, fetchOverview, refreshRecommendations, type Overview } from '@/lib/chiefOfStaff';

export type ChiefOverviewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'forbidden' }
  | { status: 'ready'; data: Overview };

export function useChiefOverview() {
  const [state, setState] = useState<ChiefOverviewState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [failedSources, setFailedSources] = useState<string[]>([]);
  // A fresh object per failure so the page's effect re-fires on every failed refresh.
  const [refreshError, setRefreshError] = useState<{ at: number } | null>(null);

  const alive = useRef(true);
  const seq = useRef(0);
  const refreshLock = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Returns true when the overview was read successfully. */
  const load = useCallback(async (): Promise<boolean> => {
    const mine = ++seq.current;
    try {
      const data = await fetchOverview();
      if (alive.current && mine === seq.current) setState({ status: 'ready', data });
      return true;
    } catch (err) {
      if (alive.current && mine === seq.current) {
        const forbidden = err instanceof ChiefOfStaffError && (err.status === 401 || err.status === 403);
        // Keep what is already on screen when a background reload fails: only the first load shows an error.
        setState((prev) => (prev.status === 'ready' && !forbidden ? prev : { status: forbidden ? 'forbidden' : 'error' }));
      }
      return false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(async () => {
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    await load();
  }, [load]);

  const refresh = useCallback(async () => {
    if (refreshLock.current) return; // synchronous guard: a double click never starts two refreshes
    refreshLock.current = true;
    setRefreshing(true);
    try {
      const res = await refreshRecommendations();
      if (alive.current) setFailedSources(res.failed_sources ?? []);
      await load();
    } catch {
      if (alive.current) setRefreshError({ at: Date.now() });
    } finally {
      refreshLock.current = false;
      if (alive.current) setRefreshing(false);
    }
  }, [load]);

  return { state, reload, refresh, refreshing, failedSources, refreshError };
}
