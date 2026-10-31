/**
 * NetSuite sync: client API. NOT LIVE-VERIFIED (see NS_VERIFICATION).
 *
 * The browser never sees credentials after the connect form is submitted and never writes sync tables. It:
 *   - reads the connection / runs / log / conflicts (RLS + can_manage_netsuite),
 *   - asks edge functions to connect, sync, save settings, disconnect and resolve conflicts.
 *
 * Entities, field catalogs, defaults and settings validation come from the SAME engine file the server
 * uses, so the mapping UI can never offer something the server would reject.
 */

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  CONFLICT_RULE_META,
  DIRECTION_META,
  ENTITY_META,
  NS_CONFLICT_RULES,
  NS_DIRECTIONS,
  NS_ENTITIES,
  NS_VERIFICATION,
  VIREEK_FIELDS,
  defaultSettings,
  effectiveDirection,
  isValidAccountId,
  validateCredentials,
  validateSettings,
  type NsConflictRule,
  type NsDirection,
  type NsEntity,
  type NsSettings,
  type SyncStats,
} from '../../supabase/functions/_shared/netsuite/engine';

export {
  CONFLICT_RULE_META,
  DIRECTION_META,
  ENTITY_META,
  NS_CONFLICT_RULES,
  NS_DIRECTIONS,
  NS_ENTITIES,
  NS_VERIFICATION,
  VIREEK_FIELDS,
  defaultSettings,
  effectiveDirection,
  isValidAccountId,
  validateCredentials,
  validateSettings,
};
export type { NsConflictRule, NsDirection, NsEntity, NsSettings, SyncStats };

export type ConnectionStatus = 'connected' | 'error' | 'disconnected';
export type RunStatus = 'running' | 'success' | 'partial' | 'failed';
export type LogAction = 'created' | 'updated' | 'linked' | 'voided' | 'conflict' | 'skipped' | 'error';

export interface NsConnection {
  id: string;
  user_id: string;
  account_id: string;
  environment: 'production' | 'sandbox' | 'release_preview';
  status: ConnectionStatus;
  company_name: string | null;
  settings: unknown;
  auto_sync: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  sync_locked_until: string | null;
  created_at: string;
}
export interface NsRun {
  id: string;
  connection_id: string;
  trigger: 'manual' | 'scheduled';
  status: RunStatus;
  stats: Partial<SyncStats> | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}
export interface NsLogRow {
  id: string;
  entity: NsEntity;
  direction: 'to_ns' | 'from_ns' | 'both' | 'none';
  action: LogAction;
  vireek_id: string | null;
  external_id: string | null;
  link_id: string | null;
  message: string | null;
  created_at: string;
}
export interface NsConflict {
  link_id: string;
  entity: NsEntity;
  reason: string | null;
  fields: { field: string; vireek: unknown; ns: unknown }[];
}
export interface NsOptions {
  accounts: { id: string; name: string; type: string }[];
  items: { id: string; name: string }[];
  taxCodes: { id: string; name: string }[];
  subsidiaries: { id: string; name: string }[];
}
export interface NsCredentialsForm {
  accountId: string;
  consumerKey: string;
  consumerSecret: string;
  tokenId: string;
  tokenSecret: string;
}

export function useCanManageNetSuite(): boolean {
  const { isOwner, permissions } = useAuth();
  return isOwner || (permissions.can_edit_business_profile === true && permissions.can_view_billing === true);
}

