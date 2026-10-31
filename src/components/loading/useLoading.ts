import { useCallback, useEffect, useRef, useState } from 'react';

export type LoadingResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Tracks one or more overlapping async operations.
 * - `isLoading` is true while any run is pending (counter, so overlaps are safe)
 * - `run` never throws: it resolves to a discriminated result
 * - pending runs are aborted and state updates are skipped after unmount
 * Feed `isLoading` to <LoadingBoundary> / <Button loading> (they apply the 150/400ms rules).
 */
export function useLoading() {
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(true);
  const controllers = useRef(new Set<AbortController>());

  useEffect(() => {
    mounted.current = true;
    const live = controllers.current;
    return () => {
      mounted.current = false;
      live.forEach((c) => c.abort());
      live.clear();
    };
  }, []);

  const run = useCallback(async <T,>(task: (signal: AbortSignal) => Promise<T>): Promise<LoadingResult<T>> => {
    const ctrl = new AbortController();
    controllers.current.add(ctrl);
    if (mounted.current) {
      setPending((n) => n + 1);
      setError(null);
    }
    try {
      const value = await task(ctrl.signal);
      return { ok: true, value };
    } catch (e) {
      if (mounted.current && !ctrl.signal.aborted) setError(e);
      return { ok: false, error: e };
    } finally {
      controllers.current.delete(ctrl);
      if (mounted.current) setPending((n) => n - 1);
    }
  }, []);

  const reset = useCallback(() => setError(null), []);

  return { isLoading: pending > 0, error, run, reset };
}
