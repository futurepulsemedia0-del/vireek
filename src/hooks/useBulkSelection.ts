import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EMPTY_SELECTION,
  applyClick,
  checkState,
  pruneSelection,
  toggleMany as toggleManyState,
  type CheckState,
  type SelectionState,
} from '@/lib/bulk/selection';

/**
 * Multi-select with shift-click ranges over `rows` (in DISPLAY order).
 * Selection is pruned automatically when rows disappear (deleted, filtered
 * out, view switched) so an action can never touch a row the user can't see.
 */
export function useBulkSelection<T extends { id: string }>(rows: T[]) {
  const orderedIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const idKey = useMemo(() => orderedIds.join('\u0001'), [orderedIds]);
  const [state, setState] = useState<SelectionState>(EMPTY_SELECTION);

  useEffect(() => {
    setState((s) => {
      const next = pruneSelection(s.selected, orderedIds);
      if (next === s.selected) return s;
      return { selected: next, anchor: s.anchor && next.has(s.anchor) ? s.anchor : null };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey]);

  const toggle = useCallback(
    (id: string, shiftKey = false) => setState((s) => applyClick(s, orderedIds, id, { shiftKey })),
    [orderedIds],
  );
  const toggleMany = useCallback((ids: string[]) => setState((s) => toggleManyState(s, ids)), []);
  const selectAll = useCallback(() => setState({ selected: new Set(orderedIds), anchor: null }), [orderedIds]);
  const clear = useCallback(() => setState(EMPTY_SELECTION), []);
  const remove = useCallback(
    (ids: string[]) =>
      setState((s) => {
        const next = new Set(s.selected);
        ids.forEach((id) => next.delete(id));
        return { selected: next, anchor: s.anchor };
      }),
    [],
  );

  const selectedRows = useMemo(() => rows.filter((r) => state.selected.has(r.id)), [rows, state.selected]);
  const stateFor = useCallback((ids: string[]): CheckState => checkState(state.selected, ids), [state.selected]);

  return {
    selectedIds: state.selected,
    selectedRows,
    count: state.selected.size,
    isSelected: (id: string) => state.selected.has(id),
    toggle,
    toggleMany,
    selectAll,
    clear,
    remove,
    stateFor,
  };
}
