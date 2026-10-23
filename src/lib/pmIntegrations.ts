/**
 * Property-management integrations: client API.
 *
 * The browser never sees credentials and never writes sync tables. It reads connections,
 * runs, queue, log, units and tenants (RLS + can_manage_pm_integrations) and asks the
 * `pm-sync-run` edge function to connect, sync, preview, save settings, retry and disconnect.
 * Provider catalog, defaults and settings validation come from the SAME engine file the
 * server uses, so the UI can never offer something the server would reject.
 */

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  PM_PROVIDERS,
  PROVIDER_META,
  WO_MAPPING_KEYS,
  WO_MAPPING_LABELS,
  WO_STATUSES,
  APPROVALS,
  INVOICE_CONSTANTS,
  DEFAULT_ENDPOINTS,
  defaultSettings,
  validateSettings,
  type PmProvider,
  type PmSettings,
  type PmStats,
} from '../../supabase/functions/_shared/pm/engine';

export {
  PM_PROVIDERS,
  PROVIDER_META,
  WO_MAPPING_KEYS,
  WO_MAPPING_LABELS,
  WO_STATUSES,
  APPROVALS,
  INVOICE_CONSTANTS,
  DEFAULT_ENDPOINTS,
  defaultSettings,
  validateSettings,
};
export type { PmProvider, PmSettings, PmStats };

export type ConnectionStatus = 'connected' | 'error' | 'disconnected';
export type RunStatus = 'running' | 'success' | 'partial' | 'failed';
export type QueueStatus = 'pending' | 'processing' | 'done' | 'failed' | 'cancelled';
export type LogAction = 'created' | 'updated' | 'linked' | 'pushed' | 'dry_run' | 'skipped' | 'conflict' | 'retry' | 'error';

export interface PmConnection {
  id: string;
  user_id: string;
  provider: PmProvider;
  account_label: string;
  status: ConnectionStatus;
  customer_id: string | null;
  settings: unknown;
  auto_sync: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  sync_locked_until: string | null;
  created_at: string;
}
export interface PmRun {
  id: string;
  connection_id: string;
  trigger: 'manual' | 'scheduled';
  status: RunStatus;
  stats: Partial<PmStats>;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}
export interface PmLogRow {
  id: string;
  entity: string;
  direction: 'to_pm' | 'from_pm' | 'none';
  action: LogAction;
  vireek_id: string | null;
  external_id: string | null;
  message: string | null;
  details: unknown;
  created_at: string;
}
export interface PmQueueRow {
  id: string;
  connection_id: string;
  kind: 'push_status' | 'push_invoice';
  subject_id: string;
  status: QueueStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  last_http_status: number | null;
  created_at: string;
}
export interface PmUnit {
  id: string;
  property_name: string | null;
  unit_number: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
}
export interface PmTenant {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: string | null;
  external_unit_id: string | null;
}
export interface PmPreviewSample {
  raw: string;
  canonical: Record<string, string | null>;
}

export function useCanManagePm(): boolean {
  const { isOwner, permissions } = useAuth();
  return isOwner || permissions.can_edit_business_profile === true;
}
export function usePmOwnerId(): string | undefined {
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

async function invoke<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke('pm-sync-run', { body });
  if (error) throw new Error(await readError(error, fallback));
  if (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string') {
    throw new Error((data as { error: string }).error);
  }
  return data as T;
}

export const connectPm = (provider: PmProvider, credentials: Record<string, string>, customerId?: string | null) =>
  invoke<{ connection_id: string; status: ConnectionStatus; warning: string | null }>(
    { action: 'connect', provider, credentials, customer_id: customerId ?? null },
    `Could not connect ${PROVIDER_META[provider].label}.`,
  );
export const syncNow = (connectionId: string) => invoke<{ run_id: string }>({ action: 'run', connection_id: connectionId }, 'Could not start the sync.');
export const previewSample = (connectionId: string, entity: 'workOrders' | 'units' | 'tenants') =>
  invoke<{ samples: PmPreviewSample[]; returned: number }>({ action: 'preview', connection_id: connectionId, entity }, 'Could not fetch a sample.');
export const saveSettings = (connectionId: string, settings: PmSettings, opts: { autoSync?: boolean; customerId?: string | null } = {}) =>
  invoke<{ ok: true; settings: PmSettings }>(
    {
      action: 'save_settings',
      connection_id: connectionId,
      settings,
      ...(opts.autoSync === undefined ? {} : { auto_sync: opts.autoSync }),
      ...(opts.customerId === undefined ? {} : { customer_id: opts.customerId }),
    },
    'Could not save the settings.',
  );
