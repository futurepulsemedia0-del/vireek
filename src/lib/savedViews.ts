import { supabase } from '@/lib/supabase';
import type { ViewSort } from '@/lib/viewSort';

export const SAVED_VIEW_PAGES = ['calls', 'leads', 'jobs', 'customers', 'quotes', 'invoices', 'equipment'] as const;
export type SavedViewPage = (typeof SAVED_VIEW_PAGES)[number];

export const MAX_VIEW_NAME_LENGTH = 60;
export const MAX_FILTERS_JSON_LENGTH = 16 * 1024;

export interface SavedView {
  id: string;
  user_id: string;
  owner_id: string;
  page: SavedViewPage;
  name: string;
  filters: Record<string, unknown>;
  sort: ViewSort | null;
  columns: string[] | null;
  is_shared: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

/** Everything a page needs to restore a view. */
export interface ViewState {
  filters: Record<string, unknown>;
  sort?: ViewSort | null;
  columns?: string[] | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — unit tested)
// ---------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function normalizeSort(raw: unknown): ViewSort | null {
  if (!isPlainObject(raw)) return null;
  const { key, dir } = raw;
  if (typeof key !== 'string' || key.length === 0) return null;
  if (dir !== 'asc' && dir !== 'desc') return null;
  return { key, dir };
}

export function normalizeColumns(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return Array.from(new Set(raw.filter((c): c is string => typeof c === 'string' && c.length > 0)));
}

export function normalizeViewName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Returns an error message, or null when the name is acceptable. */
export function validateViewName(raw: string, existing: readonly SavedView[], exceptId?: string): string | null {
  const name = normalizeViewName(raw);
  if (!name) return 'Give the view a name.';
  if (name.length > MAX_VIEW_NAME_LENGTH) return `Keep the name to ${MAX_VIEW_NAME_LENGTH} characters or fewer.`;
  const key = name.toLowerCase();
  if (existing.some((v) => v.id !== exceptId && v.name.toLowerCase() === key)) {
    return 'You already have a view with that name.';
  }
  return null;
}

/** Picks a free name like "Foo (copy)", "Foo (copy 2)" for duplicating a view. */
export function copyName(base: string, existing: readonly SavedView[]): string {
  const taken = new Set(existing.map((v) => v.name.toLowerCase()));
  const trimmed = base.slice(0, MAX_VIEW_NAME_LENGTH - 12).trim();
  let candidate = `${trimmed} (copy)`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${trimmed} (copy ${n})`;
  return candidate;
}

/** JSON-safe copy of the filters (drops undefined/functions) with a size guard. */
export function sanitizeFilters(filters: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const json = JSON.stringify(filters ?? {});
  if (json.length > MAX_FILTERS_JSON_LENGTH) throw new Error('This view is too large to save.');
  const clean: unknown = JSON.parse(json);
  return isPlainObject(clean) ? clean : {};
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        if (value[key] !== undefined) acc[key] = canonical(value[key]);
        return acc;
      }, {});
  }
  return value;
}

/** Key-order-independent JSON, used to compare filter objects. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? 'null';
}

/** True when the page's current state is exactly what the view stores. */
export function viewMatchesState(view: SavedView, state: ViewState): boolean {
  if (stableStringify(view.filters) !== stableStringify(state.filters ?? {})) return false;
  if (stableStringify(view.sort ?? null) !== stableStringify(state.sort ?? null)) return false;
  const a = [...(view.columns ?? [])].sort();
  const b = [...(state.columns ?? [])].sort();
  return (view.columns === null) === (state.columns == null) && stableStringify(a) === stableStringify(b);
}

/** Default first, then my views, then teammates' shared views; A→Z inside each group. */
export function orderViews(views: readonly SavedView[], userId: string | undefined): SavedView[] {
  const rank = (v: SavedView) => (v.user_id === userId ? (v.is_default ? 0 : 1) : 2);
  return [...views].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** The viewer's own default view for the page, if any. */
export function pickDefaultView(views: readonly SavedView[], userId: string | undefined): SavedView | null {
  if (!userId) return null;
  return views.find((v) => v.user_id === userId && v.is_default) ?? null;
}

/** Defensive row -> SavedView mapping: a malformed jsonb blob can never crash a page. */
export function parseSavedViewRow(row: Record<string, unknown>): SavedView {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    owner_id: String(row.owner_id ?? row.user_id),
    page: row.page as SavedViewPage,
    name: String(row.name ?? ''),
    filters: isPlainObject(row.filters) ? row.filters : {},
    sort: normalizeSort(row.sort),
    columns: normalizeColumns(row.columns),
    is_shared: row.is_shared === true,
    is_default: row.is_default === true,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? row.created_at ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

export async function listSavedViews(page: SavedViewPage): Promise<SavedView[]> {
  const { data, error } = await supabase
    .from('saved_views')
    .select('*')
    .eq('page', page)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(parseSavedViewRow);
}

export async function createSavedView(
  page: SavedViewPage,
  name: string,
  state: ViewState,
  options: { shared?: boolean } = {},
): Promise<SavedView> {
  const { data, error } = await supabase
    .from('saved_views')
    .insert({
      page,
      name: normalizeViewName(name),
      filters: sanitizeFilters(state.filters),
      sort: state.sort ?? null,
      columns: state.columns ?? null,
      is_shared: options.shared ?? false,
    })
    .select('*')
    .single();
  if (error) throw error;
  return parseSavedViewRow(data as Record<string, unknown>);
}

export type SavedViewPatch = Partial<ViewState> & { name?: string; is_shared?: boolean };

export async function updateSavedView(id: string, patch: SavedViewPatch): Promise<SavedView> {
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = normalizeViewName(patch.name);
  if (patch.is_shared !== undefined) update.is_shared = patch.is_shared;
  if (patch.filters !== undefined) update.filters = sanitizeFilters(patch.filters);
  if (patch.sort !== undefined) update.sort = patch.sort;
  if (patch.columns !== undefined) update.columns = patch.columns;
  const { data, error } = await supabase.from('saved_views').update(update).eq('id', id).select('*').single();
  if (error) throw error;
  return parseSavedViewRow(data as Record<string, unknown>);
}

/** Atomically makes `id` the viewer's default for its page (or clears it). */
export async function setDefaultSavedView(id: string, makeDefault: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_saved_view_default', { p_id: id, p_default: makeDefault });
  if (error) throw error;
}

export async function deleteSavedView(id: string): Promise<void> {
  const { error } = await supabase.from('saved_views').delete().eq('id', id);
  if (error) throw error;
}
