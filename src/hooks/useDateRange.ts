import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  parseRangeParams,
  resolveRange,
  serializeRangeParams,
  toISODate,
  type RangePreset,
  type RangeSelection,
  type ResolvedRange,
} from '@/lib/dateRange';

export interface DateRangeController {
  selection: RangeSelection;
  range: ResolvedRange;
  defaultPreset: RangePreset;
  /** Pick a preset. Passing 'custom' without dates is ignored — use setCustom. */
  setPreset: (preset: Exclude<RangePreset, 'custom'>) => void;
  /** Dates must already be validated with validateCustomRange. */
  setCustom: (from: string, to: string) => void;
  setCompare: (compare: boolean) => void;
}

/**
 * Date-range state that lives in the URL (?range=&from=&to=&compare=), so a
 * view is shareable, survives refresh, and works with back/forward.
 *
 * Other query params (?tab=, ?job=, …) are never touched. Updates use
 * `replace` so flipping presets doesn't flood the history stack.
 */
export function useDateRange(defaultPreset: RangePreset = '30d'): DateRangeController {
  const [searchParams, setSearchParams] = useSearchParams();

  // Re-derive when the local day rolls over (tab left open past midnight).
  const dayKey = toISODate(new Date());

  const selection = useMemo(
    () => parseRangeParams(searchParams, defaultPreset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchParams, defaultPreset, dayKey],
  );

  // The concrete windows depend only on preset/dates/day — NOT on `compare` —
  // so toggling compare keeps the same Date objects and doesn't trigger refetches.
  const windows = useMemo(
    () => resolveRange({ ...selection, compare: true }, defaultPreset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection.preset, selection.from, selection.to, defaultPreset, dayKey],
  );
  const range = useMemo<ResolvedRange>(
    () => ({ ...windows, compare: selection.compare }),
    [windows, selection.compare],
  );

  const update = useCallback(
    (patch: Partial<RangeSelection>) => {
      setSearchParams(
        (prev) => {
          const current = parseRangeParams(prev, defaultPreset);
          return serializeRangeParams({ ...current, ...patch }, prev, defaultPreset);
        },
        { replace: true },
      );
    },
    [setSearchParams, defaultPreset],
  );

  const setPreset = useCallback(
    (preset: Exclude<RangePreset, 'custom'>) => update({ preset, from: null, to: null }),
    [update],
  );
  const setCustom = useCallback(
    (from: string, to: string) => update({ preset: 'custom', from, to }),
    [update],
  );
  const setCompare = useCallback((compare: boolean) => update({ compare }), [update]);

  return { selection, range, defaultPreset, setPreset, setCustom, setCompare };
}
