// src/lib/offline/sync.ts
// The sync engine. Local-first: the UI never waits for the network.
//   push  → pending outbox ops (files first, then one idempotent batch RPC)
//   pull  → fresh offline bundle (jobs + briefs) for the next 2 days
// Triggers: app start, back online, tab visible, new local action, 45s timer,
// service-worker Background Sync (Chromium), manual "Sync now".

import { supabase } from '@/lib/supabase';
import {
  idb, transact, getMeta, setMeta, notifyData, subscribeData, onEnqueue, newId, nextSeq,
  type OutboxOp, type PingRecord,
} from './db';
import { getCachedIdentity } from './identity';
import { getBlob, listOutbox } from './outbox';
import { refreshFormTemplates } from './forms';
import { forgetFromVault, rehydrateFromVault } from '../native/vault';
import { replaceBundle, type Bundle } from './store';

// ------------------------------------------------------------
// Observable sync state
// ------------------------------------------------------------

export interface SyncState {
  online: boolean;
  syncing: boolean;
  pending: number;
  failed: number;
  conflicts: number;
  lastSyncAt: number | null;
  bundleAt: number | null;
  lastError: string | null;
  needsSignIn: boolean;
}

let state: SyncState = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  syncing: false,
  pending: 0,
  failed: 0,
  conflicts: 0,
  lastSyncAt: null,
  bundleAt: null,
  lastError: null,
  needsSignIn: false,
};
const stateListeners = new Set<() => void>();

export const subscribeSync = (cb: () => void): (() => void) => {
  stateListeners.add(cb);
  return () => stateListeners.delete(cb);
};
export const getSyncState = (): SyncState => state;

function patch(next: Partial<SyncState>): void {
  const merged = { ...state, ...next };
  const changed = (Object.keys(merged) as (keyof SyncState)[]).some((k) => merged[k] !== state[k]);
  if (!changed) return;
  state = merged;
  stateListeners.forEach((l) => l());
}

async function refreshCounts(): Promise<void> {
  try {
    const ops = await listOutbox();
    patch({
      pending: ops.filter((o) => o.state === 'pending').length,
      failed: ops.filter((o) => o.state === 'failed').length,
      conflicts: ops.filter((o) => o.state === 'conflict').length,
    });
  } catch {
    /* IndexedDB unavailable — state stays as-is */
  }
}

// ------------------------------------------------------------
// Retry policy
// ------------------------------------------------------------

export const MAX_ATTEMPTS = 8;

/** Exponential backoff: 5s, 10s, 20s … capped at 15 min, with ±25% jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(5000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000);
  return Math.round(base * (0.75 + random() * 0.5));
}

export function isNetworkError(message: string): boolean {
  return /failed to fetch|networkerror|network request|load failed|timed? ?out|offline|fetch/i.test(message);
}

async function scheduleRetry(op: OutboxOp, message: string): Promise<void> {
  if (isNetworkError(message)) {
    // Dead zone / flaky signal: wait and retry, but NEVER give up on field data because of it.
    const failures = (op.net_failures ?? 0) + 1;
    await idb.put('outbox', {
      ...op,
      net_failures: failures,
      next_attempt_at: Date.now() + Math.min(backoffMs(failures), 5 * 60_000),
      last_error: message,
    });
    return;
  }
  const attempts = op.attempts + 1;
  const next: OutboxOp =
    attempts >= MAX_ATTEMPTS
      ? { ...op, attempts, state: 'failed', last_error: message }
      : { ...op, attempts, next_attempt_at: Date.now() + backoffMs(attempts), last_error: message };
  await idb.put('outbox', next);
}

// ------------------------------------------------------------
// Push
// ------------------------------------------------------------

interface BatchResult {
  client_op_id: string | null;
  outcome: 'applied' | 'duplicate' | 'conflict' | 'rejected' | 'error';
  detail?: unknown;
}

async function drainPings(userId: string): Promise<void> {
  const pings = (await idb.getAll<PingRecord>('pings'))
    .filter((p) => p.user_id === userId)
    .sort((a, b) => a.recorded_at - b.recorded_at);

  for (let i = 0; i < pings.length; i += 100) {
    const chunk = pings.slice(i, i + 100);
    const op: OutboxOp = {
      id: newId(),
      seq: nextSeq(),
      user_id: userId,
      type: 'location',
      job_id: null,
      payload: {
        points: chunk.map((p) => ({
          lat: p.lat, lng: p.lng, accuracy: p.accuracy, speed: p.speed,
          recorded_at: p.recorded_at, job_id: p.job_id,
        })),
      },
      client_ts: new Date(chunk[chunk.length - 1].recorded_at).toISOString(),
      state: 'pending',
      attempts: 0,
      next_attempt_at: 0,
    };
    await transact(['outbox', 'pings'], 'readwrite', (s) => {
      s('outbox').put(op);
      chunk.forEach((p) => s('pings').delete(p.recorded_at));
    });
  }
}

async function uploadBlob(op: OutboxOp, userId: string): Promise<boolean> {
  const stored = op.blob_id ? await getBlob(op.blob_id) : undefined;
  if (!stored || !op.blob_bucket) {
    await idb.put('outbox', { ...op, state: 'failed', last_error: 'The file is no longer on this device.' });
    return false;
  }
  const path = `${userId}/${op.job_id ?? 'misc'}/${op.id}.${stored.ext}`;
  const { error } = await supabase.storage
    .from(op.blob_bucket)
    .upload(path, stored.blob, { contentType: stored.mime.split(';')[0], upsert: true });
  if (error) {
    await scheduleRetry(op, error.message);
    return false;
  }
  op.payload = { ...op.payload, storage_path: path, bucket: op.blob_bucket };
  op.uploaded = true;
  await idb.put('outbox', op);
  return true;
}

async function finishOp(op: OutboxOp): Promise<void> {
  await transact(['outbox', 'blobs'], 'readwrite', (s) => {
    if (op.blob_id) s('blobs').delete(op.blob_id);
    return s('outbox').delete(op.id);
  });
  await forgetFromVault(op);
}

/** Conflicts where the office is simply ahead of the device: nothing for the technician to decide. */
export function isBenignConflict(type: string, reason: string | undefined): boolean {
  return (type === 'status' && reason === 'server_ahead') || (type === 'safety_flag' && reason === 'newer_flag_on_server');
}

