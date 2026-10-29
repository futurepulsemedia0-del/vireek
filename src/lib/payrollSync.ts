/**
 * Payroll provider integrations: client API.
 *
 * The browser never sees OAuth tokens and never writes sync tables. It reads through RLS
 * (can_manage_payroll_sync) and changes things only through RPCs / edge functions that re-check
 * permission and ownership. Catalog, status machine and settings validation come from the SAME engine
 * file the server uses, so the UI can never offer something the server would reject.
 */

import { FunctionsHttpError } from '@supabase/supabase-js';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import {
  PROVIDER_META,
  normalizeSettings,
  type BatchAction,
  type BatchStatus,
  type PayrollProvider,
  type PayrollSettings,
} from '../../supabase/functions/_shared/payroll/engine';

export { PROVIDER_META, normalizeSettings };
export type { BatchAction, BatchStatus, PayrollProvider, PayrollSettings };
export { PAYROLL_PROVIDERS, BATCH_ACTIONS, canBatchTransition, canSendBatch, isProviderLive, DEFAULT_PAYROLL_SETTINGS } from '../../supabase/functions/_shared/payroll/engine';

export type ConnectionStatus = 'connected' | 'error' | 'disconnected';
export type LineStatus = 'pending' | 'sent' | 'unchanged' | 'skipped' | 'failed';

export interface PayrollConnection {
  id: string;
  provider: PayrollProvider;
  environment: 'production' | 'sandbox';
  status: ConnectionStatus;
  external_company_id: string | null;
  company_name: string | null;
  settings: unknown;
  last_error: string | null;
  last_verified_at: string | null;
  created_at: string;
}

