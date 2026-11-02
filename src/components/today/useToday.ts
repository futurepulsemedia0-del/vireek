import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtimeSubscription, type RealtimeStatus } from '@/lib/realtime';
import { REFRESH_EVERY_MS, isStale } from '@/lib/todayHome.logic';
import { loadToday, type TodayData } from '@/lib/todayHomeApi';

export interface UseToday {
  data: TodayData | null;
  /** First load only. Later refreshes keep the previous data on screen. */
  status: 'loading' | 'ready' | 'error';
  /** A refresh failed or data is older than the stale threshold: show the stale banner, keep the numbers. */
  stale: boolean;
  lastOkAt: number | null;
  realtime: RealtimeStatus;
  refresh: () => void;
}

/**
 * Loads Today and keeps it honest: realtime events trigger a debounced reload, a 60 s heartbeat and tab-focus
 * reloads cover quiet accounts and dropped sockets, and a failed refresh NEVER blanks or zeroes the screen.
 */
export function useToday(ownerId: string | null | undefined, currency: string): UseToday {
  const [data, setData] = useState<TodayData | null>(null);
  const [status, setStatus] = useState<UseToday['status']>('loading');
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const reqId = useRef(0);
  const debounce = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    if (!ownerId) return;
    const id = ++reqId.current;
    try {
      const next = await loadToday(ownerId, currency);
      if (id !== reqId.current) return; // a newer request owns the screen
      setData(next);
      setLastOkAt(next.loadedAt);
      setStatus('ready');
    } catch {
      if (id !== reqId.current) return;
      setStatus((s) => (s === 'ready' ? 'ready' : 'error')); // keep showing what we had
    }
  }, [ownerId, currency]);

  const refresh = useCallback(() => void load(), [load]);

  useEffect(() => {
    setStatus('loading');
    setData(null);
    void load();
    const poll = window.setInterval(() => void load(), REFRESH_EVERY_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      reqId.current++;
      window.clearInterval(poll);
      window.clearInterval(tick);
      window.clearTimeout(debounce.current);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [load]);

  const onChange = useCallback(() => {
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => void load(), 1500);
  }, [load]);

  const filter = ownerId ? `user_id=eq.${ownerId}` : undefined;
  const realtime = useRealtimeSubscription({ channelName: `today-calls-${ownerId ?? 'anon'}`, table: 'calls', event: '*', filter, onChange, enabled: !!ownerId });
  useRealtimeSubscription({ channelName: `today-jobs-${ownerId ?? 'anon'}`, table: 'jobs', event: '*', filter, onChange, enabled: !!ownerId });
  useRealtimeSubscription({ channelName: `today-recovery-${ownerId ?? 'anon'}`, table: 'revenue_recovery_events', event: '*', filter, onChange, enabled: !!ownerId });

  return { data, status, stale: status === 'ready' && isStale(lastOkAt, now), lastOkAt, realtime, refresh };
}
