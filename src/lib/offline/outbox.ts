// src/lib/offline/outbox.ts
// The outbox: every field action is written here first (with its file, if any) and the sync
// engine delivers it later. The UI never waits for the network.

import { transact, idb, newId, nextSeq, notifyData, notifyEnqueue, type OutboxOp, type OutboxOpType, type StoredBlob } from './db';
import { getCachedIdentity } from './identity';
import { forgetFromVault, mirrorToVault } from '../native/vault';

export interface EnqueueOptions {
  blob?: { data: Blob; bucket: string; ext: string };
}

export async function enqueue(
  type: OutboxOpType,
  jobId: string | null,
  payload: Record<string, unknown>,
  options: EnqueueOptions = {},
): Promise<OutboxOp> {
  const identity = getCachedIdentity();
  if (!identity) throw new Error('No technician is signed in on this device.');

  const stored: StoredBlob | undefined = options.blob
    ? {
        id: newId(),
        blob: options.blob.data,
        mime: options.blob.data.type || 'application/octet-stream',
        ext: options.blob.ext,
      }
    : undefined;

  const op: OutboxOp = {
    id: newId(),
    seq: nextSeq(),
    user_id: identity.userId,
    type,
    job_id: jobId,
    payload,
    client_ts: new Date().toISOString(),
    state: 'pending',
    attempts: 0,
    next_attempt_at: 0,
    ...(stored && options.blob ? { blob_id: stored.id, blob_bucket: options.blob.bucket, uploaded: false } : {}),
  };

  await transact(['outbox', 'blobs'], 'readwrite', (s) => {
    if (stored) s('blobs').put(stored);
    return s('outbox').put(op);
  });
  await mirrorToVault(op, stored); // native only; never throws
  notifyData();
  notifyEnqueue();
  return op;
}

/** All queued operations, oldest first. */
export async function listOutbox(): Promise<OutboxOp[]> {
  const ops = await idb.getAll<OutboxOp>('outbox');
  return ops.sort((a, b) => a.seq - b.seq);
}

export async function listOutboxForJob(jobId: string): Promise<OutboxOp[]> {
  return (await listOutbox()).filter((o) => o.job_id === jobId);
}

export function getBlob(id: string): Promise<StoredBlob | undefined> {
  return idb.get<StoredBlob>('blobs', id);
}

/** Discards one operation (and its file) from the device, e.g. a failed / conflicting capture. */
export async function dismissOp(id: string): Promise<void> {
  const op = await idb.get<OutboxOp>('outbox', id);
  if (!op) return;
  await transact(['outbox', 'blobs'], 'readwrite', (s) => {
    if (op.blob_id) s('blobs').delete(op.blob_id);
    return s('outbox').delete(id);
  });
  await forgetFromVault(op);
  notifyData();
}
