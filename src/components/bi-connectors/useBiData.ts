import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtimeSubscription } from '@/lib/realtime';
import { useDataPlatformOwnerId } from '@/lib/dataPlatform';
import { listExportRuns, listRequests, listTargets, listTokens, type BiToken, type ExportRunRow, type ExportTargetRow, type RequestLogRow } from '@/lib/biConnectors';

export interface BiData {
  tokens: BiToken[];
  targets: ExportTargetRow[];
  runs: ExportRunRow[];
  requests: RequestLogRow[];
  loading: boolean;
  error: string | null;
  reload: (opts?: { silent?: boolean }) => Promise<void>;
  /** Ticks every 30 s so relative timestamps stay honest. */
  now: number;
}

/** One loader for the whole page. Export progress is live through Realtime (RLS still applies). */
export function useBiData(enabled = true): BiData {
  const ownerId = useDataPlatformOwnerId();
  const [tokens, setTokens] = useState<BiToken[]>([]);
  const [targets, setTargets] = useState<ExportTargetRow[]>([]);
  const [runs, setRuns] = useState<ExportRunRow[]>([]);
  const [requests, setRequests] = useState<RequestLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!ownerId || !enabled) return;
      if (!opts?.silent) setLoading(true);
      try {
        const [t, g, r, q] = await Promise.all([listTokens(ownerId), listTargets(ownerId), listExportRuns(ownerId), listRequests(ownerId)]);
        if (!alive.current) return;
        setTokens(t);
        setTargets(g);
        setRuns(r);
        setRequests(q);
        setError(null);
      } catch (err) {
        if (alive.current) {
          const m = err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : '';
          setError(m || 'Could not load your BI connectors.');
        }
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [ownerId, enabled],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const timer = useRef<number | undefined>(undefined);
  const bump = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void reload({ silent: true }), 600);
  }, [reload]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const live = !!ownerId && enabled;
  const filter = live ? `user_id=eq.${ownerId}` : undefined;
  useRealtimeSubscription({ channelName: `bi-runs-${ownerId}`, table: 'bi_export_runs', event: '*', filter, enabled: live, onChange: bump });
  useRealtimeSubscription({ channelName: `bi-targets-${ownerId}`, table: 'bi_export_targets', event: '*', filter, enabled: live, onChange: bump });

  return { tokens, targets, runs, requests, loading, error, reload, now };
}
