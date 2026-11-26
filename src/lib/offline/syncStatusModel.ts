// src/lib/offline/syncStatusModel.ts
// Turns the engine's SyncState into ONE clear message for the technician. Pure, unit tested.
// Priority: sign-in needed > conflicts > failures > offline > syncing > waiting > up to date.

import type { SyncState } from './sync';

export type SyncTone = 'ok' | 'info' | 'warning' | 'danger';
export type SyncKind = 'needs_sign_in' | 'conflict' | 'failed' | 'offline' | 'syncing' | 'waiting' | 'synced';

export interface SyncStatusView {
  kind: SyncKind;
  tone: SyncTone;
  label: string;
  detail: string | null;
  /** Items the technician still has on the device (pending + failed + conflicts). */
  count: number;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function describeSync(s: Pick<SyncState, 'online' | 'syncing' | 'pending' | 'failed' | 'conflicts' | 'needsSignIn'>): SyncStatusView {
  const count = s.pending + s.failed + s.conflicts;
  if (s.needsSignIn) {
    return { kind: 'needs_sign_in', tone: 'danger', label: 'Sign in to sync', detail: count > 0 ? `${plural(count, 'item is', 'items are')} saved on this device.` : null, count };
  }
  if (s.conflicts > 0) {
    return { kind: 'conflict', tone: 'warning', label: `${plural(s.conflicts, 'item needs', 'items need')} review`, detail: 'The office changed these jobs while you were offline.', count };
  }
  if (s.failed > 0) {
    return { kind: 'failed', tone: 'danger', label: `${plural(s.failed, 'item', 'items')} could not sync`, detail: 'Open the job to retry or discard.', count };
  }
  if (!s.online) {
    return {
      kind: 'offline', tone: 'warning', label: 'Offline: saving on this device',
      detail: s.pending > 0 ? `${plural(s.pending, 'item', 'items')} will sync when you have signal.` : 'Your work is saved and will sync when you have signal.',
      count,
    };
  }
  if (s.syncing) return { kind: 'syncing', tone: 'info', label: 'Syncing…', detail: s.pending > 0 ? `${plural(s.pending, 'item', 'items')} left.` : null, count };
  if (s.pending > 0) return { kind: 'waiting', tone: 'info', label: `${plural(s.pending, 'item', 'items')} waiting to sync`, detail: null, count };
  return { kind: 'synced', tone: 'ok', label: 'All synced', detail: null, count: 0 };
}
