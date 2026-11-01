import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeStatus } from '@/lib/realtime';
import { evaluateFreshness, shouldRefreshOnFocus, type FreshnessDecision, type RealtimeState } from '@/lib/trust/freshness';

interface Options {
  /** Reload the data. Must resolve when done and throw on failure. */
  refresh: () => Promise<void>;
  /** From `useRealtimeSubscription`; omit if the view has no realtime channel. */
  realtime?: RealtimeStatus;
  /** Pause everything (e.g. while a modal edit is open). */
  enabled?: boolean;
}

/**
 * Drives "Updated 2 min ago", the stale badge and the auto-refresh policy
 * (see lib/trust/freshness.ts). Call `markUpdated()` after any successful load.
 */
export function useFreshness({ refresh, realtime, enabled = true }: Options) {
  const [lastUpdatedAt, setLast] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [visible, setVisible] = useState(() => (typeof document === 'undefined' ? true : document.visibilityState === 'visible'));
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const inFlight = useRef(false);

  const state: RealtimeState = realtime === undefined ? 'none' : realtime === 'live' ? 'live' : realtime === 'reconnecting' ? 'reconnecting' : 'connecting';
  const decision: FreshnessDecision = evaluateFreshness({ lastUpdatedAt, now, realtime: state, online, visible });

  const lastRef = useRef(lastUpdatedAt);
  lastRef.current = lastUpdatedAt;
  const stateRef = useRef(state);
  stateRef.current = state;

  const markUpdated = useCallback(() => setLast(Date.now()), []);

  const doRefresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      await refreshRef.current();
      setLast(Date.now());
    } catch {
      /* the caller surfaces the error; the stale badge stays on */
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  // Browser signals.
  useEffect(() => {
    if (!enabled) return;
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    const vis = () => {
      const v = document.visibilityState === 'visible';
      setVisible(v);
      setNow(Date.now());
      if (v && shouldRefreshOnFocus(lastRef.current, Date.now(), stateRef.current)) void doRefresh();
    };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    document.addEventListener('visibilitychange', vis);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [enabled, doRefresh]);

  // Tick (for the relative label) + policy re-evaluation.
  useEffect(() => {
    if (!enabled || !visible) return;
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, [enabled, visible]);

  useEffect(() => {
    // The page does its own first load (and calls markUpdated); only auto-refresh once we have a baseline.
    if (enabled && lastUpdatedAt != null && decision.action === 'refresh' && !inFlight.current) void doRefresh();
  }, [enabled, lastUpdatedAt, decision.action, now, doRefresh]);

  // Reconnect: realtime came back after being down → catch up on missed events.
  const prev = useRef(state);
  useEffect(() => {
    if (enabled && prev.current === 'reconnecting' && state === 'live') void doRefresh();
    prev.current = state;
  }, [enabled, state, doRefresh]);

  return { lastUpdatedAt, now, decision, refreshing, refresh: doRefresh, markUpdated };
}
