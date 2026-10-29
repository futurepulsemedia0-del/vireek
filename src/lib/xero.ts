/**
 * Xero sync: client API (mirrors src/lib/quickbooks.ts).
 *
 * The browser never sees OAuth tokens and never writes sync tables. It:
 *   - reads the connection / runs / log / conflicts / tax rates (RLS + can_manage_xero),
 *   - asks edge functions to connect, sync, save settings, disconnect and resolve conflicts.
 *
 * Entities, field catalogs, defaults and settings validation come from the SAME engine file the
 * server uses, so the mapping UI can never offer something the server would reject.
 * NOT LIVE-VERIFIED against a real Xero organisation (see XERO_SYNC.md).
 */

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  CONFLICT_RULE_META,
  CURRENCY_MODE_META,
  DIRECTION_META,
  ENTITY_META,
  FOREIGN_CURRENCY_MODES,
  VIREEK_FIELDS,
  XERO_CONFLICT_RULES,
  XERO_DIRECTIONS,
  XERO_ENTITIES,
  defaultSettings,
  effectiveDirection,
  selectableSalesTaxRates,
  taxRateMismatch,
  validateSettings,
  type ForeignCurrencyMode,
  type SyncStats,
  type XeroConflictRule,
  type XeroDirection,
  type XeroEntity,
  type XeroSettings,
  type XeroTaxRate,
} from '../../supabase/functions/_shared/xero/engine';

export {
  CONFLICT_RULE_META,
  CURRENCY_MODE_META,
  DIRECTION_META,
  ENTITY_META,
  FOREIGN_CURRENCY_MODES,
  VIREEK_FIELDS,
  XERO_CONFLICT_RULES,
  XERO_DIRECTIONS,
  XERO_ENTITIES,
  defaultSettings,
  effectiveDirection,
  selectableSalesTaxRates,
  taxRateMismatch,
  validateSettings,
};
export type { ForeignCurrencyMode, SyncStats, XeroConflictRule, XeroDirection, XeroEntity, XeroSettings, XeroTaxRate };

export type ConnectionStatus = 'connected' | 'error' | 'disconnected';
export type RunStatus = 'running' | 'success' | 'partial' | 'failed';
export type LogAction = 'created' | 'updated' | 'linked' | 'voided' | 'conflict' | 'skipped' | 'error';
export type LogEntity = XeroEntity | 'tax_rate';

export interface XeroConnection {
  id: string;
  user_id: string;
  tenant_id: string;
  organisation_name: string | null;
  base_currency: string | null;
  country_code: string | null;
  is_demo: boolean;
  status: ConnectionStatus;
  settings: unknown;
  auto_sync: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  sync_locked_until: string | null;
  refresh_token_expires_at: string | null;
  created_at: string;
}
export interface XeroRun {
  id: string;
  connection_id: string;
  trigger: 'manual' | 'scheduled' | 'webhook';
  status: RunStatus;
  stats: Partial<SyncStats> | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}
export interface XeroLogRow {
  id: string;
  entity: LogEntity;
  direction: 'to_xero' | 'from_xero' | 'both' | 'none';
  action: LogAction;
  vireek_id: string | null;
  external_id: string | null;
  link_id: string | null;
  message: string | null;
  xero_correlation_id: string | null;
  created_at: string;
}
export interface XeroConflict {
  link_id: string;
  entity: XeroEntity;
  reason: string | null;
  fields: { field: string; vireek: unknown; xero: unknown }[];
}
export interface XeroOptions {
  accounts: { id: string; code: string; name: string; type: string; classification: string; bank: boolean }[];
  items: { code: string; name: string }[];
  taxRates: XeroTaxRate[];
  currencies: { code: string; description: string }[];
  organisation: { baseCurrency: string; vireekCurrency: string; currencyOk: boolean; reason: string | null };
  vireekTaxRate: number | null;
}

export function useCanManageXero(): boolean {
  const { isOwner, permissions } = useAuth();
  return isOwner || (permissions.can_edit_business_profile === true && permissions.can_view_billing === true);
}

export function useXeroOwnerId(): string | undefined {
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
  const r = await invoke<{ url?: string }>('xero-oauth-start', {}, 'Could not connect Xero.');
  if (!r.url) throw new Error('Could not connect Xero.');
  return r.url;
}

const run = (action: string, connectionId: string, extra: Record<string, unknown> = {}, fallback = 'Request failed.') =>
  invoke<Record<string, unknown>>('xero-sync-run', { action, connection_id: connectionId, ...extra }, fallback);

export const syncNow = (id: string) => run('run', id, {}, 'Could not start the sync.') as Promise<{ run_id: string }>;
export const resyncAll = (id: string) => run('resync', id, {}, 'Could not start the full re-sync.') as Promise<{ run_id: string }>;
export const disconnectXero = (id: string) => run('disconnect', id, {}, 'Could not disconnect.');
export const loadOptions = (id: string) => run('options', id, {}, 'Could not load Xero lists.') as unknown as Promise<XeroOptions>;
export const saveSettings = (id: string, settings: XeroSettings, autoSync?: boolean) =>
  run('save_settings', id, { settings, ...(autoSync === undefined ? {} : { auto_sync: autoSync }) }, 'Could not save the settings.') as Promise<{ ok: true; settings: XeroSettings }>;
