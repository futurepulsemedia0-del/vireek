import { useEffect, useReducer, useState } from 'react';
import { NET_EVENT, type NetState } from '@/lib/net/resilientFetch';
import { INITIAL_NET_STATE, isSlowConnection, netReducer, type ConnectionLike, type NetViewState } from '@/lib/net/netState';
import { whenIdle } from '@/lib/perf/idle';

interface NavigatorWithConnection extends Navigator {
  connection?: ConnectionLike & EventTarget;
}

/** Client-observed network health, fed by resilientFetch (slow calls, circuit breaker). */
export function useNetState(): NetViewState {
  const [state, dispatch] = useReducer(netReducer, INITIAL_NET_STATE);
  useEffect(() => {
    const onEvent = (e: Event) => dispatch({ type: (e as CustomEvent<NetState>).detail, at: Date.now() });
    window.addEventListener(NET_EVENT, onEvent);
    return () => window.removeEventListener(NET_EVENT, onEvent);
  }, []);
  return state;
}

/** Network Information API (Chromium only): true on 2g/slow-2g or when Data Saver is on. */
export function useSlowConnection(): boolean {
  const read = () => isSlowConnection((navigator as NavigatorWithConnection).connection);
  const [slow, setSlow] = useState(read);
  useEffect(() => {
    const conn = (navigator as NavigatorWithConnection).connection;
    if (!conn) return;
    const onChange = () => setSlow(read());
    conn.addEventListener('change', onChange);
    return () => conn.removeEventListener('change', onChange);
  }, []);
  return slow;
}

/**
 * Pending/syncing counts from the offline engine. The engine is imported lazily (idle),
 * so it never lands in the initial bundle.
 */
export function useSyncSnapshot(): { pending: number; syncing: boolean } {
  const [snap, setSnap] = useState({ pending: 0, syncing: false });
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const cancelIdle = whenIdle(() => {
      void import('@/lib/offline/sync').then((m) => {
        if (cancelled) return;
        const read = () => {
          const s = m.getSyncState();
          setSnap((p) => (p.pending === s.pending && p.syncing === s.syncing ? p : { pending: s.pending, syncing: s.syncing }));
        };
        read();
        unsubscribe = m.subscribeSync(read);
      });
    }, 3000);
    return () => {
      cancelled = true;
      cancelIdle();
      unsubscribe?.();
    };
  }, []);
  return snap;
}
