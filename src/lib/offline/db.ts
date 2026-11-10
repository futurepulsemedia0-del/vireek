// src/lib/offline/db.ts
// IndexedDB layer for the field app: typed stores, a tiny promise wrapper, change events and
// id / sequence helpers. Everything here is local-first and never talks to the network.

export type OutboxOpType = 'status' | 'safety_flag' | 'note' | 'artifact' | 'location';
export type OutboxState = 'pending' | 'failed' | 'conflict';

export interface OutboxOp {
  id: string;
  seq: number;
  user_id: string;
  type: OutboxOpType;
  job_id: string | null;
  payload: Record<string, unknown>;
  client_ts: string;
  state: OutboxState;
  attempts: number;
  next_attempt_at: number;
  net_failures?: number;
  last_error?: string;
  detail?: unknown;
  blob_id?: string;
  blob_bucket?: string;
  uploaded?: boolean;
}

export interface StoredBlob {
  id: string;
  blob: Blob;
  mime: string;
  ext: string;
}

export interface PingRecord {
  recorded_at: number;
  user_id: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  speed: number | null;
  job_id: string | null;
}

export type StoreName = 'jobs' | 'briefs' | 'outbox' | 'blobs' | 'pings' | 'meta';

const DB_NAME = 'vireek-field';
const DB_VERSION = 1;

const STORE_KEYS: Record<StoreName, string> = {
  jobs: 'id',
  briefs: 'job_id',
  outbox: 'id',
  blobs: 'id',
  pings: 'recorded_at',
  meta: 'key',
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      (Object.keys(STORE_KEYS) as StoreName[]).forEach((name) => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: STORE_KEYS[name] });
      });
    };
    req.onsuccess = () => {
      const db = req.result;
      const reset = () => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        reset();
      };
      db.onclose = reset;
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  dbPromise = p;
  return p;
}

/**
 * Runs `work` inside one transaction. Resolves when the transaction has committed
 * (with the result of the request `work` returned, if any); rejects on any failure.
 */
export async function transact<T = unknown>(
  stores: string[],
  mode: IDBTransactionMode,
  work: (store: (name: string) => IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode);
    } catch (e) {
      reject(e);
      return;
    }
    let request: IDBRequest<T> | void;
    try {
      request = work((name) => tx.objectStore(name));
    } catch (e) {
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
      reject(e);
      return;
    }
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export const idb = {
  get<T = unknown>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return transact<T>([store], 'readonly', (s) => s(store).get(key) as IDBRequest<T>);
  },
  async getAll<T = unknown>(store: StoreName): Promise<T[]> {
    return ((await transact<T[]>([store], 'readonly', (s) => s(store).getAll() as IDBRequest<T[]>)) ?? []) as T[];
  },
  async put(store: StoreName, value: unknown): Promise<void> {
    await transact([store], 'readwrite', (s) => s(store).put(value));
  },
  async delete(store: StoreName, key: IDBValidKey): Promise<void> {
    await transact([store], 'readwrite', (s) => s(store).delete(key));
  },
  async clear(store: StoreName): Promise<void> {
    await transact([store], 'readwrite', (s) => s(store).clear());
  },
};

// ------------------------------------------------------------
// Key-value meta (setMeta with undefined removes the key)
// ------------------------------------------------------------

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = await idb.get<{ key: string; value: T }>('meta', key);
  return row?.value;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  if (value === undefined) await idb.delete('meta', key);
  else await idb.put('meta', { key, value });
}

// ------------------------------------------------------------
// Change events
// ------------------------------------------------------------

const dataListeners = new Set<() => void>();
const enqueueListeners = new Set<() => void>();

function fire(listeners: Set<() => void>): void {
  [...listeners].forEach((l) => {
    try {
      l();
    } catch {
      /* a broken listener must not block the others */
    }
  });
}

/** Anything the UI shows from the device (jobs, outbox, settings) changed. */
export const notifyData = (): void => fire(dataListeners);
export const subscribeData = (cb: () => void): (() => void) => {
  dataListeners.add(cb);
  return () => {
    dataListeners.delete(cb);
  };
};

/** A new operation was queued: the sync engine should try to push it. */
export const notifyEnqueue = (): void => fire(enqueueListeners);
export const onEnqueue = (cb: () => void): (() => void) => {
  enqueueListeners.add(cb);
  return () => {
    enqueueListeners.delete(cb);
  };
};

// ------------------------------------------------------------
// Ids + ordering
// ------------------------------------------------------------

export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

let lastSeq = 0;

/** Strictly increasing, time-based (so it keeps growing across reloads and tabs). */
export function nextSeq(): number {
  lastSeq = Math.max(lastSeq + 1, Date.now() * 1000);
  return lastSeq;
}
