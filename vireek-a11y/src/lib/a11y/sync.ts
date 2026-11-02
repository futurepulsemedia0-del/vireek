import { sanitizeSettings, type AccessibilitySettings } from './settings';

const TABLE = 'accessibility_preferences';
export const SYNC_ENABLED_KEY = 'vireek-a11y-sync-enabled';
export const LOCAL_AT_KEY = 'vireek-a11y-settings-at';
export const LOCAL_EDIT_KEY = 'vireek-a11y-settings-edited';
const MAX_BYTES = 16_000;

type Err = { message: string } | null;
type Res<T> = PromiseLike<{ data: T | null; error: Err }>;
/** Minimal structural type of the supabase-js calls used (keeps this module testable with a fake). */
export interface PrefsClient {
  from(table: string): {
    select(cols: string): { eq(col: string, val: string): { maybeSingle(): Res<{ settings: unknown; updated_at: string }> } };
    upsert(row: Record<string, unknown>, opts: { onConflict: string }): { select(cols: string): { single(): Res<{ updated_at: string }> } };
    delete(): { eq(col: string, val: string): PromiseLike<{ error: Err }> };
  };
}

export interface Remote { settings: AccessibilitySettings; updatedAt: number }

export async function fetchRemote(c: PrefsClient, userId: string): Promise<{ ok: true; remote: Remote | null } | { ok: false; error: string }> {
  const { data, error } = await c.from(TABLE).select('settings, updated_at').eq('user_id', userId).maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: true, remote: null };
  const at = Date.parse(data.updated_at);
  return { ok: true, remote: { settings: sanitizeSettings(data.settings), updatedAt: Number.isFinite(at) ? at : 0 } };
}

export async function pushRemote(c: PrefsClient, userId: string, s: AccessibilitySettings): Promise<{ ok: true; updatedAt: number } | { ok: false; error: string }> {
  if (JSON.stringify(s).length > MAX_BYTES) return { ok: false, error: 'too-large' };
  const { data, error } = await c.from(TABLE).upsert({ user_id: userId, settings: s, version: 2 }, { onConflict: 'user_id' }).select('updated_at').single();
  if (error || !data) return { ok: false, error: error?.message ?? 'no-data' };
  return { ok: true, updatedAt: Date.parse(data.updated_at) || Date.now() };
}

export async function deleteRemote(c: PrefsClient, userId: string): Promise<{ ok: boolean }> {
  const { error } = await c.from(TABLE).delete().eq('user_id', userId);
  return { ok: !error };
}

/**
 * syncedAt = server time of the last successful sync/pull (0 = never); editedAt = client time of the last local edit.
 * Conflict (both changed since last sync): the newer timestamp wins. Clock skew between devices can mis-order edits made
 * within seconds of each other — accepted trade-off for a preferences blob.
 */
export function decideSync(syncedAt: number, editedAt: number, remote: Remote | null): 'push' | 'pull' | 'none' {
  if (!remote) return 'push';
  const remoteNewer = remote.updatedAt > syncedAt;
  const localDirty = editedAt > syncedAt;
  if (!remoteNewer) return localDirty ? 'push' : 'none';
  if (!localDirty) return 'pull';
  return editedAt >= remote.updatedAt ? 'push' : 'pull';
}

export type SyncStatus = 'off' | 'signedOut' | 'syncing' | 'synced' | 'error';
let status: SyncStatus = 'off';
const listeners = new Set<() => void>();
export const getSyncStatus = (): SyncStatus => status;
export function setSyncStatus(s: SyncStatus): void {
  if (s === status) return;
  status = s;
  listeners.forEach((l) => l());
}
export function subscribeSync(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function readSyncEnabled(): boolean {
  try { return localStorage.getItem(SYNC_ENABLED_KEY) === '1'; } catch { return false; }
}
export function writeSyncEnabled(on: boolean): void {
  try { if (on) localStorage.setItem(SYNC_ENABLED_KEY, '1'); else localStorage.removeItem(SYNC_ENABLED_KEY); } catch { /* ignore */ }
}
export function readLocalAt(): number {
  try { return Number(localStorage.getItem(LOCAL_AT_KEY)) || 0; } catch { return 0; }
}
export function writeLocalAt(at: number): void {
  try { localStorage.setItem(LOCAL_AT_KEY, String(at)); } catch { /* ignore */ }
}
export function readEditedAt(): number {
  try { return Number(localStorage.getItem(LOCAL_EDIT_KEY)) || 0; } catch { return 0; }
}
export function writeEditedAt(at: number): void {
  try { localStorage.setItem(LOCAL_EDIT_KEY, String(at)); } catch { /* ignore */ }
}
