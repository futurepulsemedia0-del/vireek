/**
 * Sage Intacct sync: client API (NOT LIVE-VERIFIED: mock-tested only).
 *
 * The browser never sees stored credentials and never writes sync tables. It:
 *   - reads the connection / runs / log / conflicts (RLS + can_manage_intacct),
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
  IA_CONFLICT_RULES,
  IA_DIRECTIONS,
  IA_ENTITIES,
  VIREEK_FIELDS,
  defaultSettings,
  effectiveDirection,
  isValidCompanyId,
  isValidEntityId,
  isValidPassword,
  isValidUserId,
  validateSettings,
  type IaConflictRule,
  type IaDirection,
  type IaEntity,
  type IaSettings,
  type SyncStats,
} from '../../supabase/functions/_shared/intacct/engine';

export {
  CONFLICT_RULE_META,
  DIRECTION_META,
  ENTITY_META,
  IA_CONFLICT_RULES,
  IA_DIRECTIONS,
  IA_ENTITIES,
  VIREEK_FIELDS,
  defaultSettings,
  effectiveDirection,
  validateSettings,
};
export type { IaConflictRule, IaDirection, IaEntity, IaSettings, SyncStats };

/** Shown wherever Sage Intacct sync appears, until it has been run against a real Sage Intacct sandbox. */
export const NOT_LIVE_VERIFIED_LABEL = 'Not live-verified';
export const NOT_LIVE_VERIFIED_NOTE =
  'This integration has only been tested against a simulated Sage Intacct. Try it on a sandbox company before connecting production books.';

export type ConnectionStatus = 'connected' | 'error' | 'disconnected';
export type RunStatus = 'running' | 'success' | 'partial' | 'failed';
export type LogAction = 'created' | 'updated' | 'linked' | 'voided' | 'conflict' | 'skipped' | 'error';

export interface IaConnection {
  id: string;
  user_id: string;
  company_id: string;
  entity_id: string | null;
  status: ConnectionStatus;
  company_name: string | null;
  settings: unknown;
  auto_sync: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  sync_locked_until: string | null;
  created_at: string;
}
export interface IaRun {
  id: string;
  connection_id: string;
  trigger: 'manual' | 'scheduled';
  status: RunStatus;
  stats: Partial<SyncStats> | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}
export interface IaLogRow {
  id: string;
  entity: IaEntity;
  direction: 'to_intacct' | 'from_intacct' | 'both' | 'none';
  action: LogAction;
  vireek_id: string | null;
  external_id: string | null;
  link_id: string | null;
  message: string | null;
  request_id: string | null;
  created_at: string;
}
export interface IaConflict {
  link_id: string;
  entity: IaEntity;
  reason: string | null;
  fields: { field: string; vireek: unknown; intacct: unknown }[];
}
export interface IaOptions {
  accounts: { id: string; name: string; type: string }[];
  banks: { id: string; name: string }[];
}
export interface ConnectInput { companyId: string; userId: string; password: string; entityId: string }

export function useCanManageIntacct(): boolean {
  const { isOwner, permissions } = useAuth();
  return isOwner || (permissions.can_edit_business_profile === true && permissions.can_view_billing === true);
}

