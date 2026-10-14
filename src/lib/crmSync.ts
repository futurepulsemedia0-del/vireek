/**
 * CRM Sync: client API.
 *
 * The browser never sees OAuth tokens and never writes sync tables. It:
 *   - reads connections / runs / log / conflicts (RLS + can_manage_crm),
 *   - asks edge functions to connect, sync, save settings, disconnect, resolve.
 *
 * Provider names, field catalogs, defaults and settings validation come from the
 * SAME engine file the server uses, so the mapping UI can never offer something
 * the server would reject.
 */

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  CONFLICT_RULES,
  CONFLICT_RULE_META,
  CRM_CATALOG,
  CRM_ENTITIES,
  CRM_PROVIDERS,
  CUSTOM_CRM_KEY,
  DIRECTION_META,
  ENTITY_META,
  PROVIDER_META,
  SYNC_DIRECTIONS,
  VIREEK_FIELDS,
  defaultSettings,
  validateSettings,
  type Canon,
  type CrmEntity,
  type CrmProvider,
  type CrmSettings,
  type SyncStats,
} from '../../supabase/functions/_shared/crm/engine';

export {
  CONFLICT_RULES,
  CONFLICT_RULE_META,
  CRM_CATALOG,
  CRM_ENTITIES,
  CRM_PROVIDERS,
  CUSTOM_CRM_KEY,
  DIRECTION_META,
  ENTITY_META,
  PROVIDER_META,
  SYNC_DIRECTIONS,
  VIREEK_FIELDS,
  defaultSettings,
  validateSettings,
};
export type { CrmEntity, CrmProvider, CrmSettings, SyncStats };

export type ConnectionStatus = 'connected' | 'error' | 'disconnected';
export type RunStatus = 'running' | 'success' | 'partial' | 'failed';
export type LogAction = 'created' | 'updated' | 'linked' | 'conflict' | 'skipped' | 'error';

export interface CrmConnection {
  id: string;
  user_id: string;
  provider: CrmProvider;
  status: ConnectionStatus;
  account_label: string | null;
  api_base: string | null;
  settings: unknown;
  auto_sync: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  sync_locked_until: string | null;
  created_at: string;
}

