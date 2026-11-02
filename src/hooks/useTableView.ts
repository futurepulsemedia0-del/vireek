import { useCallback, useMemo } from 'react';
import { useTablePrefs } from '@/hooks/useTablePrefs';
import {
  DENSITY_CELL,
  hiddenFromVisible,
  moveColumn,
  resolveColumns,
  type ColumnDef,
  type Density,
  type TablePrefs,
} from '@/lib/tablePrefs';

/** Everything a table page needs from the saved per-user table state. */
export function useTableView(tableKey: string, columns: readonly ColumnDef[]) {
  const { prefs, update, reset, sync } = useTablePrefs(tableKey);
  const { ordered, visible } = useMemo(() => resolveColumns(columns, prefs), [columns, prefs]);

  const setVisible = useCallback(
    (keys: readonly string[]) => update({ hiddenColumns: hiddenFromVisible(columns, keys) }),
    [columns, update],
  );
  const toggleColumn = useCallback(
    (key: string) => {
      const keys = visible.map((c) => c.key);
      setVisible(keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]);
    },
    [setVisible, visible],
  );
  const move = useCallback(
    (key: string, dir: -1 | 1) => update({ columnOrder: moveColumn(ordered.map((c) => c.key), key, dir) }),
    [ordered, update],
  );
  const setWidth = useCallback(
    (key: string, px: number) => update({ columnWidths: { ...prefs.columnWidths, [key]: px } }),
    [prefs.columnWidths, update],
  );
  const setDensity = useCallback((density: Density) => update({ density }), [update]);
  const setPageSize = useCallback((pageSize: number) => update({ pageSize }), [update]);
  const setSort = useCallback((sort: TablePrefs['sort']) => update({ sort }), [update]);

  return {
    prefs,
    sync,
    reset,
    ordered,
    visible,
    visibleKeys: visible.map((c) => c.key),
    cellClass: DENSITY_CELL[prefs.density],
    density: prefs.density,
    pageSize: prefs.pageSize,
    widthOf: (c: ColumnDef): number | undefined => prefs.columnWidths[c.key] ?? c.defaultWidth,
    setVisible,
    toggleColumn,
    move,
    setWidth,
    setDensity,
    setPageSize,
    setSort,
  };
}
