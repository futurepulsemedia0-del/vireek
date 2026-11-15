import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { computeKnowledge, type KnowledgeSnapshot } from '@/lib/sarahKnowledge';
import { loadLatestRun } from '@/pages/onboarding/sarah/sarahLearnApi';
import type { LearnField, LearnRun } from '@/pages/onboarding/sarah/sarahLearnLogic';

export type KnowledgeStatus = 'idle' | 'loading' | 'ready' | 'error';

const FIELD_COLUMNS = 'id,key,value,prev_value,confidence,assumed,sensitive,origin,source_id,citation,status,edit_count';
const REFOCUS_MIN_MS = 30_000;

/**
 * Latest Sarah learning run + its fields (2 small RLS-scoped reads, no page text).
 * Only the most recently STARTED request is applied, so a slow response can never
 * overwrite a newer one. Refreshes quietly when the tab regains focus.
 */
export function useSarahKnowledge(enabled: boolean): {
  status: KnowledgeStatus;
  run: LearnRun | null;
  snapshot: KnowledgeSnapshot;
  refresh: (silent?: boolean) => Promise<void>;
} {
  const [status, setStatus] = useState<KnowledgeStatus>('idle');
  const [run, setRun] = useState<LearnRun | null>(null);
  const [fields, setFields] = useState<LearnField[]>([]);
  const seq = useRef(0);

  const refresh = useCallback(async (silent = true) => {
    const id = ++seq.current;
    if (!silent) setStatus('loading');
    try {
      const latest = await loadLatestRun();
      let rows: LearnField[] = [];
      if (latest) {
        const { data, error } = await supabase.from('sarah_learn_fields').select(FIELD_COLUMNS).eq('run_id', latest.id);
        if (error) throw error;
        rows = (data ?? []) as LearnField[];
      }
      if (id !== seq.current) return;
      setRun(latest);
      setFields(rows);
      setStatus('ready');
    } catch {
      if (id !== seq.current) return;
      // A failed quiet refresh keeps what we already show; a failed first load is an error state.
      setStatus((prev) => (prev === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh(false);
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < REFOCUS_MIN_MS) return;
      last = Date.now();
      void refresh(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled, refresh]);

  const snapshot = useMemo(() => computeKnowledge(run, fields), [run, fields]);
  return { status, run, snapshot, refresh };
}
