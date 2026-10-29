// Pure model for per-table UI state + local fallback. No supabase import.

export const DENSITIES = ['compact', 'comfortable', 'spacious'] as const;
export type Density = (typeof DENSITIES)[number];
export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const TABLE_PREFS_VERSION = 1;

export interface TablePrefs {
  filters: Record<string, string | number | boolean | string[]>;
  sort: { key: string; dir: 'asc' | 'desc' } | null;
  hiddenColumns: string[];
  columnOrder: string[];
  columnWidths: Record<string, number>;
  density: Density;
  pageSize: number;
}

export const DEFAULT_TABLE_PREFS: TablePrefs = {
  filters: {},
  sort: null,
  hiddenColumns: [],
  columnOrder: [],
  columnWidths: {},
  density: 'comfortable',
  pageSize: 25,
};

export const isValidTableKey = (k: string): boolean => /^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(k);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strList = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? Array.from(new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64))).slice(0, max) : [];

/** Defensive: server rows / localStorage / older versions are never trusted. */
export function normalizeTablePrefs(raw: unknown): TablePrefs {
  if (!isObj(raw)) return { ...DEFAULT_TABLE_PREFS };
  const filters: TablePrefs['filters'] = {};
  if (isObj(raw.filters)) {
    for (const [k, v] of Object.entries(raw.filters).slice(0, 50)) {
      if (k.length > 64) continue;
      if (typeof v === 'string' && v.length <= 200) filters[k] = v;
      else if (typeof v === 'number' && Number.isFinite(v)) filters[k] = v;
      else if (typeof v === 'boolean') filters[k] = v;
      else if (Array.isArray(v)) filters[k] = strList(v, 25);
    }
  }
  const sortRaw = raw.sort;
  let sort: TablePrefs['sort'] = null;
  if (isObj(sortRaw) && typeof sortRaw.key === 'string' && sortRaw.key) {
    const dir = sortRaw.dir === 'asc' ? 'asc' : sortRaw.dir === 'desc' ? 'desc' : null;
    if (dir) sort = { key: sortRaw.key.slice(0, 64), dir };
  }
  const widths: Record<string, number> = {};
  if (isObj(raw.columnWidths)) {
    for (const [k, v] of Object.entries(raw.columnWidths).slice(0, 100)) {
      if (typeof v === 'number' && Number.isFinite(v)) widths[k] = Math.min(800, Math.max(48, Math.round(v)));
    }
  }
  return {
    filters,
    sort,
    hiddenColumns: strList(raw.hiddenColumns, 100),
    columnOrder: strList(raw.columnOrder, 100),
    columnWidths: widths,
    density: DENSITIES.find((d) => d === raw.density) ?? DEFAULT_TABLE_PREFS.density,
    pageSize: PAGE_SIZES.find((n) => n === raw.pageSize) ?? DEFAULT_TABLE_PREFS.pageSize,
  };
}

export interface Stamped {
  prefs: TablePrefs;
  updatedAt: number; // epoch ms
}

/** Newest write wins; ties prefer remote. */
export function pickNewer(local: Stamped | null, remote: Stamped | null): Stamped | null {
  if (!local) return remote;
  if (!remote) return local;
  return local.updatedAt > remote.updatedAt ? local : remote;
}

const localKey = (userId: string, tableKey: string) => `vrk:tp:${userId}:${tableKey}`;

export function readLocal(userId: string, tableKey: string, kv: Pick<Storage, 'getItem'> | null): Stamped | null {
  try {
    const raw = kv?.getItem(localKey(userId, tableKey));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isObj(parsed) || typeof parsed.updatedAt !== 'number') return null;
    return { prefs: normalizeTablePrefs(parsed.prefs), updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

export function writeLocal(userId: string, tableKey: string, value: Stamped, kv: Pick<Storage, 'setItem'> | null): void {
  try {
    kv?.setItem(localKey(userId, tableKey), JSON.stringify(value));
  } catch {
    /* quota/private mode — server copy still applies */
  }
}
