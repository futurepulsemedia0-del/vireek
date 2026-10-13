/**
 * Pure selection logic for bulk actions (no React) so it is trivially testable.
 * Shift-click selects/deselects the range between the last clicked row
 * (the "anchor") and the row just clicked, in the order rows are displayed.
 */
export interface SelectionState {
  selected: Set<string>;
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchor: null };

export function rangeIds(orderedIds: string[], anchorId: string, targetId: string): string[] {
  const a = orderedIds.indexOf(anchorId);
  const b = orderedIds.indexOf(targetId);
  if (a === -1 || b === -1) return b === -1 ? [] : [targetId];
  const [from, to] = a <= b ? [a, b] : [b, a];
  return orderedIds.slice(from, to + 1);
}

export function applyClick(
  state: SelectionState,
  orderedIds: string[],
  id: string,
  opts: { shiftKey?: boolean } = {},
): SelectionState {
  if (!orderedIds.includes(id)) return state;
  const next = new Set(state.selected);
  const willSelect = !next.has(id);
  const ids = opts.shiftKey && state.anchor ? rangeIds(orderedIds, state.anchor, id) : [id];
  for (const x of ids) {
    if (willSelect) next.add(x);
    else next.delete(x);
  }
  return { selected: next, anchor: id };
}

export function toggleMany(state: SelectionState, ids: string[]): SelectionState {
  if (ids.length === 0) return state;
  const allSelected = ids.every((id) => state.selected.has(id));
  const next = new Set(state.selected);
  for (const id of ids) {
    if (allSelected) next.delete(id);
    else next.add(id);
  }
  return { selected: next, anchor: state.anchor };
}

/** Drops ids that are no longer visible (deleted, filtered out). Returns the same set when nothing changed. */
export function pruneSelection(selected: Set<string>, orderedIds: string[]): Set<string> {
  if (selected.size === 0) return selected;
  const visible = new Set(orderedIds);
  let changed = false;
  const next = new Set<string>();
  for (const id of selected) {
    if (visible.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : selected;
}

export type CheckState = 'none' | 'some' | 'all';

export function checkState(selected: Set<string>, ids: string[]): CheckState {
  if (ids.length === 0) return 'none';
  let n = 0;
  for (const id of ids) if (selected.has(id)) n++;
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
}
