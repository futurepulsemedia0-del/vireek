import { useCallback, useEffect, useRef, useState } from 'react';
import type { Job } from '@/lib/supabase';
import { fetchRulesBundle, type RulesBundle } from '@/lib/dispatchRulesApi';

/**
 * Rules + technicians + loads for the Dispatch Board, in a fixed number of queries regardless of job count.
 * Returns `bundle: null` while loading or when the rules tables are unavailable, so callers render nothing
 * and the board keeps working exactly as before.
 */
export function useDispatchRulesData(ownerId: string | null | undefined, jobs: Job[]) {
  const [bundle, setBundle] = useState<RulesBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const seq = useRef(0);

  // Everything that can change a ranking: which jobs exist, who holds them, when, for whom.
  const key = jobs.map((j) => [j.id, j.job_status, j.assigned_technician_id ?? '', j.scheduled_datetime ?? '', j.customer_id ?? ''].join(':')).join('|');

  const reload = useCallback(async () => {
    if (!ownerId) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const next = await fetchRulesBundle(ownerId, jobsRef.current as unknown as Record<string, unknown>[]);
      if (mine === seq.current) setBundle(next);
    } catch {
      if (mine === seq.current) setBundle(null);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => {
    const t = setTimeout(() => void reload(), 350); // debounce bursts of realtime updates
    return () => clearTimeout(t);
  }, [key, reload]);

  return { bundle, loading, reload };
}
