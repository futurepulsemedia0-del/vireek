/**
 * "Frequent pages": the few dashboard pages a person actually opens, surfaced at the top of the menu so the
 * other ~430 routes can stay one search away. Pure functions + a tiny guarded localStorage wrapper.
 *
 * Ranking is an exponentially decayed visit count (half-life 7 days) so last month's habit fades and this
 * week's habit wins. Nothing here touches routes, permissions or entitlements: callers pass the set of hrefs
 * the person can already see, and anything outside that set is never recorded or returned.
 */

export const FREQUENT_STORAGE_PREFIX = 'vireek.nav.frequent.v1';
export const FREQUENT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
export const FREQUENT_MAX_ENTRIES = 60;
export const FREQUENT_MIN_SCORE = 2;
export const FREQUENT_LIMIT = 5;
/** Re-opening the same page within this window counts once (refreshes and quick back/forward are not habit). */
export const FREQUENT_DEBOUNCE_MS = 30 * 1000;

export interface FrequentEntry {
  score: number;
  last: number;
}
export type FrequentStore = Record<string, FrequentEntry>;

/** Same normalisation idea as surface.normalizePath, kept local so this module has no imports. */
export function normalizeHref(href: string): string {
  let p = href.split(/[?#]/)[0] ?? '';
  p = p.toLowerCase();
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function decayed(entry: FrequentEntry, now: number): number {
  const age = Math.max(0, now - entry.last);
  return entry.score * Math.pow(0.5, age / FREQUENT_HALF_LIFE_MS);
}

/** Returns a NEW store; never mutates the input. Unknown hrefs and the Overview page are ignored. */
export function recordVisit(store: FrequentStore, href: string, allowed: ReadonlySet<string>, now: number): FrequentStore {
  const key = normalizeHref(href);
  if (key === '/dashboard' || !allowed.has(key)) return store;
  const prev = store[key];
  if (prev && now - prev.last < FREQUENT_DEBOUNCE_MS && now >= prev.last) return store;
  const next: FrequentStore = { ...store, [key]: { score: (prev ? decayed(prev, now) : 0) + 1, last: now } };
  const keys = Object.keys(next);
  if (keys.length <= FREQUENT_MAX_ENTRIES) return next;
  keys.sort((a, b) => decayed(next[a], now) - decayed(next[b], now));
  for (const k of keys.slice(0, keys.length - FREQUENT_MAX_ENTRIES)) delete next[k];
  return next;
}

/** Highest decayed score first; ties break by most recent. Only pages seen at least ~twice qualify. */
export function topFrequent(
  store: FrequentStore,
  allowed: ReadonlySet<string>,
  now: number,
  limit: number = FREQUENT_LIMIT,
): string[] {
  return Object.entries(store)
    .filter(([href]) => allowed.has(href))
    .map(([href, e]) => ({ href, s: decayed(e, now), last: e.last }))
    .filter((r) => r.s >= FREQUENT_MIN_SCORE)
    .sort((a, b) => b.s - a.s || b.last - a.last)
    .slice(0, Math.max(0, limit))
    .map((r) => r.href);
}

/** Defensive parse: anything malformed (tampered storage, old schema) yields an empty store, never a throw. */
export function parseStore(raw: string | null): FrequentStore {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: FrequentStore = {};
    for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
      const o = e as Partial<FrequentEntry> | null;
      if (
        typeof k === 'string' && k.startsWith('/dashboard') &&
        o && typeof o.score === 'number' && Number.isFinite(o.score) && o.score > 0 && o.score < 1e6 &&
        typeof o.last === 'number' && Number.isFinite(o.last) && o.last > 0
      ) {
        out[k] = { score: o.score, last: o.last };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export const frequentKey = (userId: string | null | undefined): string => `${FREQUENT_STORAGE_PREFIX}:${userId || 'anon'}`;

export function loadStore(userId: string | null | undefined): FrequentStore {
  try {
    return parseStore(window.localStorage.getItem(frequentKey(userId)));
  } catch {
    return {};
  }
}

export function saveStore(userId: string | null | undefined, store: FrequentStore): void {
  try {
    window.localStorage.setItem(frequentKey(userId), JSON.stringify(store));
  } catch {
    /* private mode / quota: the menu simply has no shortcuts */
  }
}
