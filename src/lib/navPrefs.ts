/**
 * Menu shortcuts ("pins"): the pages a person chooses to keep at the top of the sidebar, in their own order.
 *
 * Design rules (see docs/design/dashboard-principles.md):
 * - Pins ONLY add a shortcut. Nothing here hides, removes or renames any menu entry, route or permission:
 *   every page stays reachable from its pillar, from search (Ctrl K) and from the Navigation Center.
 * - Pure functions + a tiny guarded storage wrapper (same approach as navFrequent.ts). Storage can be blocked
 *   (private mode, policies): the choice then lives in memory for this visit and nothing throws.
 * - A stored pin is never trusted: it is shown only when the page is in the set the person can already open
 *   (permissions, entitlements, flags and audience already applied by the caller).
 */
import { normalizeHref } from './navFrequent';

export const NAV_PREFS_STORAGE_PREFIX = 'vireek.nav.prefs.v1';
/** Same-tab change notification: the sidebar and the Navigation Center are separate component trees. */
export const NAV_PREFS_EVENT = 'vireek:nav-prefs';
export const MAX_PINNED = 12;
const MAX_RAW_LENGTH = 8_000;

export interface NavPrefs {
  v: 1;
  /** Normalised hrefs, in display order. No duplicates, never longer than MAX_PINNED. */
  pinned: string[];
}

export const EMPTY_NAV_PREFS: NavPrefs = Object.freeze({ v: 1, pinned: [] }) as NavPrefs;

export type PinResult =
  | { ok: true; prefs: NavPrefs; pinned: boolean }
  | { ok: false; prefs: NavPrefs; reason: 'limit' | 'not_allowed' | 'invalid' };

export function navPrefsKey(userId: string | null | undefined): string {
  return `${NAV_PREFS_STORAGE_PREFIX}:${userId || 'anon'}`;
}

/** An in-app path (the menu also links /tech/*, /safety/* and /valuation). Never a URL, protocol-relative link or the Overview root. */
function isDashboardPath(key: string): boolean {
  return key.length > 1 && key.length <= 200 && key.startsWith('/') && key !== '/dashboard' && !key.includes('//') && !/[\s<>"'\\:]/.test(key);
}

/** Never throws. Anything malformed, oversized or from another schema version becomes an empty preference set. */
export function parseNavPrefs(raw: string | null | undefined): NavPrefs {
  if (!raw || raw.length > MAX_RAW_LENGTH) return EMPTY_NAV_PREFS;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return EMPTY_NAV_PREFS;
  }
  if (!data || typeof data !== 'object') return EMPTY_NAV_PREFS;
  const { v, pinned } = data as { v?: unknown; pinned?: unknown };
  if (v !== 1 || !Array.isArray(pinned)) return EMPTY_NAV_PREFS;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of pinned) {
    if (typeof item !== 'string') continue;
    const key = normalizeHref(item);
    if (!isDashboardPath(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= MAX_PINNED) break;
  }
  return { v: 1, pinned: out };
}

export function isPinned(prefs: NavPrefs, href: string): boolean {
  return prefs.pinned.includes(normalizeHref(href));
}

/** Pins that may be shown right now, in the person's order. Stored pins for pages they cannot open are kept, not shown. */
export function visiblePinned(prefs: NavPrefs, allowed: ReadonlySet<string>): string[] {
  return prefs.pinned.filter((h) => allowed.has(h));
}

/** Pin when absent, unpin when present. Refuses pages the person cannot open and a 13th pin. Never mutates `prefs`. */
export function togglePin(prefs: NavPrefs, href: string, allowed: ReadonlySet<string>): PinResult {
  const key = normalizeHref(href);
  if (!isDashboardPath(key)) return { ok: false, prefs, reason: 'invalid' };
  if (prefs.pinned.includes(key)) {
    return { ok: true, prefs: { v: 1, pinned: prefs.pinned.filter((h) => h !== key) }, pinned: false };
  }
  if (!allowed.has(key)) return { ok: false, prefs, reason: 'not_allowed' };
  if (prefs.pinned.length >= MAX_PINNED) return { ok: false, prefs, reason: 'limit' };
  return { ok: true, prefs: { v: 1, pinned: [...prefs.pinned, key] }, pinned: true };
}

/** Moves a pin one step. Returns the SAME object when nothing can move so callers can skip a save. */
export function movePin(prefs: NavPrefs, href: string, delta: -1 | 1): NavPrefs {
  const key = normalizeHref(href);
  const from = prefs.pinned.indexOf(key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= prefs.pinned.length) return prefs;
  const next = [...prefs.pinned];
  [next[from], next[to]] = [next[to], next[from]];
  return { v: 1, pinned: next };
}

export function clearPins(prefs: NavPrefs): NavPrefs {
  return prefs.pinned.length === 0 ? prefs : EMPTY_NAV_PREFS;
}

// ── guarded storage ─────────────────────────────────────────────────────────────────────────────────────────────
const memory = new Map<string, NavPrefs>();

export function loadNavPrefs(userId: string | null | undefined): NavPrefs {
  const key = navPrefsKey(userId);
  try {
    const raw = localStorage.getItem(key);
    const parsed = parseNavPrefs(raw);
    memory.set(key, parsed);
    return parsed;
  } catch {
    return memory.get(key) ?? EMPTY_NAV_PREFS;
  }
}

export function saveNavPrefs(userId: string | null | undefined, prefs: NavPrefs): void {
  const key = navPrefsKey(userId);
  memory.set(key, prefs);
  try {
    localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    /* storage blocked or full: the memory copy keeps the choice for this visit */
  }
}

/** Test helper: forget the in-memory fallback. */
export function resetNavPrefsMemory(): void {
  memory.clear();
}
