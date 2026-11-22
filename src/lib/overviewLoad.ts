/**
 * Pure helpers for the Overview page's data loading. They exist so that three failure modes are testable on their own:
 *  1. Supabase reports failures in `{ error }` (it does not throw), so a failed query used to look like "no data".
 *  2. The page only loads the newest N rows; past N the totals are incomplete and the person must be told.
 *  3. A realtime INSERT can arrive for a row the initial load already returned, which would be counted twice.
 */
export interface QueryResultLike {
  error?: { message?: string } | null;
}

/** The first failure among the results, or null when every query succeeded. */
export function firstLoadError(results: readonly (QueryResultLike | null | undefined)[]): string | null {
  for (const r of results) {
    if (r?.error) return r.error.message || 'Query failed';
  }
  return null;
}

/** True when the query returned as many rows as the cap allows, i.e. older rows may exist that were not counted. */
export function hitRowCap(length: number, cap: number): boolean {
  return cap > 0 && length >= cap;
}

/** Puts `row` first, replacing any existing row with the same id, and keeps at most `cap` rows. Never mutates `prev`. */
export function prependUnique<T extends { id: string }>(prev: readonly T[], row: T, cap: number): T[] {
  const rest = prev.filter((r) => r.id !== row.id);
  return [row, ...rest].slice(0, Math.max(0, cap));
}

export function replaceById<T extends { id: string }>(prev: readonly T[], row: T): T[] {
  return prev.map((r) => (r.id === row.id ? row : r));
}

export function removeById<T extends { id: string }>(prev: readonly T[], id: string | undefined | null): T[] {
  return id ? prev.filter((r) => r.id !== id) : [...prev];
}
