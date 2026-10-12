export type SortDir = 'asc' | 'desc';

export interface ViewSort {
  key: string;
  dir: SortDir;
}

export type SortValue = string | number | boolean | null | undefined;

const isNil = (v: SortValue): v is null | undefined | '' => v === null || v === undefined || v === '';

function compareDefined(a: string | number | boolean, b: string | number | boolean): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Stable, null-safe sort driven by a ViewSort.
 * - Empty values (null / undefined / '') always sink to the bottom,
 *   regardless of direction, so "oldest first" never leads with blanks.
 * - Ties keep their original order (stable).
 * - Unknown key or null sort returns a shallow copy in the original order.
 */
export function sortRows<T>(
  rows: readonly T[],
  sort: ViewSort | null | undefined,
  accessors: Record<string, (row: T) => SortValue>,
): T[] {
  const get = sort ? accessors[sort.key] : undefined;
  if (!sort || !get) return [...rows];
  const mult = sort.dir === 'desc' ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, value: get(row) }))
    .sort((x, y) => {
      const xn = isNil(x.value);
      const yn = isNil(y.value);
      if (xn || yn) return xn && yn ? x.index - y.index : xn ? 1 : -1;
      const c = compareDefined(x.value as string | number | boolean, y.value as string | number | boolean) * mult;
      return c !== 0 ? c : x.index - y.index;
    })
    .map((e) => e.row);
}

/** Returns `raw` only if its key is one of `allowedKeys`; otherwise `fallback`. */
export function coerceSort(raw: ViewSort | null | undefined, allowedKeys: readonly string[], fallback: ViewSort | null): ViewSort | null {
  if (raw && allowedKeys.includes(raw.key) && (raw.dir === 'asc' || raw.dir === 'desc')) return raw;
  return fallback;
}