async function sendChunk(chunk: OutboxOp[]): Promise<boolean> {
  const wire = chunk.map((o) => ({
    client_op_id: o.id, type: o.type, job_id: o.job_id, client_ts: o.client_ts, payload: o.payload,
  }));
  const { data, error } = await supabase.rpc('sync_technician_batch', { p_ops: wire });

  if (error || !data || (data as { error?: string }).error) {
    const message = error?.message ?? (data as { error?: string } | null)?.error ?? 'sync_failed';
    for (const op of chunk) await scheduleRetry(op, message);
    return false;
  }

  const results = new Map<string, BatchResult>();
  for (const r of (data as { results: BatchResult[] }).results) {
    if (r.client_op_id) results.set(r.client_op_id, r);
  }

  for (const op of chunk) {
    const r = results.get(op.id);
    if (!r || r.outcome === 'error') {
      await scheduleRetry(op, (r?.detail as { message?: string } | undefined)?.message ?? 'no_result');
    } else if (r.outcome === 'applied' || r.outcome === 'duplicate') {
      await finishOp(op);
    } else if (r.outcome === 'conflict') {
      const reason = (r.detail as { reason?: string } | undefined)?.reason;
      if (isBenignConflict(op.type, reason)) await finishOp(op);
      else await idb.put('outbox', { ...op, state: 'conflict', detail: r.detail });
    } else {
      await idb.put('outbox', { ...op, state: 'failed', detail: r.detail, last_error: 'rejected' });
    }
  }
  return true;
}

/** Returns true when at least one operation was delivered. */
async function pushOutbox(userId: string): Promise<boolean> {
  await drainPings(userId);
  const now = Date.now();
  const candidates = (await listOutbox()).filter(
    (o) => o.user_id === userId && o.state === 'pending' && o.next_attempt_at <= now,
  );

  const ready: OutboxOp[] = [];
  for (const op of candidates) {
    if (op.blob_id && !op.uploaded && !(await uploadBlob(op, userId))) continue;
    ready.push(op);
  }

  let delivered = false;
  for (let i = 0; i < ready.length; i += 50) {
    if (await sendChunk(ready.slice(i, i + 50))) delivered = true;
    else break; // network / auth trouble: stop and let backoff handle the rest
  }
  return delivered;
}

// ------------------------------------------------------------
// Pull
// ------------------------------------------------------------

const BUNDLE_TTL_MS = 3 * 60_000;

async function pullBundle(): Promise<void> {
  const { data, error } = await supabase.rpc('get_technician_offline_bundle', { p_days: 2 });
  if (error) throw error;
  const bundle = data as Bundle | null;
  if (!bundle) throw new Error('empty_bundle');
  // Owners / admins open the technician screens too: they simply have no jobs of their own.
  await replaceBundle(bundle.error === 'not_a_technician' ? { jobs: [] } : bundle);
  await refreshFormTemplates().catch(() => undefined); // optional: keeps working if the forms migration is not applied yet
}

// ------------------------------------------------------------
// Orchestration
// ------------------------------------------------------------

let running = false;
let retryTimer: number | null = null;

