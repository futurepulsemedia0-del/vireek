import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import {
  DEFAULT_TABLE_PREFS,
  isValidTableKey,
  normalizeTablePrefs,
  pickNewer,
  readLocal,
  writeLocal,
  type Stamped,
  type TablePrefs,
} from '@/lib/tablePrefs';

export type PrefsSync = 'local' | 'syncing' | 'synced' | 'error';
const DEBOUNCE_MS = 800;

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/**
 * Per-user, per-table state: local first (instant, works offline), then synced to
 * `user_table_prefs`. Newest write wins across devices. Never blocks rendering.
 */
export function useTablePrefs(tableKey: string) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const valid = isValidTableKey(tableKey);
  const [prefs, setPrefs] = useState<TablePrefs>(() => {
    const local = userId && valid ? readLocal(userId, tableKey, storage()) : null;
    return local?.prefs ?? DEFAULT_TABLE_PREFS;
  });
  const [sync, setSync] = useState<PrefsSync>('local');
  const stamped = useRef<Stamped>({ prefs, updatedAt: 0 });
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);

  const flush = useCallback(async () => {
    if (!userId || !valid || !dirty.current) return;
    dirty.current = false;
    setSync('syncing');
    const { error } = await supabase.from('user_table_prefs').upsert(
      { user_id: userId, table_key: tableKey, state: stamped.current.prefs },
      { onConflict: 'user_id,table_key' },
    );
    if (error) {
      dirty.current = true; // retry on next change / flush
      setSync('error');
    } else {
      setSync('synced');
    }
  }, [userId, valid, tableKey]);

  // Initial load: reconcile local + remote.
  useEffect(() => {
    if (!userId || !valid) return;
    let cancelled = false;
    const local = readLocal(userId, tableKey, storage());
    if (local) {
      stamped.current = local;
      setPrefs(local.prefs);
    }
    void supabase
      .from('user_table_prefs')
      .select('state, updated_at')
      .eq('table_key', tableKey)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) return setSync('error');
        const remote: Stamped | null = data
          ? { prefs: normalizeTablePrefs(data.state), updatedAt: Date.parse(String(data.updated_at)) || 0 }
          : null;
        const winner = pickNewer(stamped.current.updatedAt > 0 ? stamped.current : null, remote);
        if (winner) {
          stamped.current = winner;
          setPrefs(winner.prefs);
          writeLocal(userId, tableKey, winner, storage());
          if (winner !== remote) {
            dirty.current = true; // local was newer → push it up
            void flush();
          } else {
            setSync('synced');
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, [userId, valid, tableKey, flush]);

  const update = useCallback(
    (patch: Partial<TablePrefs>) => {
      if (!userId || !valid) return;
      const next = normalizeTablePrefs({ ...stamped.current.prefs, ...patch });
      stamped.current = { prefs: next, updatedAt: Date.now() };
      setPrefs(next);
      writeLocal(userId, tableKey, stamped.current, storage());
      dirty.current = true;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [userId, valid, tableKey, flush],
  );

  // Flush pending changes when the tab is hidden or the table unmounts.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      if (timer.current) window.clearTimeout(timer.current);
      void flush();
    };
  }, [flush]);

  const reset = useCallback(() => update({ ...DEFAULT_TABLE_PREFS }), [update]);
  return { prefs, update, reset, sync };
}
