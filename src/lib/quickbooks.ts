/**
 * QuickBooks Online sync: client API.
 *
 * The browser never sees OAuth tokens and never writes sync tables. It:
 *   - reads the connection / runs / log / conflicts (RLS + can_manage_quickbooks),
 *   - asks edge functions to connect, sync, save settings, disconnect and resolve conflicts.
 *
 * Entities, field catalogs, defaults and settings validation come from the SAME engine file the
 * server uses, so the mapping UI can never offer something the server would reject.
 */

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  CONFLICT_RULE_META,
  DIRECTION_META,
  ENTITY_META,
  QBO_CONFLICT_RULES,
  QBO_DIRECTIONS,
  QBO_ENTITIES,
  VIREEK_FIELDS,
  defaultSettings,
  effectiveDirection,
  validateSettings,
  type QboConflictRule,
  type QboDirection,
  type QboEntity,
  type QboSettings,
  type SyncStats,
} from '../../supabase/functions/_shared/quickbooks/engine';

export {
  CONFLICT_RULE_META,
  DIRECTION_META,
  ENTITY_META,
  QBO_CONFLICT_RULES,
  QBO_DIRECTIONS,
  QBO_ENTITIES,
  VIREEK_FIELDS,
  defaultSettings,
  effectiveDirection,
  validateSettings,
};
export type { QboConflictRule, QboDirection, QboEntity, QboSettings, SyncStats };

export type ConnectionStatus = 'connected' | 'error' | 'disconnected';
export type RunStatus = 'running' | 'success' | 'partial' | 'failed';
export type LogAction = 'created' | 'updated' | 'linked' | 'voided' | 'conflict' | 'skipped' | 'error';

export interface QboConnection {
  id: string;
  user_id: string;
  realm_id: string;
  environment: 'production' | 'sandbox';
  status: ConnectionStatus;
  company_name: string | null;
  settings: unknown;
  auto_sync: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  sync_locked_until: string | null;
  refresh_token_expires_at: string | null;
  created_at: string;
}
export interface QboRun {
  id: string;
  connection_id: string;
  trigger: 'manual' | 'scheduled' | 'webhook';
  status: RunStatus;
  stats: Partial<SyncStats> | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}
export interface QboLogRow {
  id: string;
  entity: QboEntity;
  direction: 'to_qbo' | 'from_qbo' | 'both' | 'none';
  action: LogAction;
  vireek_id: string | null;
  external_id: string | null;
  link_id: string | null;
  message: string | null;
  intuit_tid: string | null;
  created_at: string;
}
export interface QboConflict {
  link_id: string;
  entity: QboEntity;
  reason: string | null;
  fields: { field: string; vireek: unknown; qbo: unknown }[];
}
export interface QboOptions {
  accounts: { id: string; name: string; type: string; classification: string }[];
  items: { id: string; name: string; type: string }[];
  taxCodes: { id: string; name: string }[];
}

export function useCanManageQuickBooks(): boolean {
  const { isOwner, permissions } = useAuth();
  return isOwner || (permissions.can_edit_business_profile === true && permissions.can_view_billing === true);
}

export function useQboOwnerId(): string | undefined {
  const { isOwner, profile, teamMember } = useAuth();
  return isOwner ? profile?.id : teamMember?.account_owner_id;
}

async function readError(error: unknown, fallback: string): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const payload = await error.context.json();
      if (payload && typeof payload.error === 'string') return payload.error;
    } catch {
      /* keep fallback */
    }
  }
  return fallback;
}

async function invoke<T>(fn: string, body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) throw new Error(await readError(error, fallback));
  if (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string') {
    throw new Error((data as { error: string }).error);
  }
  return data as T;
}

export async function startOAuth(): Promise<string> {
  const r = await invoke<{ url?: string }>('qbo-oauth-start', {}, 'Could not connect QuickBooks.');
  if (!r.url) throw new Error('Could not connect QuickBooks.');
  return r.url;
}

const run = (action: string, connectionId: string, extra: Record<string, unknown> = {}, fallback = 'Request failed.') =>
  invoke<Record<string, unknown>>('qbo-sync-run', { action, connection_id: connectionId, ...extra }, fallback);

export const syncNow = (id: string) => run('run', id, {}, 'Could not start the sync.') as Promise<{ run_id: string }>;
export const resyncAll = (id: string) => run('resync', id, {}, 'Could not start the full re-sync.') as Promise<{ run_id: string }>;
export const disconnectQuickBooks = (id: string) => run('disconnect', id, {}, 'Could not disconnect.');
export const loadOptions = (id: string) => run('options', id, {}, 'Could not load QuickBooks lists.') as unknown as Promise<QboOptions>;
export const saveSettings = (id: string, settings: QboSettings, autoSync?: boolean) =>
  run('save_settings', id, { settings, ...(autoSync === undefined ? {} : { auto_sync: autoSync }) }, 'Could not save the settings.') as Promise<{ ok: true; settings: QboSettings }>;
