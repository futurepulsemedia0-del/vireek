import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import {
  applyOps,
  discardOp,
  enqueueOp,
  fetchTruckSnapshot,
  flushQueue,
  loadCachedSnapshot,
  loadQueue,
  retryOp,
  saveCachedSnapshot,
  subscribeQueue,
  type NewOp,
  type QueuedOp,
  type SnapshotBlock,
  type TruckSnapshot,
} from '@/lib/truckStockField';

export type TruckStockStatus = 'loading' | 'ready' | 'error' | 'blocked';

const FLUSH_INTERVAL_MS = 30_000;
const STALE_AFTER_MS = 2 * 60_000;

export interface UseTruckStock {
  status: TruckStockStatus;
  /** Last server snapshot with not-yet-delivered operations applied on top. */
  snapshot: TruckSnapshot | null;
  blocked: SnapshotBlock | null;
  error: string | null;
  online: boolean;
  refreshing: boolean;
  /** When the snapshot on screen was last confirmed by the server (ms), or null if never. */
  syncedAt: number | null;
  queue: QueuedOp[];
  pendingCount: number;
  failedCount: number;
  refresh: () => Promise<void>;
  submit: (op: NewOp) => QueuedOp;
  retry: (id: string) => void;
  discard: (id: string) => void;
}

export function useTruckStock(): UseTruckStock {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [base, setBase] = useState<TruckSnapshot | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [queue, setQueue] = useState<QueuedOp[]>([]);
  const [status, setStatus] = useState<TruckStockStatus>('loading');
  const [blocked, setBlocked] = useState<SnapshotBlock | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [refreshing, setRefreshing] = useState(false);
  const syncedAtRef = useRef<number | null>(null);
  const userRef = useRef<string | null>(userId);
  userRef.current = userId;

  const load = useCallback(async () => {
    const uid = userRef.current;
    if (!uid) return;
    setRefreshing(true);
    const result = await fetchTruckSnapshot();
    if (userRef.current !== uid) return; // signed out / switched user while waiting
    setRefreshing(false);
    if (result.ok) {
      saveCachedSnapshot(uid, result.snapshot);
      setBase(result.snapshot);
      const now = Date.now();
      syncedAtRef.current = now;
      setSyncedAt(now);
      setBlocked(null);
      setError(null);
      setStatus('ready');
      return;
    }
    if (result.reason === 'not_a_technician' || result.reason === 'no_truck') {
      setBlocked(result.reason);
      setStatus('blocked');
      return;
    }
    // Network or server trouble: keep showing whatever is on the device if there is anything.
    setError(result.message);
    setStatus((s) => (s === 'ready' ? 'ready' : 'error'));
  }, []);

  const flush = useCallback(async () => {
    const uid = userRef.current;
    if (!uid) return;
    const summary = await flushQueue(uid);
    if (userRef.current !== uid) return;
    setQueue(loadQueue(uid));
    if (summary.applied.length > 0) {
      // Fold delivered ops into the base right away (no flicker), then fetch the authoritative numbers.
      setBase((b) => (b ? applyOps(b, summary.applied) : b));
      await load();
    }
  }, [load]);

  // Initial load: device first (instant, works offline), then the server.
  useEffect(() => {
    if (!userId) return;
    setQueue(loadQueue(userId));
    const cached = loadCachedSnapshot(userId);
    if (cached) {
      setBase(cached);
      const at = Date.parse(cached.generated_at);
      const ts = Number.isFinite(at) ? at : null;
      syncedAtRef.current = ts;
      setSyncedAt(ts);
      setStatus('ready');
    } else {
      setBase(null);
      setStatus('loading');
    }
    setBlocked(null);
    setError(null);
    void flush().then(load);
  }, [userId, flush, load]);

  // Keep the screen in step with the queue (this tab and any other tab).
  useEffect(() => {
    if (!userId) return;
    const sync = () => setQueue(loadQueue(userId));
    const off = subscribeQueue(sync);
    const onStorage = (e: StorageEvent) => {
      if (e.key?.startsWith(`vk:truck-stock:v1:${userId}:`)) sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      off();
      window.removeEventListener('storage', onStorage);
    };
  }, [userId]);

  // Connectivity, tab focus and a gentle timer.
  useEffect(() => {
    if (!userId) return;
    const onOnline = () => {
      setOnline(true);
      void flush().then(load);
    };
    const onOffline = () => setOnline(false);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void flush();
      if (syncedAtRef.current === null || Date.now() - syncedAtRef.current > STALE_AFTER_MS) void load();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => {
      if (navigator.onLine && loadQueue(userId).some((o) => o.state === 'pending')) void flush();
    }, FLUSH_INTERVAL_MS);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [userId, flush, load]);

  const submit = useCallback(
    (input: NewOp): QueuedOp => {
      const uid = userRef.current;
      if (!uid) throw new Error('Sign in again to record stock.');
      const op = enqueueOp(uid, input);
      setQueue(loadQueue(uid));
      if (navigator.onLine) void flush();
      return op;
    },
    [flush],
  );

  const retry = useCallback(
    (id: string) => {
      const uid = userRef.current;
      if (!uid) return;
      retryOp(uid, id);
      setQueue(loadQueue(uid));
      void flush();
    },
    [flush],
  );

  const discard = useCallback((id: string) => {
    const uid = userRef.current;
    if (!uid) return;
    discardOp(uid, id);
    setQueue(loadQueue(uid));
  }, []);

  const snapshot = useMemo(() => (base ? applyOps(base, queue) : null), [base, queue]);

  return {
    status,
    snapshot,
    blocked,
    error,
    online,
    refreshing,
    syncedAt,
    queue,
    pendingCount: queue.filter((o) => o.state === 'pending').length,
    failedCount: queue.filter((o) => o.state === 'failed').length,
    refresh: load,
    submit,
    retry,
    discard,
  };
}
