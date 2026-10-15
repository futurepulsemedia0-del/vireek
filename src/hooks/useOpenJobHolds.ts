import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchOpenHolds } from '@/lib/jobWorkflowApi';
import { indexHoldsByJob, summarizeHolds, type JobHold } from '@/lib/jobWorkflow';

const TICK_MS = 60_000;

/**
 * Open holds for the account, plus a `now` that ticks every minute so SLA chips stay live
 * without re-fetching. `refresh()` re-reads silently (keeps current data on a failed refresh).
 */
export function useOpenJobHolds() {
  const [holds, setHolds] = useState<JobHold[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const rows = await fetchOpenHolds();
      if (!alive.current) return;
      setHolds(rows);
      setError(false);
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const id = window.setInterval(() => setNow(new Date()), TICK_MS);
    return () => {
      alive.current = false;
      window.clearInterval(id);
    };
  }, [refresh]);

  const byJob = useMemo(() => indexHoldsByJob(holds), [holds]);
  const summary = useMemo(() => summarizeHolds(holds, now), [holds, now]);

  return { holds, byJob, summary, now, loading, error, refresh };
}