export function useIntacctOwnerId(): string | undefined {
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

/** Client-side form check (the server re-validates everything). Returns an error message or null. */
export function validateConnectInput(i: ConnectInput): string | null {
  if (!isValidCompanyId(i.companyId.trim())) return 'Enter your Sage Intacct company ID (letters, numbers, dot, dash or underscore).';
  if (!isValidUserId(i.userId.trim())) return 'Enter the web services user ID.';
  if (!isValidPassword(i.password)) return 'Enter the web services user’s password.';
  if (i.entityId.trim() && !isValidEntityId(i.entityId.trim())) return 'The entity ID looks invalid. Leave it empty to connect at the top level.';
  return null;
}

export async function connectIntacct(i: ConnectInput): Promise<{ connection_id: string }> {
  const err = validateConnectInput(i);
  if (err) throw new Error(err);
  return invoke<{ connection_id: string }>(
    'intacct-connect',
    { company_id: i.companyId.trim(), user_id: i.userId.trim(), password: i.password, entity_id: i.entityId.trim() || undefined },
    'Could not connect Sage Intacct.',
  );
}

const run = (action: string, connectionId: string, extra: Record<string, unknown> = {}, fallback = 'Request failed.') =>
  invoke<Record<string, unknown>>('intacct-sync-run', { action, connection_id: connectionId, ...extra }, fallback);

export const syncNow = (id: string) => run('run', id, {}, 'Could not start the sync.') as Promise<{ run_id: string }>;
export const resyncAll = (id: string) => run('resync', id, {}, 'Could not start the full re-sync.') as Promise<{ run_id: string }>;
export const disconnectIntacct = (id: string) => run('disconnect', id, {}, 'Could not disconnect.');
export const loadOptions = (id: string) => run('options', id, {}, 'Could not load Sage Intacct lists.') as unknown as Promise<IaOptions>;
export const saveSettings = (id: string, settings: IaSettings, autoSync?: boolean) =>
  run('save_settings', id, { settings, ...(autoSync === undefined ? {} : { auto_sync: autoSync }) }, 'Could not save the settings.') as Promise<{ ok: true; settings: IaSettings }>;
export const resolveConflict = (linkId: string, winner: 'vireek' | 'intacct') =>
  invoke<{ ok: true }>('intacct-sync-run', { action: 'resolve_conflict', link_id: linkId, winner }, 'Could not resolve the conflict.');

const CONN_COLS = 'id, user_id, company_id, entity_id, status, company_name, settings, auto_sync, last_synced_at, last_error, sync_locked_until, created_at';

export async function getConnection(ownerId: string): Promise<IaConnection | null> {
  const { data, error } = await supabase.from('intacct_connections').select(CONN_COLS).eq('user_id', ownerId).maybeSingle();
  if (error) throw error;
  return (data as IaConnection | null) ?? null;
}

export async function listRuns(connectionId: string, limit = 8): Promise<IaRun[]> {
  const { data, error } = await supabase
    .from('intacct_sync_runs')
    .select('id, connection_id, trigger, status, stats, error, started_at, finished_at')
    .eq('connection_id', connectionId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as IaRun[];
}

export const LOG_PAGE_SIZE = 50;

export async function listLog(
  connectionId: string,
  opts: { action?: LogAction | 'all'; entity?: IaEntity | 'all'; before?: string | null } = {},
): Promise<IaLogRow[]> {
  let q = supabase
    .from('intacct_sync_log')
    .select('id, entity, direction, action, vireek_id, external_id, link_id, message, request_id, created_at')
    .eq('connection_id', connectionId);
  if (opts.action && opts.action !== 'all') q = q.eq('action', opts.action);
  if (opts.entity && opts.entity !== 'all') q = q.eq('entity', opts.entity);
  if (opts.before) q = q.lt('created_at', opts.before);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(LOG_PAGE_SIZE);
  if (error) throw error;
  return (data ?? []) as IaLogRow[];
}

/** Open conflicts, each enriched with the two competing values from the latest conflict log entry. */
export async function listConflicts(connectionId: string): Promise<IaConflict[]> {
  const { data: links, error } = await supabase
    .from('intacct_record_links')
    .select('id, entity, conflict')
    .eq('connection_id', connectionId)
    .not('conflict', 'is', null)
    .limit(50);
  if (error) throw error;
  const rows = (links ?? []) as { id: string; entity: IaEntity; conflict: { reason?: string } | null }[];
  if (!rows.length) return [];

  const { data: logs } = await supabase
    .from('intacct_sync_log')
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
    fields: (latest.get(r.id) ?? []).map((c) => ({ field: c.field, vireek: c.vireek, intacct: c.crm })),
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

export function vireekFieldLabel(entity: IaEntity, key: string): string {
  return VIREEK_FIELDS[entity].find((f) => f.key === key)?.label ?? key;
}

export function readSettings(raw: unknown): IaSettings {
  const v = validateSettings(raw && typeof raw === 'object' && Object.keys(raw as object).length ? raw : defaultSettings());
  return v.ok ? v.settings : defaultSettings();
}
