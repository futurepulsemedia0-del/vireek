// Versioned, per-user draft storage (IndexedDB with localStorage fallback).
//
// Privacy: drafts are written to the user's own browser only. Anything that
// looks like a credential, payment or government-ID field is stripped before
// it is written (see SENSITIVE_KEY); forms can exclude more via `exclude`.

export interface DraftKey {
  userId: string;
  formId: string;
}

export interface DraftRecord {
  id: string;
  v: number;
  savedAt: number;
  data: unknown;
}

export interface DraftBackend {
  get(id: string): Promise<DraftRecord | null>;
  put(rec: DraftRecord): Promise<void>;
  remove(id: string): Promise<void>;
  listAll(): Promise<DraftRecord[]>;
}

/** Key names that must never reach disk, at any depth. */
export const SENSITIVE_KEY =
  /pass(word|code|phrase)?|pwd|secret|token|otp|one.?time|cvv|cvc|card.?(number|no)|iban|routing|account.?(number|no)|ssn|social.?security|tax.?id|passport|date.?of.?birth|dob|birth/i;

export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function pathMatches(path: string, exclude: readonly string[]): boolean {
  return exclude.some((e) => path === e || path.startsWith(`${e}.`));
}

function strip(value: unknown, path: string, exclude: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((v, i) => strip(v, `${path}.${i}`, exclude));
  if (value && typeof value === 'object') {
    if (typeof File !== 'undefined' && value instanceof File) return undefined;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (SENSITIVE_KEY.test(k) || pathMatches(p, exclude)) continue;
      out[k] = strip(v, p, exclude);
    }
    return out;
  }
  return value;
}

/** Deep-clones `data` as JSON with sensitive and excluded fields removed. Returns null if not serializable. */
export function sanitizeForDraft(data: unknown, exclude: readonly string[] = []): unknown {
  try {
    return JSON.parse(JSON.stringify(strip(data, '', exclude)) ?? 'null');
  } catch {
    return null;
  }
}

/* ---------------------------- backends ---------------------------- */

export function memoryBackend(): DraftBackend {
  const map = new Map<string, DraftRecord>();
  return {
    get: async (id) => map.get(id) ?? null,
    put: async (rec) => void map.set(rec.id, rec),
    remove: async (id) => void map.delete(id),
    listAll: async () => [...map.values()],
  };
}

const LS_PREFIX = 'vireek:draft:';

export function localStorageBackend(storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): DraftBackend {
  const need = (): Storage => {
    if (!storage) throw new Error('localStorage unavailable');
    return storage;
  };
  return {
    get: async (id) => {
      const raw = need().getItem(LS_PREFIX + id);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as DraftRecord;
      } catch {
        return null;
      }
    },
    put: async (rec) => need().setItem(LS_PREFIX + rec.id, JSON.stringify(rec)),
    remove: async (id) => need().removeItem(LS_PREFIX + id),
    listAll: async () => {
      const s = need();
      const out: DraftRecord[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (!k?.startsWith(LS_PREFIX)) continue;
        try {
          out.push(JSON.parse(s.getItem(k) ?? 'null') as DraftRecord);
        } catch {
          /* ignore corrupt entry */
        }
      }
      return out.filter((r) => r && typeof r.id === 'string');
    },
  };
}

export function indexedDbBackend(dbName = 'vireek-forms', factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB): DraftBackend {
  let opened: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (!factory) return Promise.reject(new Error('indexedDB unavailable'));
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('drafts', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
      req.onblocked = () => reject(new Error('indexedDB blocked'));
    });
    return opened;
  };
  const tx = async <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const req = run(db.transaction('drafts', mode).objectStore('drafts'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
    });
  };
  return {
    get: async (id) => ((await tx<DraftRecord | undefined>('readonly', (s) => s.get(id))) ?? null),
    put: async (rec) => void (await tx('readwrite', (s) => s.put(rec))),
    remove: async (id) => void (await tx('readwrite', (s) => s.delete(id))),
    listAll: async () => (await tx<DraftRecord[]>('readonly', (s) => s.getAll())) ?? [],
  };
}

/** IndexedDB first; on any failure (private mode, quota, blocked) silently uses localStorage. */
export function defaultBackend(): DraftBackend {
  const ls = localStorageBackend();
  let idb: DraftBackend | null = typeof indexedDB === 'undefined' ? null : indexedDbBackend();
  const run = async <T>(op: (b: DraftBackend) => Promise<T>): Promise<T> => {
    if (idb) {
      try {
        return await op(idb);
      } catch {
        idb = null;
      }
    }
    return op(ls);
  };
  return {
    get: (id) => run((b) => b.get(id)),
    put: (rec) => run((b) => b.put(rec)),
    remove: (id) => run((b) => b.remove(id)),
    listAll: () => run((b) => b.listAll()),
  };
}

/* ------------------------------ store ------------------------------ */

export interface LoadedDraft<T> {
  data: T;
  savedAt: number;
}

export interface DraftStore {
  save(key: DraftKey, version: number, data: unknown, exclude?: readonly string[]): Promise<void>;
  load<T>(key: DraftKey, version: number): Promise<LoadedDraft<T> | null>;
  clear(key: DraftKey): Promise<void>;
  /** Removes expired drafts, and every draft of `userId` when `allForUser` is true (call on sign-out). */
  purge(opts?: { userId?: string; allForUser?: boolean }): Promise<void>;
}

const idOf = (k: DraftKey) => `${k.userId}::${k.formId}`;

export function createDraftStore(
  backend: DraftBackend,
  opts: { now?: () => number; ttlMs?: number } = {},
): DraftStore {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? DRAFT_TTL_MS;
  return {
    async save(key, version, data, exclude = []) {
      const clean = sanitizeForDraft(data, exclude);
      if (!clean || typeof clean !== 'object' || Object.keys(clean).length === 0) return;
      await backend.put({ id: idOf(key), v: version, savedAt: now(), data: clean });
    },
    async load<T>(key: DraftKey, version: number) {
      const rec = await backend.get(idOf(key));
      if (!rec) return null;
      if (rec.v !== version || now() - rec.savedAt > ttl) {
        await backend.remove(rec.id);
        return null;
      }
      return { data: rec.data as T, savedAt: rec.savedAt };
    },
    clear: (key) => backend.remove(idOf(key)),
    async purge(o = {}) {
      for (const rec of await backend.listAll()) {
        const mine = o.allForUser && o.userId !== undefined && rec.id.startsWith(`${o.userId}::`);
        if (mine || now() - rec.savedAt > ttl) await backend.remove(rec.id);
      }
    },
  };
}
