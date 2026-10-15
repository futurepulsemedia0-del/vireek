import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  evaluateSystemHealth,
  summarizeHealth,
  type HealthCheck,
  type HealthSummary,
  type SystemHealthSnapshot,
} from '@/lib/systemHealth';

const REFRESH_MS = 120_000;
const STALE_MS = 60_000;

export type SystemHealthStatus = 'loading' | 'ready' | 'error';

export interface UseSystemHealth {
  status: SystemHealthStatus;
  checks: HealthCheck[];
  summary: HealthSummary | null;
  checkedAt: Date | null;
  refreshing: boolean;
  refresh: () => void;
}

export function useSystemHealth(enabled = true): UseSystemHealth {
  const [snapshot, setSnapshot] = useState<SystemHealthSnapshot | null>(null);
  const [status, setStatus] = useState<SystemHealthStatus>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const seq = useRef(0);
  const lastRun = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    lastRun.current = Date.now();
    setRefreshing(true);
    try {
      const { data, error } = await supabase.rpc('get_system_health_snapshot');
      if (id !== seq.current) return;
      if (error || !data) throw error ?? new Error('Empty health snapshot');
      setSnapshot(data as SystemHealthSnapshot);
      setCheckedAt(new Date());
      setStatus('ready');
    } catch {
      if (id !== seq.current) return;
      // Never keep showing stale green after a failed check.
      setSnapshot(null);
      setStatus('error');
    } finally {
      if (id === seq.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRun.current > STALE_MS) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      seq.current += 1; // invalidate in-flight request
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, load]);

  const checks = useMemo(() => (snapshot ? evaluateSystemHealth(snapshot, checkedAt ?? new Date()) : []), [snapshot, checkedAt]);
  const summary = useMemo(() => (checks.length ? summarizeHealth(checks) : null), [checks]);

  return { status, checks, summary, checkedAt, refreshing, refresh: () => void load() };
}
