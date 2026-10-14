import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import {
  fetchEarnings,
  fetchEarningsDetail,
  loadCachedEarnings,
  saveCachedEarnings,
  type EarningsBlock,
  type EarningsDetail,
  type EarningsSummary,
} from '@/lib/techEarnings';

export type EarningsStatus = 'loading' | 'ready' | 'error' | 'blocked';

export interface UseTechEarnings {
  status: EarningsStatus;
  summary: EarningsSummary | null;
  blocked: EarningsBlock | null;
  error: string | null;
  online: boolean;
  refreshing: boolean;
  /** When the numbers on screen were last confirmed by the server (ms), or null. */
  syncedAt: number | null;
  refresh: () => Promise<void>;
}

export function useTechEarnings(): UseTechEarnings {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const userRef = useRef<string | null>(userId);
  userRef.current = userId;

  const [summary, setSummary] = useState<EarningsSummary | null>(null);
  const [status, setStatus] = useState<EarningsStatus>('loading');
  const [blocked, setBlocked] = useState<EarningsBlock | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [refreshing, setRefreshing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    const uid = userRef.current;
    if (!uid) return;
    setRefreshing(true);
    const result = await fetchEarnings();
    if (userRef.current !== uid) return;
    setRefreshing(false);
    if (result.ok) {
      saveCachedEarnings(uid, result.data);
      setSummary(result.data);
      setSyncedAt(Date.now());
      setBlocked(null);
      setError(null);
      setStatus('ready');
      return;
    }
    if (result.reason === 'not_a_technician' || result.reason === 'no_pay_profile') {
      setBlocked(result.reason);
      setStatus('blocked');
      return;
    }
    setError(result.message);
    setStatus((s) => (s === 'ready' ? 'ready' : 'error'));
  }, []);

  // Device first (instant, works offline), then the server.
  useEffect(() => {
    if (!userId) return;
    const cached = loadCachedEarnings(userId);
    if (cached) {
      setSummary(cached);
      const at = Date.parse(cached.generated_at);
      setSyncedAt(Number.isFinite(at) ? at : null);
      setStatus('ready');
    } else {
      setSummary(null);
      setSyncedAt(null);
      setStatus('loading');
    }
    setBlocked(null);
    setError(null);
    void load();
  }, [userId, load]);

  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      void load();
    };
    const onOffline = () => setOnline(false);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void load();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  return { status, summary, blocked, error, online, refreshing, syncedAt, refresh: load };
}

export interface UseEarningsDetail {
  loading: boolean;
  detail: EarningsDetail | null;
  error: string | null;
  reload: () => void;
}

/** Loads the lines behind one period. `key` null = the current (not yet paid) period. */
export function useEarningsDetail(key: string | null, enabled: boolean): UseEarningsDetail {
  const [state, setState] = useState<{ loading: boolean; detail: EarningsDetail | null; error: string | null }>({
    loading: true,
    detail: null,
    error: null,
  });
  const cache = useRef(new Map<string, EarningsDetail>());
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const cacheKey = key ?? 'current';
    const hit = nonce === 0 ? cache.current.get(cacheKey) : undefined;
    if (hit) {
      setState({ loading: false, detail: hit, error: null });
      return;
    }
    let cancelled = false;
    setState({ loading: true, detail: cache.current.get(cacheKey) ?? null, error: null });
    void fetchEarningsDetail(key).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        cache.current.set(cacheKey, r.data);
        setState({ loading: false, detail: r.data, error: null });
      } else {
        setState((s) => ({ loading: false, detail: s.detail, error: navigator.onLine ? r.message : 'You are offline — details need a connection.' }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, enabled, nonce]);

  return { ...state, reload: () => setNonce((n) => n + 1) };
}
