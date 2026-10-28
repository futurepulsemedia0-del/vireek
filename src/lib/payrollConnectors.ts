/**
 * Payroll provider connectors: client API.
 *
 * The browser never sees OAuth tokens and never writes connector tables. It reads through RLS
 * (can_manage_payroll_connectors) and writes only through SECURITY DEFINER RPCs and the
 * `payroll-connector` edge function. File layouts, settings validation and Gusto matching come from the
 * SAME engine the server uses, so the UI can never offer something the server would reject.
 */

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  PAYROLL_PROVIDERS,
  PROVIDER_META,
  defaultSettings,
  formatAmount,
  formatHours,
  matchGustoEmployees,
  normalizeLine,
  renderExportFile,
  sha256Hex,
  totalsOf,
  validateExternalId,
  validateSettings,
  type ConnectorSettings,
  type DeliveryMode,
  type ExportLine,
  type MappingEmployee,
  type PayrollProvider,
  type SuggestedLink,
} from '../../supabase/functions/_shared/payroll-connectors/engine';

export {
  PAYROLL_PROVIDERS,
  PROVIDER_META,
  defaultSettings,
  formatAmount,
  formatHours,
  matchGustoEmployees,
  totalsOf,
  validateExternalId,
  validateSettings,
};
export type { ConnectorSettings, DeliveryMode, ExportLine, MappingEmployee, PayrollProvider, SuggestedLink };

export type ConnectionMode = 'file' | 'api';
export type ExportStatus = 'ready' | 'delivering' | 'delivered' | 'partial' | 'failed' | 'void';
export type LineStatus = 'pending' | 'sent' | 'unchanged' | 'conflict' | 'error';

