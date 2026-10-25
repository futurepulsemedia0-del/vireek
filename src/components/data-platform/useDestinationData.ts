import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  listDestinations,
  listEmbeds,
  listRuns,
  listSyncState,
  useDataPlatformOwnerId,
  type Destination,
  type EmbedRow,
  type SyncRun,
  type SyncState,
} from '@/lib/dataPlatform';

export interface DestinationData {
  destinations: Destination[];
  runs: SyncRun[];
  syncState: SyncState[];
  embeds: EmbedRow[];
  loading: boolean;
  error: string | null;
  /** Re-reads everything. Silent by default so the UI does not flash. */
  reload: (opts?: { silent?: boolean }) => Promise<void>;
  /** Ticks every 30 s so "5m ago" labels stay honest. */
  now: number;
}

/**
 * One loader for the whole Data Platform page. Destinations and runs are kept live through
 * Realtime (a sync started from a cron job shows up without a refresh); a 30 s tick keeps the
 * relative timestamps current.
 */
export function useDestinationData(enabled = true): DestinationData {
  const ownerId = useDataPlatformOwnerId();
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [syncState, setSyncState] = useState<SyncState[]>([]);
  const [embeds, setEmbeds] = useState<EmbedRow[]>([]);
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
        const [d, r, s, e] = await Promise.all([listDestinations(ownerId), listRuns(ownerId), listSyncState(ownerId), listEmbeds(ownerId)]);
        if (!alive.current) return;
        setDestinations(d);
        setRuns(r);
        setSyncState(s);
        setEmbeds(e);
        setError(null);
      } catch (err) {
        if (alive.current) setError(err instanceof Error ? err.message : 'Could not load your data platform.');
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

  // Coalesce bursts (a sync updates the run row several times) into one refetch.
  const timer = useRef<number | undefined>(undefined);
  const bump = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void reload({ silent: true }), 600);
  }, [reload]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const live = !!ownerId && enabled;
  const filter = live ? `user_id=eq.${ownerId}` : undefined;
  useRealtimeSubscription({ channelName: `dp-runs-${ownerId}`, table: 'dp_runs', event: '*', filter, enabled: live, onChange: bump });
  useRealtimeSubscription({ channelName: `dp-destinations-${ownerId}`, table: 'dp_destinations', event: '*', filter, enabled: live, onChange: bump });

  return { destinations, runs, syncState, embeds, loading, error, reload, now };
}
