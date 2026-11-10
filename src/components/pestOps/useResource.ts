import { useCallback, useEffect, useRef, useState } from 'react';
import { friendlyPestOpsError } from '@/lib/pestOpsApi';

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/** Loads once, exposes loading / error / reload. Ignores results that arrive after unmount. */
export function useResource<T>(load: () => Promise<T>, enabled = true): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await loadRef.current();
      if (!alive.current) return;
      setData(next);
      setError(null);
    } catch (e) {
      if (alive.current) setError(friendlyPestOpsError(e, 'Could not load this section.'));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  return { data, loading, error, reload };
}