export interface PayrollBatch {
  id: string;
  connection_id: string;
  provider: PayrollProvider;
  period_start: string;
  period_end: string;
  status: BatchStatus;
  line_count: number;
  regular_hours: number;
  overtime_hours: number;
  commission_cents: number;
  created_by: string | null;
  submitted_by: string | null;
  approved_at: string | null;
  review_note: string | null;
  cancel_reason: string | null;
  external_payroll_id: string | null;
  run_count: number;
  finished_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface PayrollLine {
  id: string;
  batch_id: string;
  employee_id: string;
  employee_name: string;
  pay_type: string;
  send_hours: boolean;
  regular_hours: number;
  overtime_hours: number;
  commission_cents: number;
  status: LineStatus;
  skip_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  sent_at: string | null;
}

export interface PayrollLink {
  id: string;
  connection_id: string;
  employee_id: string;
  external_employee_id: string;
  external_name: string | null;
  match_method: 'auto_name' | 'manual';
  confirmed: boolean;
}

export interface PayrollEvent {
  id: string;
  batch_id: string | null;
  event: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface ProviderEmployee {
  id: string;
  name: string;
  email: string | null;
}

export interface OpenPayroll {
  id: string;
  start: string;
  end: string;
  checkDate: string | null;
  label: string;
}

export interface SendResult {
  status: BatchStatus;
  error: string | null;
  counts?: { sent: number; unchanged: number; failed: number };
}

export function useCanManagePayrollSync(): boolean {
  const { isOwner, permissions } = useAuth();
  return isOwner || (permissions.can_edit_business_profile === true && permissions.can_view_billing === true);
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

function check(error: { message: string } | null): void {
  if (error) throw error;
}

// ---------- reads ----------

export async function fetchConnections(ownerId: string): Promise<PayrollConnection[]> {
  const { data, error } = await supabase
    .from('payroll_connections')
    .select('id,provider,environment,status,external_company_id,company_name,settings,last_error,last_verified_at,created_at')
    .eq('user_id', ownerId)
    .order('created_at');
  check(error);
  return (data ?? []) as PayrollConnection[];
}

export async function fetchBatches(ownerId: string): Promise<PayrollBatch[]> {
  const { data, error } = await supabase
    .from('payroll_sync_batches')
    .select('id,connection_id,provider,period_start,period_end,status,line_count,regular_hours,overtime_hours,commission_cents,created_by,submitted_by,approved_at,review_note,cancel_reason,external_payroll_id,run_count,finished_at,last_error,created_at')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(50);
  check(error);
  return ((data ?? []) as PayrollBatch[]).map((b) => ({
    ...b,
    regular_hours: Number(b.regular_hours),
    overtime_hours: Number(b.overtime_hours),
    commission_cents: Number(b.commission_cents),
  }));
}

export async function fetchBatchLines(ownerId: string, batchId: string): Promise<PayrollLine[]> {
  const { data, error } = await supabase
    .from('payroll_sync_lines')
    .select('id,batch_id,employee_id,employee_name,pay_type,send_hours,regular_hours,overtime_hours,commission_cents,status,skip_reason,error_code,error_message,attempts,sent_at')
    .eq('user_id', ownerId)
    .eq('batch_id', batchId)
    .order('employee_name');
  check(error);
  return ((data ?? []) as PayrollLine[]).map((l) => ({
    ...l,
    regular_hours: Number(l.regular_hours),
    overtime_hours: Number(l.overtime_hours),
    commission_cents: Number(l.commission_cents),
  }));
}

export async function fetchLinks(ownerId: string, connectionId: string): Promise<PayrollLink[]> {
  const { data, error } = await supabase
    .from('payroll_employee_links')
    .select('id,connection_id,employee_id,external_employee_id,external_name,match_method,confirmed')
    .eq('user_id', ownerId)
    .eq('connection_id', connectionId);
  check(error);
  return (data ?? []) as PayrollLink[];
}

export async function fetchEvents(ownerId: string): Promise<PayrollEvent[]> {
  const { data, error } = await supabase
    .from('payroll_sync_events')
    .select('id,batch_id,event,detail,created_at')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(60);
  check(error);
  return (data ?? []) as PayrollEvent[];
}

// ---------- actions ----------

export async function startConnect(provider: PayrollProvider): Promise<{ url: string; environment: 'production' | 'sandbox' }> {
  return invoke('payroll-connect', { provider }, 'Could not start the connection.');
}

export async function loadProviderEmployees(connectionId: string): Promise<{ employees: ProviderEmployee[]; suggested: number }> {
  return invoke('payroll-sync', { action: 'employees', connectionId }, 'Could not load employees from your payroll provider.');
}

export async function listOpenPayrolls(connectionId: string, start: string, end: string): Promise<OpenPayroll[]> {
  const r = await invoke<{ payrolls: OpenPayroll[] }>('payroll-sync', { action: 'payrolls', connectionId, start, end }, 'Could not load open payrolls.');
  return r.payrolls;
}

export async function sendBatch(batchId: string, payrollId?: string): Promise<SendResult> {
  return invoke('payroll-sync', { action: 'run', batchId, payrollId: payrollId || undefined }, 'Could not send this batch.');
}

export async function disconnectProvider(connectionId: string): Promise<number> {
  const r = await invoke<{ cancelledBatches: number }>('payroll-sync', { action: 'disconnect', connectionId }, 'Could not disconnect.');
  return r.cancelledBatches;
}

export async function saveSettings(connectionId: string, settings: PayrollSettings): Promise<void> {
  const { error } = await supabase.rpc('save_payroll_sync_settings', { p_connection_id: connectionId, p_settings: settings });
  check(error);
}

export async function confirmLink(connectionId: string, employeeId: string, externalId: string, externalName: string | null): Promise<void> {
  const { error } = await supabase.rpc('confirm_payroll_employee_link', { p_connection_id: connectionId, p_employee_id: employeeId, p_external_id: externalId, p_external_name: externalName });
  check(error);
}

export async function removeLink(linkId: string): Promise<void> {
  const { error } = await supabase.rpc('remove_payroll_employee_link', { p_link_id: linkId });
  check(error);
}

export async function buildBatch(connectionId: string, start: string, end: string): Promise<string> {
  const { data, error } = await supabase.rpc('build_payroll_sync_batch', { p_connection_id: connectionId, p_start: start, p_end: end });
  check(error);
  return data as string;
}

export async function transitionBatch(id: string, action: BatchAction, note?: string): Promise<BatchStatus> {
  const { data, error } = await supabase.rpc('transition_payroll_sync_batch', { p_id: id, p_action: action, p_note: note ?? null });
  check(error);
  return data as BatchStatus;
}

// ---------- display ----------

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const BATCH_LABEL: Record<BatchStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Awaiting approval',
  approved: 'Approved, not sent',
  syncing: 'Sending…',
  synced: 'Sent',
  partial: 'Partly sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
export const BATCH_TONE: Record<BatchStatus, Tone> = {
  draft: 'neutral',
  pending_approval: 'warning',
  approved: 'info',
  syncing: 'info',
  synced: 'success',
  partial: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
};
export const LINE_LABEL: Record<LineStatus, string> = { pending: 'Ready', sent: 'Sent', unchanged: 'Already current', skipped: 'Skipped', failed: 'Failed' };
export const LINE_TONE: Record<LineStatus, Tone> = { pending: 'neutral', sent: 'success', unchanged: 'success', skipped: 'neutral', failed: 'danger' };
export const SKIP_COPY: Record<string, string> = { contractor_not_supported: '1099 contractors are paid outside this integration.' };

export const formatHours = (h: number): string => `${(Math.round(h * 100) / 100).toLocaleString('en-US')} h`;

export const EVENT_LABEL: Record<string, string> = {
  connected: 'Connected provider',
  disconnected: 'Disconnected provider',
  settings_saved: 'Changed earning names / approval policy',
  employee_linked: 'Linked an employee',
  employee_unlinked: 'Removed an employee link',
  batch_built: 'Built a batch',
  batch_submit: 'Submitted a batch for approval',
  batch_approve: 'Approved a batch',
  batch_return: 'Returned a batch to draft',
  batch_cancel: 'Cancelled a batch',
  sync_started: 'Started sending',
  sync_finished: 'Finished sending',
};