export interface PayrollConnection {
  id: string;
  provider: PayrollProvider;
  mode: ConnectionMode;
  status: 'connected' | 'error';
  environment: 'production' | 'sandbox';
  external_company_id: string | null;
  company_name: string | null;
  settings: unknown;
  meta: { companies?: { id: string; name: string }[] } | null;
  last_exported_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface PreviewLine extends ExportLine {
  flags: string[];
  timesheet_count: number;
  commission_count: number;
  tip_count: number;
}
export interface PreviewWarning {
  code: 'unmapped' | 'negative_commission' | 'pending_timesheets' | 'overlap';
  count: number;
  message: string;
}
export interface ExportPreview {
  provider: PayrollProvider;
  period_start: string;
  period_end: string;
  connection: { id: string; mode: ConnectionMode; status: string; company_name: string | null; external_company_id: string | null } | null;
  lines: PreviewLine[];
  totals: { employees: number; regular_hours: number; overtime_hours: number; commission_cents: number; tip_cents: number };
  warnings: PreviewWarning[];
}

export interface PayrollExport {
  id: string;
  connection_id: string | null;
  provider: PayrollProvider;
  delivery: DeliveryMode;
  period_start: string;
  period_end: string;
  status: ExportStatus;
  totals: Partial<ExportPreview['totals']>;
  warnings: PreviewWarning[];
  file_name: string | null;
  file_sha256: string | null;
  downloaded_at: string | null;
  external_ref: string | null;
  last_error: string | null;
  delivered_at: string | null;
  void_reason: string | null;
  created_at: string;
}
export interface ExportDetailLine extends ExportLine {
  id: string;
  delivery_status: LineStatus;
  delivery_message: string | null;
  drift: boolean;
}
export interface ExportEvent {
  id: string;
  event: string;
  message: string | null;
  created_at: string;
}
export interface ExportDetail {
  export: PayrollExport;
  lines: ExportDetailLine[];
  events: ExportEvent[];
}
export interface MappingRow {
  employee_id: string;
  name: string;
  email: string | null;
  active: boolean;
  pay_type: string;
  external_id: string | null;
  external_job_id: string | null;
  label: string | null;
  match_source: 'manual' | 'email' | 'name' | null;
}
export interface GustoEmployeeRow {
  id: string;
  name: string;
  email: string | null;
  jobId: string | null;
  terminated: boolean;
}
export interface DeliveryResult {
  status: 'delivered' | 'partial' | 'failed';
  counts: { sent: number; unchanged: number; conflict: number; error: number };
  lines: { employee_id: string; status: LineStatus; message: string }[];
}

// ------------------------------------------------------------------
// Access
// ------------------------------------------------------------------

/** Same gate as the SQL side (can_manage_payroll_connectors): owner or billing access. */
export function useCanManagePayrollConnectors(): boolean {
  const { isOwner, permissions } = useAuth();
  return isOwner || permissions.can_view_billing === true;
}

export function usePayrollOwnerId(): string | undefined {
  const { isOwner, profile, teamMember } = useAuth();
  return isOwner ? profile?.id : teamMember?.account_owner_id;
}

// ------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------

const CODE_MESSAGES: Record<string, string> = {
  NOTHING_TO_EXPORT: 'Nothing to export for this period: no approved hours, commissions or tips with a provider ID were found.',
  NO_CONNECTION: 'Set up this provider first in the Connections tab.',
  API_NOT_CONNECTED: 'Connect Gusto and choose its company before sending through the API.',
  INVALID_PERIOD: 'Choose a valid period (start on or before end, at most 93 days).',
  DUPLICATE_EXTERNAL_ID: 'That provider ID is already assigned to another employee.',
  INVALID_EXTERNAL_ID: 'That provider ID has unsupported characters.',
  DOWNLOAD_REQUIRED: 'Download the file first, then mark it as submitted.',
  ACK_REQUIRED: 'Confirm that you understand voiding does not recall data already sent to the provider.',
  IN_PROGRESS: 'This export is being sent right now. Try again in a minute.',
  PAYROLL_EXPORT_LOCK: 'These items were already exported. Void the export first to include them in a Vireek pay run.',
};

/** Turns a PostgREST / edge error into one sentence a person can act on. */
export function payrollErrorMessage(e: unknown, fallback: string): string {
  const raw = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : '';
  if (!raw) return fallback;
  for (const [code, msg] of Object.entries(CODE_MESSAGES)) if (raw.includes(code)) return msg;
  if (/not authorized|permission denied/i.test(raw)) return 'You don’t have permission to manage payroll connectors.';
  return raw.length > 240 ? fallback : raw;
}

async function readFnError(error: unknown, fallback: string): Promise<string> {
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
  const { data, error } = await supabase.functions.invoke('payroll-connector', { body });
  if (error) throw new Error(await readFnError(error, fallback));
  if (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string') {
    throw new Error((data as { error: string }).error);
  }
  return data as T;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(payrollErrorMessage(error, 'Request failed.'));
  return data as T;
}

// ------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------

const CONN_COLS = 'id, provider, mode, status, environment, external_company_id, company_name, settings, meta, last_exported_at, last_error, created_at';

export async function listConnections(ownerId: string): Promise<PayrollConnection[]> {
  const { data, error } = await supabase.from('payroll_connections').select(CONN_COLS).eq('user_id', ownerId);
  if (error) throw new Error(payrollErrorMessage(error, 'Could not load connections.'));
  return (data ?? []) as PayrollConnection[];
}

const EXPORT_COLS =
  'id, connection_id, provider, delivery, period_start, period_end, status, totals, warnings, file_name, file_sha256, downloaded_at, external_ref, last_error, delivered_at, void_reason, created_at';

export async function listExports(ownerId: string, limit = 50): Promise<PayrollExport[]> {
  const { data, error } = await supabase
    .from('payroll_exports')
    .select(EXPORT_COLS)
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(payrollErrorMessage(error, 'Could not load export history.'));
  return (data ?? []) as PayrollExport[];
}

export async function getPreview(provider: PayrollProvider, start: string, end: string): Promise<ExportPreview> {
  const p = await rpc<ExportPreview>('get_payroll_export_preview', { p_provider: provider, p_start: start, p_end: end });
  return { ...p, lines: (p.lines ?? []).map((l) => ({ ...(l as PreviewLine), ...normalizeLine(l as unknown as Record<string, unknown>), flags: l.flags ?? [] })) };
}

export async function getExportDetail(id: string): Promise<ExportDetail> {
  const d = await rpc<ExportDetail>('get_payroll_export_detail', { p_id: id });
  return {
    ...d,
    lines: (d.lines ?? []).map((l) => ({ ...(l as ExportDetailLine), ...normalizeLine(l as unknown as Record<string, unknown>) })),
    events: d.events ?? [],
  };
}

export const getMapping = (connectionId: string) => rpc<MappingRow[]>('get_payroll_mapping', { p_connection_id: connectionId });

// ------------------------------------------------------------------
// Writes (RPC)
// ------------------------------------------------------------------

export const saveConnection = (provider: PayrollProvider, settings: ConnectorSettings) =>
  rpc<string>('save_payroll_connection', { p_provider: provider, p_settings: settings });

export const setEmployeeLink = (connectionId: string, employeeId: string, externalId: string, externalJobId?: string | null) =>
  rpc<null>('set_payroll_employee_link', { p_connection_id: connectionId, p_employee_id: employeeId, p_external_id: externalId, p_external_job_id: externalJobId ?? null });

export const setEmployeeLinks = (connectionId: string, links: SuggestedLink[]) =>
  rpc<number>('set_payroll_employee_links', { p_connection_id: connectionId, p_links: links });

/** The idempotency key makes a double click (or a retry after a flaky network) return the same export. */
export const createExport = (provider: PayrollProvider, start: string, end: string, delivery: DeliveryMode, idempotencyKey: string) =>
  rpc<string>('create_payroll_export', { p_provider: provider, p_start: start, p_end: end, p_delivery: delivery, p_idempotency_key: idempotencyKey });

export const voidExport = (id: string, reason: string, acknowledge: boolean) =>
  rpc<null>('void_payroll_export', { p_id: id, p_reason: reason, p_acknowledge_provider: acknowledge });

export const markSubmitted = (id: string, reference: string) => rpc<null>('mark_payroll_export_submitted', { p_id: id, p_reference: reference || null });

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

// ------------------------------------------------------------------
// Files
// ------------------------------------------------------------------

/** Renders the saved export exactly as the server stored it, downloads it and records its checksum. */
export async function downloadExportFile(detail: ExportDetail, connection: PayrollConnection | undefined): Promise<void> {
  const provider = detail.export.provider;
  const parsed = validateSettings(provider, connection?.settings ?? {});
  const settings = parsed.ok ? parsed.settings : defaultSettings(provider);
  const file = renderExportFile(detail.lines, { provider, settings, periodStart: detail.export.period_start, periodEnd: detail.export.period_end });
  const blob = new Blob([file.content], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  await rpc<null>('record_payroll_export_download', { p_id: detail.export.id, p_file_name: file.fileName, p_sha256: await sha256Hex(file.content) });
}

// ------------------------------------------------------------------
// Gusto (edge function)
// ------------------------------------------------------------------

export async function startGustoOAuth(): Promise<string> {
  const r = await invoke<{ url?: string }>({ action: 'oauth_start', provider: 'gusto' }, 'Could not connect Gusto.');
  if (!r.url) throw new Error('Could not connect Gusto.');
  return r.url;
}
export const selectGustoCompany = (connectionId: string, companyId: string) =>
  invoke<{ ok: true }>({ action: 'select_company', connection_id: connectionId, company_id: companyId }, 'Could not save the company.');
export const listGustoEmployees = (connectionId: string) =>
  invoke<{ employees: GustoEmployeeRow[] }>({ action: 'list_employees', connection_id: connectionId }, 'Could not load Gusto employees.');
export const disconnectGusto = (connectionId: string) =>
  invoke<{ ok: true }>({ action: 'disconnect', connection_id: connectionId }, 'Could not disconnect Gusto.');
export const deliverToGusto = (exportId: string, overwriteExisting: boolean) =>
  invoke<DeliveryResult>({ action: 'deliver', export_id: exportId, overwrite_existing: overwriteExisting }, 'Could not send the export to Gusto.');

// ------------------------------------------------------------------
// Formatting (UI)
// ------------------------------------------------------------------

export const money = (cents: number): string => `$${Number(formatAmount(cents)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const hours = (h: number): string => Number(h.toFixed(3)).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 });

export const EXPORT_STATUS_LABEL: Record<ExportStatus, string> = {
  ready: 'Ready',
  delivering: 'Sending…',
  delivered: 'Delivered',
  partial: 'Partly delivered',
  failed: 'Failed',
  void: 'Void',
};
export const LINE_STATUS_LABEL: Record<LineStatus, string> = {
  pending: 'Waiting',
  sent: 'Sent',
  unchanged: 'Already there',
  conflict: 'Left untouched',
  error: 'Failed',
};
