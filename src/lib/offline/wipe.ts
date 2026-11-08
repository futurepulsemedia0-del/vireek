// src/lib/offline/wipe.ts
// Local-data wipe for sign-out, remote revoke and account deletion.
//   includeUnsynced:false → drops caches only (jobs, briefs, bundle markers). Un-synced field
//                           actions stay: they are the company's work product and are scoped by user_id.
//   includeUnsynced:true  → also deletes outbox, blobs, GPS pings and the native vault (explicit discard).
// Never throws; resolves to false when any step failed so the caller can tell the user.

import { idb, getMeta, setMeta, notifyData, type PingRecord } from './db';
import { listOutbox } from './outbox';
import { wipeVault } from '../native/vault';

/** Number of field actions (operations + GPS pings) that have not reached the office yet. */
export async function countUnsynced(): Promise<number> {
  try {
    const [ops, pings] = await Promise.all([listOutbox(), idb.getAll<PingRecord>('pings')]);
    return ops.length + pings.length;
  } catch {
    return 0;
  }
}

export async function wipeLocalData(options: { includeUnsynced: boolean }): Promise<boolean> {
  const steps: Array<() => Promise<unknown>> = [
    () => idb.clear('jobs'),
    () => idb.clear('briefs'),
    () => setMeta('bundle_at', undefined),
  ];
  if (options.includeUnsynced) {
    steps.push(
      () => idb.clear('outbox'),
      () => idb.clear('blobs'),
      () => idb.clear('pings'),
      () => wipeVault(),
      () => getMeta<string>('cache_user').then(() => setMeta('cache_user', undefined)),
    );
  }
  const results = await Promise.allSettled(steps.map((run) => run()));
  notifyData();
  return results.every((r) => r.status === 'fulfilled');
}
