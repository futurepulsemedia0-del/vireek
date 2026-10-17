import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchTodayJobs, type TechnicianJob } from '@/lib/technicianOS';
import {
  buildEvent,
  clockStatus,
  currentJobId,
  foldEvents,
  getCurrentFix,
  newId,
  viewFromServer,
  type ClockEvent,
  type ClockEventType,
  type GpsFix,
  type ServerShiftJson,
} from '@/lib/timeClock';
import { fetchOpenShift, fetchRecentShifts, fetchTimeProfile, sendClockEvents, type ClosedShift, type TimeProfile } from '@/lib/timeClockApi';
import { EMPTY_QUEUE, dismissRejected, enqueue, flushQueue, loadQueue, queueKey, saveQueue, type QueueState } from '@/lib/timeClockQueue';

interface Cache {
  profile: TimeProfile | null;
  shift: ServerShiftJson | null;
  recent: ClosedShift[];
  jobs: TechnicianJob[];
}

const cacheKey = (userId: string) => `vireek.timeclock.cache.v1:${userId}`;
const SYNC_INTERVAL_MS = 30_000;

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

const memoryStore = new Map<string, string>();
const fallbackStorage = {
  getItem: (k: string) => memoryStore.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStore.set(k, v),
  removeItem: (k: string) => void memoryStore.delete(k),
};

export function useTimeClock() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const storage = safeStorage() ?? fallbackStorage;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [cache, setCache] = useState<Cache>({ profile: null, shift: null, recent: [], jobs: [] });
  const [queue, setQueue] = useState<QueueState>(EMPTY_QUEUE);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState<ClockEventType | null>(null);
  const [lastFix, setLastFix] = useState<GpsFix | null>(null);
  const [persistFailed, setPersistFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const queueRef = useRef(queue);
  const flushing = useRef(false);
  const profileRef = useRef<TimeProfile | null>(null);
  profileRef.current = cache.profile;

  const commitQueue = useCallback(
    (next: QueueState) => {
      queueRef.current = next;
      setQueue(next);
      if (userId && !saveQueue(storage, queueKey(userId), next)) setPersistFailed(true);
    },
    [storage, userId],
  );

  /** Pulls fresh server state. Falls back to the cached copy when offline. */
  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      const profile = await fetchTimeProfile();
      if (!profile) throw new Error('Your account is not set up as a technician.');
      const [shift, recent, jobs] = await Promise.all([
        fetchOpenShift(),
        fetchRecentShifts(profile.ownerId, profile.teamMemberId),
        fetchTodayJobs().catch(() => null),
      ]);
      setCache((prev) => {
        const next: Cache = { profile, shift, recent, jobs: jobs ?? prev.jobs };
        try {
          storage.setItem(cacheKey(userId), JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
      setStale(false);
      setLoadError(null);
    } catch (e) {
      setStale(true);
      if (!profileRef.current) setLoadError(e instanceof Error ? e.message : 'Could not load your time clock.');
    } finally {
      setLoading(false);
    }
  }, [storage, userId]);

  const flush = useCallback(async () => {
    if (flushing.current || queueRef.current.pending.length === 0) return;
    flushing.current = true;
    setSyncing(true);
    try {
      const out = await flushQueue(queueRef.current, sendClockEvents);
      commitQueue(out.state);
      if (out.confirmed > 0 || out.state.rejected.length > 0) await refresh();
    } finally {
      flushing.current = false;
      setSyncing(false);
    }
  }, [commitQueue, refresh]);

  // Boot: cached copy first (instant, works offline), then the network.
  useEffect(() => {
    if (!userId) return;
    try {
      const raw = storage.getItem(cacheKey(userId));
      if (raw) setCache(JSON.parse(raw) as Cache);
    } catch {
      /* corrupt cache — ignore */
    }
    commitQueue(loadQueue(storage, queueKey(userId)));
    void (async () => {
      await flush();
      await refresh();
    })();
  }, [userId, storage, commitQueue, flush, refresh]);

  // Reconnect / foreground / periodic retry.
  useEffect(() => {
    const goOnline = () => { setOnline(true); void flush().then(refresh); };
    const goOffline = () => setOnline(false);
    const visible = () => { if (document.visibilityState === 'visible') void flush(); };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    document.addEventListener('visibilitychange', visible);
    const timer = window.setInterval(() => { if (queueRef.current.pending.length > 0) void flush(); }, SYNC_INTERVAL_MS);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      document.removeEventListener('visibilitychange', visible);
      window.clearInterval(timer);
    };
  }, [flush, refresh]);

  const folded = useMemo(() => foldEvents(viewFromServer(cache.shift), queue.pending), [cache.shift, queue.pending]);
  const view = folded.view;
  const status = clockStatus(view);

  useEffect(() => {
    if (status === 'off') return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [status]);

  const act = useCallback(
    async (type: ClockEventType, jobId?: string | null) => {
      if (busy || !cache.profile) return;
      setBusy(type);
      try {
        const needsFix = type === 'clock_in' || type === 'clock_out';
        const fix = needsFix ? await getCurrentFix() : undefined;
        if (fix) setLastFix(fix);
        const shiftId = type === 'clock_in' ? newId() : view?.id;
        if (!shiftId) return;
        const ev: ClockEvent = buildEvent(type, shiftId, Date.now(), { jobId, fix });
        commitQueue(enqueue(queueRef.current, ev));
        setNow(Date.now());
        void flush();
      } finally {
        setBusy(null);
      }
    },
    [busy, cache.profile, view, commitQueue, flush],
  );

  return {
    loading,
    loadError,
    stale,
    online,
    syncing,
    busy,
    now,
    profile: cache.profile,
    jobs: cache.jobs,
    recent: cache.recent,
    view,
    status,
    jobId: currentJobId(view),
    pending: queue.pending.length,
    rejected: queue.rejected,
    persistFailed,
    lastFix,
    retry: () => { setLoading(true); setLoadError(null); void flush().then(refresh); },
    syncNow: () => void flush().then(refresh),
    dismiss: (id?: string) => commitQueue(dismissRejected(queueRef.current, id)),
    clockIn: (jobId: string | null) => act('clock_in', jobId),
    clockOut: () => act('clock_out'),
    startBreak: () => act('break_start'),
    endBreak: () => act('break_end'),
    switchJob: (jobId: string | null) => act('switch_job', jobId),
  };
}