export const retryQueueItem = (id: string) => invoke<{ ok: true }>({ action: 'retry_item', queue_id: id }, 'Could not retry this item.');
export const cancelQueueItem = (id: string) => invoke<{ ok: true }>({ action: 'cancel_item', queue_id: id }, 'Could not cancel this item.');
export const disconnectPm = (connectionId: string) => invoke<{ ok: true }>({ action: 'disconnect', connection_id: connectionId }, 'Could not disconnect.');

const CONN_COLS = 'id, user_id, provider, account_label, status, customer_id, settings, auto_sync, last_synced_at, last_error, sync_locked_until, created_at';

export async function listConnections(ownerId: string): Promise<PmConnection[]> {
  const { data, error } = await supabase.from('pm_connections').select(CONN_COLS).eq('user_id', ownerId).order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as PmConnection[];
}
export async function listRuns(connectionId: string, limit = 6): Promise<PmRun[]> {
  const { data, error } = await supabase
    .from('pm_sync_runs')
    .select('id, connection_id, trigger, status, stats, error, started_at, finished_at')
    .eq('connection_id', connectionId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as PmRun[];
}

export const LOG_PAGE_SIZE = 50;
export async function listLog(connectionId: string, opts: { action?: LogAction | 'all'; before?: string | null } = {}): Promise<PmLogRow[]> {
  let q = supabase.from('pm_sync_log').select('id, entity, direction, action, vireek_id, external_id, message, details, created_at').eq('connection_id', connectionId);
  if (opts.action && opts.action !== 'all') q = q.eq('action', opts.action);
  if (opts.before) q = q.lt('created_at', opts.before);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(LOG_PAGE_SIZE);
  if (error) throw error;
  return (data ?? []) as PmLogRow[];
}
export async function listQueue(connectionId: string, status: 'open' | 'failed' | 'all' = 'open'): Promise<PmQueueRow[]> {
  let q = supabase
    .from('pm_sync_queue')
    .select('id, connection_id, kind, subject_id, status, attempts, max_attempts, next_attempt_at, last_error, last_http_status, created_at')
    .eq('connection_id', connectionId);
  if (status === 'open') q = q.in('status', ['pending', 'processing', 'failed']);
  if (status === 'failed') q = q.eq('status', 'failed');
  const { data, error } = await q.order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return (data ?? []) as PmQueueRow[];
}
export async function listUnits(connectionId: string, search = ''): Promise<PmUnit[]> {
  let q = supabase.from('pm_units').select('id, property_name, unit_number, address, city, state').eq('connection_id', connectionId);
  const term = search.trim().replace(/[%_,()]/g, ' ').slice(0, 60);
  if (term) q = q.or(`property_name.ilike.%${term}%,unit_number.ilike.%${term}%,address.ilike.%${term}%`);
  const { data, error } = await q.order('property_name', { ascending: true }).limit(100);
  if (error) throw error;
  return (data ?? []) as PmUnit[];
}
export async function listTenants(connectionId: string, search = ''): Promise<PmTenant[]> {
  let q = supabase.from('pm_tenant_contacts').select('id, name, email, phone, status, external_unit_id').eq('connection_id', connectionId);
  const term = search.trim().replace(/[%_,()]/g, ' ').slice(0, 60);
  if (term) q = q.or(`name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`);
  const { data, error } = await q.order('name', { ascending: true }).limit(100);
  if (error) throw error;
  return (data ?? []) as PmTenant[];
}
export async function listCustomers(ownerId: string): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabase.from('customers').select('id, name').eq('user_id', ownerId).order('name', { ascending: true }).limit(500);
  if (error) throw error;
  return (data ?? []) as { id: string; name: string }[];
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'Never';
  const mins = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function readSettings(provider: PmProvider, raw: unknown): PmSettings {
  const v = validateSettings(provider, raw);
  return v.ok ? v.settings : defaultSettings(provider);
}

/** What a provider can do out of the box, for the card badges. */
export function capabilityList(provider: PmProvider): { label: string; on: boolean }[] {
  const d = PROVIDER_META[provider].defaults;
  return [
    { label: 'Work orders in', on: d.pull },
    { label: 'Units', on: d.units },
    { label: 'Tenant contacts', on: d.tenants },
    { label: 'Status updates out', on: d.pushStatus },
    { label: 'Invoices out', on: d.pushInvoice },
  ];
}