export function useNsOwnerId(): string | undefined {
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

/** Validates locally (same rules as the server), then sends the credentials once. They are never kept in the browser. */
export async function connectNetSuite(form: NsCredentialsForm): Promise<{ connection_id: string; company_name: string | null }> {
  const v = validateCredentials(form);
  if (!v.ok) throw new Error(v.error);
  return invoke(
    'ns-connect',
    { account_id: v.credentials.accountId, consumer_key: v.credentials.consumerKey, consumer_secret: v.credentials.consumerSecret, token_id: v.credentials.tokenId, token_secret: v.credentials.tokenSecret },
    'Could not connect NetSuite.',
  );
}

const run = (action: string, connectionId: string, extra: Record<string, unknown> = {}, fallback = 'Request failed.') =>
  invoke<Record<string, unknown>>('ns-sync-run', { action, connection_id: connectionId, ...extra }, fallback);

export const syncNow = (id: string) => run('run', id, {}, 'Could not start the sync.') as Promise<{ run_id: string }>;
export const resyncAll = (id: string) => run('resync', id, {}, 'Could not start the full re-sync.') as Promise<{ run_id: string }>;
export const disconnectNetSuite = (id: string) => run('disconnect', id, {}, 'Could not disconnect.');
export const loadOptions = (id: string) => run('options', id, {}, 'Could not load NetSuite lists.') as unknown as Promise<NsOptions>;
export const saveSettings = (id: string, settings: NsSettings, autoSync?: boolean) =>
  run('save_settings', id, { settings, ...(autoSync === undefined ? {} : { auto_sync: autoSync }) }, 'Could not save the settings.') as Promise<{ ok: true; settings: NsSettings }>;
export const resolveConflict = (linkId: string, winner: 'vireek' | 'ns') =>
  invoke<{ ok: true }>('ns-sync-run', { action: 'resolve_conflict', link_id: linkId, winner }, 'Could not resolve the conflict.');

const CONN_COLS = 'id, user_id, account_id, environment, status, company_name, settings, auto_sync, last_synced_at, last_error, sync_locked_until, created_at';

export async function getConnection(ownerId: string): Promise<NsConnection | null> {
  const { data, error } = await supabase.from('ns_connections').select(CONN_COLS).eq('user_id', ownerId).maybeSingle();
  if (error) throw error;
  return (data as NsConnection | null) ?? null;
}

export async function listRuns(connectionId: string, limit = 8): Promise<NsRun[]> {
  const { data, error } = await supabase
    .from('ns_sync_runs')
    .select('id, connection_id, trigger, status, stats, error, started_at, finished_at')
    .eq('connection_id', connectionId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as NsRun[];
}

export const LOG_PAGE_SIZE = 50;

export async function listLog(
  connectionId: string,
  opts: { action?: LogAction | 'all'; entity?: NsEntity | 'all'; before?: string | null } = {},
): Promise<NsLogRow[]> {
  let q = supabase
    .from('ns_sync_log')
    .select('id, entity, direction, action, vireek_id, external_id, link_id, message, created_at')
    .eq('connection_id', connectionId);
  if (opts.action && opts.action !== 'all') q = q.eq('action', opts.action);
  if (opts.entity && opts.entity !== 'all') q = q.eq('entity', opts.entity);
  if (opts.before) q = q.lt('created_at', opts.before);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(LOG_PAGE_SIZE);
  if (error) throw error;
  return (data ?? []) as NsLogRow[];
}

/** Open conflicts, each enriched with the two competing values from the latest conflict log entry. */
export async function listConflicts(connectionId: string): Promise<NsConflict[]> {
  const { data: links, error } = await supabase
    .from('ns_record_links')
    .select('id, entity, conflict')
    .eq('connection_id', connectionId)
    .not('conflict', 'is', null)
    .limit(50);
  if (error) throw error;
  const rows = (links ?? []) as { id: string; entity: NsEntity; conflict: { reason?: string } | null }[];
  if (!rows.length) return [];

  const { data: logs } = await supabase
    .from('ns_sync_log')
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
    fields: (latest.get(r.id) ?? []).map((c) => ({ field: c.field, vireek: c.vireek, ns: c.crm })),
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

export function vireekFieldLabel(entity: NsEntity, key: string): string {
  return VIREEK_FIELDS[entity].find((f) => f.key === key)?.label ?? key;
}

export function readSettings(raw: unknown): NsSettings {
  const v = validateSettings(raw && typeof raw === 'object' && Object.keys(raw as object).length ? raw : defaultSettings());
  return v.ok ? v.settings : defaultSettings();
}

export const ENVIRONMENT_LABEL: Record<NsConnection['environment'], string> = {
  production: 'Production',
  sandbox: 'Sandbox',
  release_preview: 'Release preview',
};
