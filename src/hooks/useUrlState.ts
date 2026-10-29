import { useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { readUrlState, writeUrlState, type UrlSchema, type UrlStateOf } from '@/lib/nav/urlState';

/**
 * Typed URL state. `schema` MUST be a module-level constant (stable identity).
 *
 *   const SCHEMA = { q: codec.string('', { resets: ['page'] }), page: codec.int(1, { min: 1, history: 'push' }) };
 *   const [state, setState] = useUrlState(SCHEMA);
 *   setState({ q: 'leak' });            // replace, page resets to 1
 *   setState({ page: 2 });              // push
 *
 * Invalid values degrade to defaults, defaults are omitted from the URL, and an
 * unchanged write never touches history.
 */
export function useUrlState<S extends UrlSchema>(schema: S) {
  const [params, setParams] = useSearchParams();
  const latest = useRef(params);
  latest.current = params;

  const state = useMemo(() => readUrlState(schema, params), [schema, params]);

  const setState = useCallback(
    (patch: Partial<UrlStateOf<S>>, opts?: { history?: 'push' | 'replace' }) => {
      const result = writeUrlState(schema, latest.current, patch);
      if (!result.changed) return;
      latest.current = result.params; // consecutive calls in one tick compose
      setParams(result.params, { replace: (opts?.history ?? result.history) === 'replace' });
    },
    [schema, setParams],
  );

  return [state, setState] as const;
}
