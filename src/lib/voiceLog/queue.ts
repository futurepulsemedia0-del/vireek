// On-device storage (own IndexedDB): dictations waiting to be processed, approvals waiting to
// be synced, and a cache of ready drafts so review/approve works offline.
import type { PendingApproval } from './approvalFlow';
import type { VoiceDraft } from './types';
export { backoffMs } from './backoff';

export type RecState = 'waiting' | 'uploading' | 'processing' | 'failed';
export interface QueuedRecording {
  id: string;            // also the draft id and part of the storage path (idempotency key)
  jobId: string;
  ext: string;
  language: 'auto' | 'en' | 'es' | 'fa';
  blob: Blob;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  state: RecState;
  lastError: string | null;
}

const DB_NAME = 'vireek-voice-log';
type StoreName = 'rec' | 'approvals' | 'drafts';
const KEYS: Record<StoreName, string> = { rec: 'id', approvals: 'draftId', drafts: 'id' };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      (Object.keys(KEYS) as StoreName[]).forEach((n) => {
        if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, { keyPath: KEYS[n] }).createIndex('jobId', 'jobId');
      });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

// --- recordings
export const putRecording = (r: QueuedRecording) => run('rec', 'readwrite', (s) => s.put(r)).then(() => undefined);
export const removeRecording = (id: string) => run('rec', 'readwrite', (s) => s.delete(id)).then(() => undefined);
export const getRecording = (id: string) => run<QueuedRecording | undefined>('rec', 'readonly', (s) => s.get(id));
export const listRecordings = (jobId: string) =>
  run<QueuedRecording[]>('rec', 'readonly', (s) => s.index('jobId').getAll(jobId)).then((a) => a.sort((x, y) => x.createdAt - y.createdAt));

// --- approvals (write-ahead; survive reloads and offline periods)
export const putApproval = (a: PendingApproval) => run('approvals', 'readwrite', (s) => s.put(a)).then(() => undefined);
export const removeApproval = (draftId: string) => run('approvals', 'readwrite', (s) => s.delete(draftId)).then(() => undefined);
export const getApproval = (draftId: string) => run<PendingApproval | undefined>('approvals', 'readonly', (s) => s.get(draftId));
export const listApprovals = (jobId: string) =>
  run<PendingApproval[]>('approvals', 'readonly', (s) => s.index('jobId').getAll(jobId)).then((a) => a.sort((x, y) => x.createdAt - y.createdAt));

// --- cached ready drafts (so the technician can review/approve with no signal)
type CachedDraft = VoiceDraft & { jobId: string };
export async function cacheDrafts(jobId: string, drafts: VoiceDraft[]): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      const st = tx.objectStore('drafts');
      const idx = st.index('jobId').getAllKeys(jobId);
      idx.onsuccess = () => {
        (idx.result as IDBValidKey[]).forEach((k) => st.delete(k));
        drafts.forEach((d) => st.put({ ...d, jobId } satisfies CachedDraft));
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('cache failed'));
      tx.onabort = () => reject(tx.error ?? new Error('cache aborted'));
    });
  } finally { db.close(); }
}
export const getCachedDrafts = (jobId: string) =>
  run<CachedDraft[]>('drafts', 'readonly', (s) => s.index('jobId').getAll(jobId)).then((a) => a.sort((x, y) => y.created_at.localeCompare(x.created_at)));
export const removeCachedDraft = (id: string) => run('drafts', 'readwrite', (s) => s.delete(id)).then(() => undefined);
