// src/lib/native/vault.ts
// Durable vault: a write-ahead copy of every un-synced field action on the device's
// private file system. Mobile operating systems may purge WebView storage (IndexedDB /
// localStorage) under storage pressure or after an app reset — the vault makes sure a
// technician's photos, signatures and notes survive that and still reach the office.
//
// Safe by design: the server applies each client_op_id at most once, and uploads use a
// deterministic path with upsert, so replaying a vault entry can never duplicate data.
// Web / PWA: every function here is a no-op.

import { idb, notifyData, notifyEnqueue, transact, type OutboxOp, type StoredBlob } from '../offline/db';
import { isNative } from './platform';

const ROOT = 'vireek-vault';

interface VaultEntry {
  op: OutboxOp;
  blob: { id: string; mime: string; ext: string } | null;
}

async function loadFs() {
  return import('@capacitor/filesystem');
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.onload = () => {
      const text = String(reader.result);
      resolve(text.slice(text.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Writes the operation (and its file) to the vault. Never throws: IndexedDB still holds the primary copy. */
export async function mirrorToVault(op: OutboxOp, stored?: StoredBlob): Promise<void> {
  if (!isNative()) return;
  try {
    const { Filesystem, Directory, Encoding } = await loadFs();
    const dir = `${ROOT}/${op.user_id}`;
    await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true }).catch(() => undefined);
    // The binary goes first; the .json is the commit marker that makes the entry visible.
    if (stored) {
      await Filesystem.writeFile({ path: `${dir}/${op.id}.bin`, directory: Directory.Data, data: await blobToBase64(stored.blob) });
    }
    const entry: VaultEntry = { op, blob: stored ? { id: stored.id, mime: stored.mime, ext: stored.ext } : null };
    await Filesystem.writeFile({
      path: `${dir}/${op.id}.json`,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      data: JSON.stringify(entry),
    });
  } catch {
    /* disk full / plugin unavailable — the IndexedDB copy is still intact */
  }
}

/** Removes a delivered or dismissed operation from the vault. */
export async function forgetFromVault(op: Pick<OutboxOp, 'id' | 'user_id' | 'blob_id'>): Promise<void> {
  if (!isNative()) return;
  try {
    const { Filesystem, Directory } = await loadFs();
    const dir = `${ROOT}/${op.user_id}`;
    await Filesystem.deleteFile({ path: `${dir}/${op.id}.json`, directory: Directory.Data }).catch(() => undefined);
    if (op.blob_id) await Filesystem.deleteFile({ path: `${dir}/${op.id}.bin`, directory: Directory.Data }).catch(() => undefined);
  } catch {
    /* nothing to clean */
  }
}

const restoredFor = new Set<string>();

/**
 * Re-creates outbox operations that exist in the vault but not in IndexedDB (storage was purged).
 * Runs once per app session per technician. Returns how many operations were restored.
 */
export async function rehydrateFromVault(userId: string): Promise<number> {
  if (!isNative() || restoredFor.has(userId)) return 0;
  restoredFor.add(userId);

  let restored = 0;
  try {
    const { Filesystem, Directory, Encoding } = await loadFs();
    const dir = `${ROOT}/${userId}`;
    const listing = await Filesystem.readdir({ path: dir, directory: Directory.Data }).catch(() => null);
    if (!listing) return 0;

    for (const file of listing.files) {
      if (!file.name.endsWith('.json')) continue;
      try {
        const raw = await Filesystem.readFile({ path: `${dir}/${file.name}`, directory: Directory.Data, encoding: Encoding.UTF8 });
        const entry = JSON.parse(String(raw.data)) as VaultEntry;
        const op = entry.op;
        if (!op?.id || op.user_id !== userId) continue;
        if (await idb.get('outbox', op.id)) continue; // IndexedDB still has it

        const revived: OutboxOp = { ...op, state: 'pending', attempts: 0, net_failures: 0, next_attempt_at: 0, uploaded: false, last_error: undefined };
        if (entry.blob) {
          const bin = await Filesystem.readFile({ path: `${dir}/${op.id}.bin`, directory: Directory.Data });
          const meta = entry.blob;
          const stored: StoredBlob = { id: meta.id, blob: base64ToBlob(String(bin.data), meta.mime), mime: meta.mime, ext: meta.ext };
          await transact(['outbox', 'blobs'], 'readwrite', (s) => {
            s('blobs').put(stored);
            return s('outbox').put(revived);
          });
        } else {
          await idb.put('outbox', revived);
        }
        restored += 1;
      } catch {
        /* one corrupt entry must never block the others */
      }
    }
  } catch {
    /* vault unreadable — nothing to restore */
  }

  if (restored > 0) {
    notifyData();
    notifyEnqueue();
  }
  return restored;
}