export const resolveConflict = (linkId: string, winner: 'vireek' | 'xero') =>
  invoke<{ ok: true }>('xero-sync-run', { action: 'resolve_conflict', link_id: linkId, winner }, 'Could not resolve the conflict.');

const CONN_COLS =
  'id, user_id, tenant_id, organisation_name, base_currency, country_code, is_demo, status, settings, auto_sync, last_synced_at, last_error, sync_locked_until, refresh_token_expires_at, created_at';

export async function getConnection(ownerId: string): Promise<XeroConnection | null> {
  const { data, error } = await supabase.from('xero_connections').select(CONN_COLS).eq('user_id', ownerId).maybeSingle();
  if (error) throw error;
  return (data as XeroConnection | null) ?? null;
}

export async function listRuns(connectionId: string, limit = 8): Promise<XeroRun[]> {
  const { data, error } = await supabase
    .from('xero_sync_runs')
    .select('id, connection_id, trigger, status, stats, error, started_at, finished_at')
    .eq('connection_id', connectionId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as XeroRun[];
}

export const LOG_PAGE_SIZE = 50;

export async function listLog(
  connectionId: string,
  opts: { action?: LogAction | 'all'; entity?: LogEntity | 'all'; before?: string | null } = {},
): Promise<XeroLogRow[]> {
  let q = supabase
    .from('xero_sync_log')
    .select('id, entity, direction, action, vireek_id, external_id, link_id, message, xero_correlation_id, created_at')
    .eq('connection_id', connectionId);
  if (opts.action && opts.action !== 'all') q = q.eq('action', opts.action);
  if (opts.entity && opts.entity !== 'all') q = q.eq('entity', opts.entity);
  if (opts.before) q = q.lt('created_at', opts.before);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(LOG_PAGE_SIZE);
  if (error) throw error;
  return (data ?? []) as XeroLogRow[];
}

/** The read-only Xero tax rates cached by the last sync. */
export async function listTaxRates(connectionId: string): Promise<XeroTaxRate[]> {
  const { data, error } = await supabase
    .from('xero_tax_rates')
    .select('tax_type, name, effective_rate, status, report_tax_type, can_apply_to_revenue, components')
    .eq('connection_id', connectionId)
    .order('name');
  if (error) throw error;
  return ((data ?? []) as { tax_type: string; name: string; effective_rate: number; status: string; report_tax_type: string | null; can_apply_to_revenue: boolean; components: XeroTaxRate['components'] }[]).map((r) => ({
    taxType: r.tax_type,
    name: r.name,
    effectiveRate: Number(r.effective_rate),
    status: r.status,
    reportTaxType: r.report_tax_type,
    canApplyToRevenue: r.can_apply_to_revenue,
    components: r.components ?? [],
  }));
}

/** Open conflicts, each enriched with the two competing values from the latest conflict log entry. */
export async function listConflicts(connectionId: string): Promise<XeroConflict[]> {
  const { data: links, error } = await supabase
    .from('xero_record_links')
    .select('id, entity, conflict')
    .eq('connection_id', connectionId)
    .not('conflict', 'is', null)
    .limit(50);
  if (error) throw error;
  const rows = (links ?? []) as { id: string; entity: XeroEntity; conflict: { reason?: string } | null }[];
  if (!rows.length) return [];

  const { data: logs } = await supabase
    .from('xero_sync_log')
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
    fields: (latest.get(r.id) ?? []).map((c) => ({ field: c.field, vireek: c.vireek, xero: c.crm })),
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

export function vireekFieldLabel(entity: XeroEntity, key: string): string {
  return VIREEK_FIELDS[entity].find((f) => f.key === key)?.label ?? key;
}

export function readSettings(raw: unknown): XeroSettings {
  const v = validateSettings(raw && typeof raw === 'object' && Object.keys(raw as object).length ? raw : defaultSettings());
  return v.ok ? v.settings : defaultSettings();
}

/** Days until the refresh token expires (Xero: 60 days without use); null when unknown. */
export function refreshDaysLeft(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  return Math.floor((new Date(iso).getTime() - now) / 86_400_000);
}

export const OAUTH_REASONS: Record<string, string> = {
  access_denied: 'You cancelled the Xero sign-in.',
  invalid_state: 'The sign-in link expired. Please try again.',
  missing_code: 'Xero did not return an authorisation code. Please try again.',
  not_configured: 'Xero is not configured on the server yet. Ask your administrator to set the Xero secrets.',
  no_refresh_token: 'Xero did not grant offline access. Please try again.',
  multiple_orgs: 'You selected more than one Xero organisation. Connect again and tick exactly one.',
  no_org: 'Xero did not share an organisation. Connect again and select the organisation to sync.',
  org_in_use: 'That Xero organisation is already connected to another Vireek account.',
  exchange_failed: 'Could not finish connecting to Xero. Please try again.',
};