export interface CrmRun {
  id: string;
  connection_id: string;
  trigger: 'manual' | 'scheduled';
  status: RunStatus;
  stats: Partial<SyncStats>;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface CrmLogRow {
  id: string;
  entity: CrmEntity;
  direction: 'to_crm' | 'from_crm' | 'both' | 'none';
  action: LogAction;
  vireek_id: string | null;
  external_id: string | null;
  link_id: string | null;
  message: string | null;
  details: unknown;
  created_at: string;
}

export interface CrmConflict {
  link_id: string;
  entity: CrmEntity;
  fields: { field: string; vireek: Canon[string]; crm: Canon[string] }[];
  at: string | null;
}

export interface CrmDeal {
  id: string;
  title: string;
  amount: number | null;
  currency: string | null;
  status: 'open' | 'won' | 'lost';
  stage: string | null;
  close_date: string | null;
  updated_at: string;
}

/** Same gate as the nav item, route and every server call. */
export function useCanManageCrm(): boolean {
  const { isOwner, permissions } = useAuth();
  return isOwner || permissions.can_edit_business_profile === true;
}

export function useCrmOwnerId(): string | undefined {
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

export async function startOAuth(provider: CrmProvider): Promise<string> {
  const r = await invoke<{ url?: string }>('crm-oauth-start', { provider }, `Could not connect ${PROVIDER_META[provider].label}.`);
  if (!r.url) throw new Error(`Could not connect ${PROVIDER_META[provider].label}.`);
  return r.url;
}

export const syncNow = (connectionId: string) =>
  invoke<{ run_id: string }>('crm-sync-run', { action: 'run', connection_id: connectionId }, 'Could not start the sync.');

export const saveSettings = (connectionId: string, settings: CrmSettings, autoSync?: boolean) =>
  invoke<{ ok: true; settings: CrmSettings }>(
    'crm-sync-run',
    { action: 'save_settings', connection_id: connectionId, settings, ...(autoSync === undefined ? {} : { auto_sync: autoSync }) },
    'Could not save the settings.',
  );

export const disconnectCrm = (connectionId: string) =>
  invoke<{ ok: true }>('crm-sync-run', { action: 'disconnect', connection_id: connectionId }, 'Could not disconnect.');

export const resolveConflict = (linkId: string, winner: 'vireek' | 'crm') =>
  invoke<{ ok: true }>('crm-sync-run', { action: 'resolve_conflict', link_id: linkId, winner }, 'Could not resolve the conflict.');

const CONN_COLS =
  'id, user_id, provider, status, account_label, api_base, settings, auto_sync, last_synced_at, last_error, sync_locked_until, created_at';

export async function listConnections(ownerId: string): Promise<CrmConnection[]> {
  const { data, error } = await supabase.from('crm_connections').select(CONN_COLS).eq('user_id', ownerId);
  if (error) throw error;
  return (data ?? []) as CrmConnection[];
}

export async function listRuns(connectionId: string, limit = 8): Promise<CrmRun[]> {
  const { data, error } = await supabase
    .from('crm_sync_runs')
    .select('id, connection_id, trigger, status, stats, error, started_at, finished_at')
    .eq('connection_id', connectionId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as CrmRun[];
}

export const LOG_PAGE_SIZE = 50;

export async function listLog(
  connectionId: string,
  opts: { action?: LogAction | 'all'; entity?: CrmEntity | 'all'; before?: string | null } = {},
): Promise<CrmLogRow[]> {
  let q = supabase
    .from('crm_sync_log')
    .select('id, entity, direction, action, vireek_id, external_id, link_id, message, details, created_at')
    .eq('connection_id', connectionId);
  if (opts.action && opts.action !== 'all') q = q.eq('action', opts.action);
  if (opts.entity && opts.entity !== 'all') q = q.eq('entity', opts.entity);
  if (opts.before) q = q.lt('created_at', opts.before);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(LOG_PAGE_SIZE);
  if (error) throw error;
  return (data ?? []) as CrmLogRow[];
}

/** Open manual conflicts, each enriched with the two competing values from the log. */
export async function listConflicts(connectionId: string): Promise<CrmConflict[]> {
  const { data: links, error } = await supabase
    .from('crm_record_links')
    .select('id, entity, conflict')
    .eq('connection_id', connectionId)
    .not('conflict', 'is', null)
    .limit(50);
  if (error) throw error;
  const rows = (links ?? []) as { id: string; entity: CrmEntity; conflict: { at?: string } | null }[];
  if (!rows.length) return [];

  const { data: logs } = await supabase
    .from('crm_sync_log')
    .select('link_id, details, created_at')
    .eq('connection_id', connectionId)
    .eq('action', 'conflict')
    .in('link_id', rows.map((r) => r.id))
    .order('created_at', { ascending: false })
    .limit(200);
  const latest = new Map<string, { conflicts?: CrmConflict['fields'] }>();
  for (const l of (logs ?? []) as { link_id: string; details: { conflicts?: CrmConflict['fields'] } | null }[]) {
    if (!latest.has(l.link_id) && l.details) latest.set(l.link_id, l.details);
  }
  return rows.map((r) => ({
    link_id: r.id,
    entity: r.entity,
    at: r.conflict?.at ?? null,
    fields: (latest.get(r.id)?.conflicts ?? []).map((c) => ({ field: c.field, vireek: c.vireek, crm: c.crm })),
  }));
}

export async function listDeals(ownerId: string, limit = 10): Promise<CrmDeal[]> {
  const { data, error } = await supabase
    .from('crm_deals')
    .select('id, title, amount, currency, status, stage, close_date, updated_at')
    .eq('user_id', ownerId)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as CrmDeal[];
}

// ---- small display helpers ------------------------------------------------

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'Never';
  const mins = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function vireekFieldLabel(entity: CrmEntity, key: string): string {
  return VIREEK_FIELDS[entity].find((f) => f.key === key)?.label ?? key;
}

export function readSettings(provider: CrmProvider, raw: unknown): CrmSettings {
  const v = validateSettings(provider, raw);
  return v.ok ? v.settings : defaultSettings(provider);
}