async function ensureUserScope(userId: string): Promise<void> {
  const owner = await getMeta<string>('cache_user');
  if (owner && owner !== userId) {
    // A different technician signed in on this shared device: never show them the previous user's jobs.
    await Promise.all([idb.clear('jobs'), idb.clear('briefs')]);
    await setMeta('bundle_at', undefined);
  }
  if (owner !== userId) await setMeta('cache_user', userId);
}

async function runSync(forcePull: boolean): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id;
  if (!userId) {
    patch({ needsSignIn: true });
    return;
  }
  patch({ needsSignIn: false });

  const identity = getCachedIdentity();
  if (!identity || identity.userId !== userId) return; // not a technician on this device

  try {
    await ensureUserScope(userId);
    await rehydrateFromVault(userId);
    const delivered = await pushOutbox(userId);
    const bundleAt = (await getMeta<number>('bundle_at')) ?? null;
    if (forcePull || delivered || !bundleAt || Date.now() - bundleAt > BUNDLE_TTL_MS) await pullBundle();
    patch({
      lastSyncAt: Date.now(),
      lastError: null,
      bundleAt: (await getMeta<number>('bundle_at')) ?? null,
    });
    if (delivered) notifyData();
  } catch (e) {
    patch({ lastError: navigator.onLine ? (e instanceof Error ? e.message : 'Sync failed') : null });
  }
}

export async function syncNow(options: { forcePull?: boolean } = {}): Promise<void> {
  if (running || !navigator.onLine) return;
  running = true;
  patch({ syncing: true });
  try {
    if (navigator.locks) {
      // One sync at a time across ALL open tabs.
      await navigator.locks.request('vireek-field-sync', { ifAvailable: true }, async (lock) => {
        if (lock) await runSync(Boolean(options.forcePull));
      });
    } else {
      await runSync(Boolean(options.forcePull));
    }
  } finally {
    running = false;
    patch({ syncing: false });
    await refreshCounts();
    await scheduleNextRetry();
  }
}

async function scheduleNextRetry(): Promise<void> {
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = null;
  const now = Date.now();
  const waits = (await listOutbox().catch(() => []))
    .filter((o) => o.state === 'pending' && o.next_attempt_at > now)
    .map((o) => o.next_attempt_at - now);
  if (waits.length > 0) retryTimer = window.setTimeout(() => void syncNow(), Math.min(...waits) + 250);
}

/** Sync if online; otherwise ask the service worker to sync as soon as signal returns. */
export function requestSync(): void {
  if (navigator.onLine) {
    void syncNow();
    return;
  }
  void navigator.serviceWorker?.ready
    .then((reg) => (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync?.register('vireek-sync'))
    .catch(() => undefined);
}

/** Pre-loads the technician screens so the service worker caches them for offline use. */
export function warmTechnicianRoutes(): void {
  if (!navigator.onLine) return;
  void import('@/pages/TechnicianTodayPage').catch(() => undefined);
  void import('@/pages/TechnicianJobBriefPage').catch(() => undefined);
  void import('@/components/technician/FieldCapturePanel').catch(() => undefined);
}

let users = 0;
let teardown: (() => void) | null = null;

function boot(): () => void {
  const onOnline = () => {
    patch({ online: true });
    void syncNow({ forcePull: true });
  };
  const onOffline = () => patch({ online: false });
  const onVisible = () => {
    if (document.visibilityState === 'visible') void syncNow();
  };
  const onSwMessage = (e: MessageEvent) => {
    if ((e.data as { type?: string } | null)?.type === 'vireek-sync') void syncNow();
  };

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisible);
  navigator.serviceWorker?.addEventListener('message', onSwMessage);
  const offEnqueue = onEnqueue(requestSync);
  const offData = subscribeData(() => void refreshCounts());
  const timer = window.setInterval(() => void syncNow(), 45_000);

  // Ask the browser not to evict our offline data under storage pressure.
  void navigator.storage?.persist?.().catch(() => undefined);
  patch({ online: navigator.onLine });
  void getMeta<number>('bundle_at').then((t) => patch({ bundleAt: t ?? null })).catch(() => undefined);
  void refreshCounts();
  warmTechnicianRoutes();
  void syncNow({ forcePull: true });

  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisible);
    navigator.serviceWorker?.removeEventListener('message', onSwMessage);
    offEnqueue();
    offData();
    window.clearInterval(timer);
    if (retryTimer !== null) window.clearTimeout(retryTimer);
  };
}

/** Starts (ref-counted) the background sync engine. Returns a stop function. */
export function startFieldEngine(): () => void {
  users += 1;
  if (users === 1) teardown = boot();
  return () => {
    users -= 1;
    if (users === 0) {
      teardown?.();
      teardown = null;
    }
  };
}
