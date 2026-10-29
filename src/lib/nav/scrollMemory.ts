// Pure scroll bookkeeping: what to do on navigation + a tiny LRU snapshot store.

export type NavType = 'POP' | 'PUSH' | 'REPLACE';
export type ScrollAction = 'restore' | 'anchor' | 'top' | 'keep';

export interface LocLike {
  pathname: string;
  search: string;
  hash: string;
}

/**
 * POP            -> restore the saved position (back/forward).
 * hash present   -> anchor scroll.
 * PUSH/REPLACE with a different pathname -> top (new page).
 * Same pathname (filters/tabs/search changed) -> keep: never yank the user to the top.
 */
export function decideScroll(navType: NavType, prev: LocLike | null, next: LocLike): ScrollAction {
  if (navType === 'POP') return next.hash ? 'anchor' : 'restore';
  if (next.hash) return 'anchor';
  if (!prev || prev.pathname !== next.pathname) return 'top';
  return 'keep';
}

export interface Pos {
  x: number;
  y: number;
}
export interface ScrollSnapshot {
  window: Pos;
  inner: Record<string, Pos>;
}

const isPos = (v: unknown): v is Pos =>
  typeof v === 'object' && v !== null && Number.isFinite((v as Pos).x) && Number.isFinite((v as Pos).y);

export function parseSnapshot(raw: unknown): ScrollSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { window?: unknown; inner?: unknown };
  if (!isPos(r.window)) return null;
  const inner: Record<string, Pos> = {};
  if (typeof r.inner === 'object' && r.inner !== null) {
    for (const [k, v] of Object.entries(r.inner)) if (isPos(v)) inner[k] = { x: v.x, y: v.y };
  }
  return { window: { x: r.window.x, y: r.window.y }, inner };
}

export interface ScrollStore {
  get(key: string): ScrollSnapshot | null;
  set(key: string, snap: ScrollSnapshot): void;
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

export function createScrollStore(storage: KV | null, storageKey = 'vrk:scroll', limit = 60): ScrollStore {
  let entries: [string, ScrollSnapshot][] = [];
  try {
    const raw = storage?.getItem(storageKey);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) {
      for (const e of arr) {
        if (Array.isArray(e) && typeof e[0] === 'string') {
          const snap = parseSnapshot(e[1]);
          if (snap) entries.push([e[0], snap]);
        }
      }
    }
  } catch {
    entries = [];
  }
  const persist = () => {
    try {
      storage?.setItem(storageKey, JSON.stringify(entries));
    } catch {
      /* quota / private mode: in-memory only */
    }
  };
  return {
    get: (key) => entries.find(([k]) => k === key)?.[1] ?? null,
    set(key, snap) {
      entries = entries.filter(([k]) => k !== key);
      entries.push([key, snap]);
      if (entries.length > limit) entries = entries.slice(entries.length - limit);
      persist();
    },
  };
}
