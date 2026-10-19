// src/hooks/useWallboardFeed.ts
//
// Data + realtime for the TV. Strategy:
//   1. Token-gated RPC returns the full snapshot (the only data path).
//   2. A public Broadcast channel delivers EMPTY "nudge" events from DB triggers;
//      a nudge just causes a (debounced) refetch. No data travels over the socket.
//   3. A 20 s poll + visibility/online listeners cover a dropped socket or a TV
//      that slept. A failed refresh keeps the last good data and flags it stale.

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { RealtimeStatus } from '@/lib/realtime';
import { NUDGE_DEBOUNCE_MS, POLL_INTERVAL_MS, isValidWallboardToken, type WallboardSnapshot } from '@/lib/wallboard';
import { fetchWallboardSnapshot } from '@/lib/wallboardApi';

export type FeedState = 'loading' | 'ready' | 'invalid' | 'error';

export interface WallboardFeed {
  state: FeedState;
  snapshot: WallboardSnapshot | null;
  /** Epoch ms of the last successful refresh. */
  lastOkAt: number | null;
  realtime: RealtimeStatus;
  refresh: () => void;
}

export function useWallboardFeed(token: string | undefined): WallboardFeed {
  const valid = isValidWallboardToken(token);
  const [state, setState] = useState<FeedState>(valid ? 'loading' : 'invalid');
  const [snapshot, setSnapshot] = useState<WallboardSnapshot | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [realtime, setRealtime] = useState<RealtimeStatus>('connecting');
  const [channelKey, setChannelKey] = useState<string | null>(null);

  const inFlight = useRef(false);
  const queued = useRef(false);
  const alive = useRef(true);
  const debounce = useRef<number | null>(null);
  const hasData = useRef(false);

  const load = useCallback(async () => {
    if (!valid || !token) return;
    if (inFlight.current) {
      queued.current = true; // run once more after the current request, never in parallel
      return;
    }
    inFlight.current = true;
    try {
      const snap = await fetchWallboardSnapshot(token);
      if (!alive.current) return;
      if (snap === null) {
        hasData.current = false;
        setSnapshot(null);
        setState('invalid'); // revoked while the TV was running: stop showing data
        return;
      }
      hasData.current = true;
      setSnapshot(snap);
      setLastOkAt(Date.now());
      setChannelKey((prev) => (prev === snap.config.channelKey ? prev : snap.config.channelKey));
      setState('ready');
    } catch {
      if (!alive.current) return;
      // Keep showing the last good snapshot (it will be flagged stale); only a cold start shows the error screen.
      if (!hasData.current) setState('error');
    } finally {
      inFlight.current = false;
      if (queued.current && alive.current) {
        queued.current = false;
        void load();
      }
    }
  }, [valid, token]);

  const scheduleRefresh = useCallback(() => {
    if (debounce.current !== null) return;
    debounce.current = window.setTimeout(() => {
      debounce.current = null;
      void load();
    }, NUDGE_DEBOUNCE_MS);
  }, [load]);

  useEffect(() => {
    alive.current = true;
    if (valid) void load();
    return () => {
      alive.current = false;
      if (debounce.current !== null) {
        window.clearTimeout(debounce.current);
        debounce.current = null;
      }
    };
  }, [valid, load]);

  // Safety-net poll + wake-from-sleep / reconnect refresh.
  useEffect(() => {
    if (!valid) return;
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_INTERVAL_MS);
    const onWake = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [valid, load]);

  // Broadcast nudges. Subscribed only once the RPC has told us the channel key.
  useEffect(() => {
    if (!valid || !channelKey) return;
    let cancelled = false;
    const channel = supabase
      .channel(`wallboard:${channelKey}`, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'nudge' }, () => {
        if (!cancelled) scheduleRefresh();
      })
      .subscribe((status) => {
        if (cancelled) return;
        if (status === 'SUBSCRIBED') {
          setRealtime('live');
          scheduleRefresh(); // close the gap between the first fetch and the subscription
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtime('reconnecting');
        }
      });
    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [valid, channelKey, scheduleRefresh]);

  const refresh = useCallback(() => {
    if (!valid) return;
    setState((s) => (s === 'error' ? 'loading' : s));
    void load();
  }, [valid, load]);

  return { state: valid ? state : 'invalid', snapshot, lastOkAt, realtime, refresh };
}