export const resolveConflict = (linkId: string, winner: 'vireek' | 'qbo') =>
  invoke<{ ok: true }>('qbo-sync-run', { action: 'resolve_conflict', link_id: linkId, winner }, 'Could not resolve the conflict.');

const CONN_COLS =
  'id, user_id, realm_id, environment, status, company_name, settings, auto_sync, last_synced_at, last_error, sync_locked_until, refresh_token_expires_at, created_at';

export async function getConnection(ownerId: string): Promise<QboConnection | null> {
  const { data, error } = await supabase.from('qbo_connections').select(CONN_COLS).eq('user_id', ownerId).maybeSingle();
  if (error) throw error;
  return (data as QboConnection | null) ?? null;
}

export async function listRuns(connectionId: string, limit = 8): Promise<QboRun[]> {
  const { data, error } = await supabase
    .from('qbo_sync_runs')
    .select('id, connection_id, trigger, status, stats, error, started_at, finished_at')
    .eq('connection_id', connectionId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as QboRun[];
}

export const LOG_PAGE_SIZE = 50;

export async function listLog(
  connectionId: string,
  opts: { action?: LogAction | 'all'; entity?: QboEntity | 'all'; before?: string | null } = {},
): Promise<QboLogRow[]> {
  let q = supabase
    .from('qbo_sync_log')
    .select('id, entity, direction, action, vireek_id, external_id, link_id, message, intuit_tid, created_at')
    .eq('connection_id', connectionId);
  if (opts.action && opts.action !== 'all') q = q.eq('action', opts.action);
  if (opts.entity && opts.entity !== 'all') q = q.eq('entity', opts.entity);
  if (opts.before) q = q.lt('created_at', opts.before);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(LOG_PAGE_SIZE);
  if (error) throw error;
  return (data ?? []) as QboLogRow[];
}

/** Open conflicts, each enriched with the two competing values from the latest conflict log entry. */
export async function listConflicts(connectionId: string): Promise<QboConflict[]> {
  const { data: links, error } = await supabase
    .from('qbo_record_links')
    .select('id, entity, conflict')
    .eq('connection_id', connectionId)
    .not('conflict', 'is', null)
    .limit(50);
  if (error) throw error;
  const rows = (links ?? []) as { id: string; entity: QboEntity; conflict: { reason?: string } | null }[];
  if (!rows.length) return [];

  const { data: logs } = await supabase
    .from('qbo_sync_log')
    .select('link_id, details, created_at')
    .eq('connection_id', connectionId)
    .eq('action', 'conflict')
    .in('link_id', rows.map((r) => r.id))
    .order('created_at', { ascending: false })
    .limit(200);
  const latest = new Map<string, { field: string; vireek: unknown; crm: unknown }[]>();
  for (const l of (logs ?? []) as { link_id: string; details: unknown }[]) {
    if (!latest.has(l.link_id) && Array.isArray(l.details)) latest.set(l.link_id, l.details as { field: string; vireek: unknown; crm: unknown }[]);
  }
  return rows.map((r) => ({
    link_id: r.id,
    entity: r.entity,
    reason: r.conflict?.reason ?? null,
    fields: (latest.get(r.id) ?? []).map((c) => ({ field: c.field, vireek: c.vireek, qbo: c.crm })),
  }));
}

// ---- display helpers -------------------------------------------------------

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'Never';
  const mins = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function vireekFieldLabel(entity: QboEntity, key: string): string {
  return VIREEK_FIELDS[entity].find((f) => f.key === key)?.label ?? key;
}

export function readSettings(raw: unknown): QboSettings {
  const v = validateSettings(raw && typeof raw === 'object' && Object.keys(raw as object).length ? raw : defaultSettings());
  return v.ok ? v.settings : defaultSettings();
}

/** Days until the refresh token expires (Intuit: ~100 days without use); null when unknown. */
export function refreshDaysLeft(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  return Math.floor((new Date(iso).getTime() - now) / 86_400_000);
}

export const OAUTH_REASONS: Record<string, string> = {
  access_denied: 'You cancelled the QuickBooks sign-in.',
  invalid_state: 'The sign-in link expired. Please try again.',
  missing_code: 'QuickBooks did not return an authorisation code. Please try again.',
  missing_realm: 'QuickBooks did not say which company to connect. Please try again.',
  not_configured: 'QuickBooks is not configured on the server yet. Ask your administrator to set the QuickBooks secrets.',
  no_refresh_token: 'QuickBooks did not grant offline access. Please try again.',
  realm_in_use: 'That QuickBooks company is already connected to another Vireek account.',
  exchange_failed: 'Could not finish connecting to QuickBooks. Please try again.',
};
