import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  ACCT_CONFLICT_RULES,
  ACCT_DIRECTIONS,
  ACCT_ENTITIES,
  ACCT_PROVIDERS,
  CONFLICT_RULE_META,
  DIRECTION_META,
  ENTITY_META,
  PROVIDER_META,
  defaultSettings,
  effectiveDirection,
  fieldLabel,
  fieldsFor,
  validateSettings,
  type AcctConflictRule,
  type AcctDirection,
  type AcctEntity,
  type AcctProvider,
  type AcctSettings,
  type CanonValue,
  type OptionRow,
  type SyncStats,
} from '../../supabase/functions/_shared/accounting/core';

// Provider names, field catalogs, defaults, direction rules and settings validation come from the SAME
// file the edge functions use, so the mapping UI can never offer something the server would reject.
export {
  ACCT_CONFLICT_RULES,
  ACCT_DIRECTIONS,
  ACCT_ENTITIES,
  ACCT_PROVIDERS,
  CONFLICT_RULE_META,
  DIRECTION_META,
  ENTITY_META,
  PROVIDER_META,
  defaultSettings,
  effectiveDirection,
  fieldLabel,
  fieldsFor,
  validateSettings,
};
export type { AcctConflictRule, AcctDirection, AcctEntity, AcctProvider, AcctSettings, OptionRow, SyncStats };

/**
 * Accounting / General Ledger — dashboard client library.
 *
 * Thin wrapper over the tables/RPCs in
 * supabase/migrations/20261203000001_accounting_general_ledger.sql.
 * All writes go through SECURITY DEFINER RPCs (post_journal_entry and
 * the AR/AP helpers built on top of it) so every posted entry is
 * guaranteed to balance and closed periods can't be edited.
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface ChartOfAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  normal_balance: 'debit' | 'credit';
  is_system: boolean;
  is_active: boolean;
}

export interface JournalEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  memo: string | null;
  source_type: string;
  source_id: string | null;
  status: 'posted' | 'void';
  created_at: string;
}

export interface ArInvoice {
  id: string;
  invoice_number: string;
  customer_id: string | null;
  job_id: string | null;
  status: 'draft' | 'sent' | 'partially_paid' | 'paid' | 'overdue' | 'void';
  issue_date: string;
  due_date: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  amount_paid_cents: number;
}

export interface ApBill {
  id: string;
  bill_number: string;
  vendor_id: string | null;
  purchase_order_id: string | null;
  status: 'draft' | 'approved' | 'partially_paid' | 'paid' | 'void';
  bill_date: string;
  due_date: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  amount_paid_cents: number;
}

export interface TrialBalanceRow {
  account_code: string;
  account_name: string;
  type: AccountType;
  debit_cents: number;
  credit_cents: number;
}

export interface ProfitAndLossRow {
  account_code: string;
  account_name: string;
  type: AccountType;
  amount_cents: number;
}

export interface BalanceSheetRow {
  account_code: string;
  account_name: string;
  type: AccountType;
  balance_cents: number;
}

export interface AgingRow {
  due_date: string;
  days_overdue: number;
  bucket: 'current' | '1-30' | '31-60' | '61-90' | '90+';
  balance_cents: number;
  invoice_id?: string;
  invoice_number?: string;
  customer_name?: string;
  bill_id?: string;
  bill_number?: string;
  vendor_name?: string;
}

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '$0.00';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function ensureChartOfAccounts(): Promise<void> {
  const { error } = await supabase.rpc('ensure_default_chart_of_accounts');
  if (error) throw error;
}

export async function fetchChartOfAccounts(): Promise<ChartOfAccount[]> {
  const { data, error } = await supabase.from('chart_of_accounts').select('*').eq('is_active', true).order('code');
  if (error) throw error;
  return (data as ChartOfAccount[]) ?? [];
}

export async function fetchJournalEntries(limit = 50): Promise<JournalEntry[]> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('*')
    .order('entry_date', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as JournalEntry[]) ?? [];
}

export async function fetchArInvoices(): Promise<ArInvoice[]> {
  const { data, error } = await supabase.from('ar_invoices').select('*').order('issue_date', { ascending: false });
  if (error) throw error;
  return (data as ArInvoice[]) ?? [];
}

export async function fetchApBills(): Promise<ApBill[]> {
  const { data, error } = await supabase.from('ap_bills').select('*').order('bill_date', { ascending: false });
  if (error) throw error;
  return (data as ApBill[]) ?? [];
}

export async function createArInvoice(params: {
  customerId: string | null;
  jobId: string | null;
  quoteId: string | null;
  dueDate: string;
  taxCents: number;
  lines: { description: string; amountCents: number; revenueAccountId?: string }[];
}): Promise<string> {
  const { data, error } = await supabase.rpc('create_ar_invoice', {
    p_customer_id: params.customerId,
    p_job_id: params.jobId,
    p_quote_id: params.quoteId,
    p_due_date: params.dueDate,
    p_tax_cents: params.taxCents,
    p_lines: params.lines.map((l) => ({
      description: l.description,
      amount_cents: l.amountCents,
      revenue_account_id: l.revenueAccountId ?? null,
    })),
  });
  if (error) throw error;
  return data as string;
}

export async function recordArPayment(params: {
  invoiceId: string;
  amountCents: number;
  paymentMethod: string;
  depositAccountId?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('record_ar_payment', {
    p_invoice_id: params.invoiceId,
    p_amount_cents: params.amountCents,
    p_payment_method: params.paymentMethod,
    p_deposit_account_id: params.depositAccountId ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function createApBill(params: {
  vendorId: string | null;
  purchaseOrderId: string | null;
  dueDate: string;
  taxCents: number;
  lines: { description: string; amountCents: number; expenseAccountId?: string }[];
}): Promise<string> {
  const { data, error } = await supabase.rpc('create_ap_bill', {
    p_vendor_id: params.vendorId,
    p_purchase_order_id: params.purchaseOrderId,
    p_due_date: params.dueDate,
    p_tax_cents: params.taxCents,
    p_lines: params.lines.map((l) => ({
      description: l.description,
      amount_cents: l.amountCents,
      expense_account_id: l.expenseAccountId ?? null,
    })),
  });
  if (error) throw error;
  return data as string;
}

export async function recordApBillPayment(params: {
  billId: string;
  amountCents: number;
  paymentMethod: string;
  sourceAccountId?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('record_ap_bill_payment', {
    p_bill_id: params.billId,
    p_amount_cents: params.amountCents,
    p_payment_method: params.paymentMethod,
    p_source_account_id: params.sourceAccountId ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function fetchTrialBalance(asOf?: string): Promise<TrialBalanceRow[]> {
  const { data, error } = await supabase.rpc('get_trial_balance', { p_as_of: asOf ?? new Date().toISOString().slice(0, 10) });
  if (error) throw error;
  return (data as TrialBalanceRow[]) ?? [];
}

export async function fetchProfitAndLoss(start: string, end: string): Promise<ProfitAndLossRow[]> {
  const { data, error } = await supabase.rpc('get_profit_and_loss', { p_start: start, p_end: end });
  if (error) throw error;
  return (data as ProfitAndLossRow[]) ?? [];
}

export async function fetchBalanceSheet(asOf?: string): Promise<BalanceSheetRow[]> {
  const { data, error } = await supabase.rpc('get_balance_sheet', { p_as_of: asOf ?? new Date().toISOString().slice(0, 10) });
  if (error) throw error;
  return (data as BalanceSheetRow[]) ?? [];
}

export async function fetchArAging(): Promise<AgingRow[]> {
  const { data, error } = await supabase.rpc('get_ar_aging');
  if (error) throw error;
  return (data as AgingRow[]) ?? [];
}

export async function fetchApAging(): Promise<AgingRow[]> {
  const { data, error } = await supabase.rpc('get_ap_aging');
  if (error) throw error;
  return (data as AgingRow[]) ?? [];
}

// ============================================================
// ACCOUNTING CONNECTORS (Xero, Zoho Books, NetSuite) - client API
//
// The browser never sees OAuth tokens and never writes sync tables. It:
//   - reads connections / runs / log / conflicts (RLS + can_manage_accounting),
//   - asks the acct-* edge functions to connect, sync, save settings, disconnect, resolve.
// ============================================================

export type AcctConnectionStatus = 'connected' | 'error' | 'disconnected';
export type AcctRunStatus = 'running' | 'success' | 'partial' | 'failed';
export type LogAction = 'created' | 'updated' | 'linked' | 'voided' | 'conflict' | 'skipped' | 'error';

export interface AcctConnection {
  id: string;
  user_id: string;
  provider: AcctProvider;
  tenant_id: string;
  region: string | null;
  company_name: string | null;
  status: AcctConnectionStatus;
  settings: unknown;
  auto_sync: boolean;
  last_synced_at: string | null;
  last_error: string | null;
  sync_locked_until: string | null;
  refresh_token_expires_at: string | null;
  created_at: string;
}

export interface AcctRun {
  id: string;
  connection_id: string;
  trigger: 'manual' | 'scheduled' | 'webhook';
  status: AcctRunStatus;
  stats: Partial<SyncStats>;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface AcctLogRow {
  id: string;
  entity: AcctEntity;
  direction: 'to_ext' | 'from_ext' | 'both' | 'none';
  action: LogAction;
  vireek_id: string | null;
  external_id: string | null;
  link_id: string | null;
  message: string | null;
  details: unknown;
  request_ref: string | null;
  created_at: string;
}

export interface AcctConflict {
  link_id: string;
  entity: AcctEntity;
  reason: string | null;
  fields: { field: string; vireek: CanonValue; ext: CanonValue }[];
  at: string | null;
}

/** Live pick-lists from the accounting system, for the default-account / item / tax / subsidiary pickers. */
export interface AcctOptions {
  accounts: OptionRow[];
  items: OptionRow[];
  taxCodes: OptionRow[];
  subsidiaries: OptionRow[];
}

/** Same gate as the nav item, route and every server call (can_manage_accounting). */
export function useCanManageAccounting(): boolean {
  const { isOwner, permissions } = useAuth();
  return isOwner || (permissions.can_edit_business_profile === true && permissions.can_view_billing === true);
}

export function useAcctOwnerId(): string | undefined {
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

/** URL slug of each provider's settings page (/dashboard/accounting/:slug). */
export const PROVIDER_SLUG: Record<AcctProvider, string> = {
  xero: 'xero',
  zoho_books: 'zoho-books',
  netsuite: 'netsuite',
};

export function providerFromSlug(slug: string | undefined): AcctProvider | null {
  if (!slug) return null;
  return ACCT_PROVIDERS.find((p) => PROVIDER_SLUG[p] === slug) ?? null;
}

/** Xero / Zoho: returns the provider's consent-page URL. region = Zoho data centre. */
export async function startOAuth(provider: AcctProvider, region?: string): Promise<string> {
  const fallback = `Could not connect ${PROVIDER_META[provider].label}.`;
  const r = await invoke<{ url?: string }>('acct-oauth-start', { provider, ...(region ? { region } : {}) }, fallback);
  if (!r.url) throw new Error(fallback);
  return r.url;
}

/** NetSuite: machine-to-machine, no redirect. */
export const connectNetSuite = (input: { account_id: string; client_id: string; certificate_id: string }) =>
  invoke<{ ok: true }>(
    'acct-oauth-start',
    { provider: 'netsuite', account_id: input.account_id, client_id: input.client_id, certificate_id: input.certificate_id },
    'Could not connect NetSuite.',
  );

/** Public certificate the customer uploads in NetSuite. */
export const getNetSuiteCertificate = () =>
  invoke<{ certificate: string; algorithm: string }>(
    'acct-oauth-start',
    { provider: 'netsuite', action: 'certificate' },
    'Could not load the NetSuite certificate.',
  );

export const syncNow = (connectionId: string) =>
  invoke<{ run_id: string }>('acct-sync-run', { action: 'run', connection_id: connectionId }, 'Could not start the sync.');

/** Re-read everything (the merge is idempotent). */
export const resyncAll = (connectionId: string) =>
  invoke<{ run_id: string }>('acct-sync-run', { action: 'resync', connection_id: connectionId }, 'Could not start the sync.');

export const saveSettings = (connectionId: string, settings: AcctSettings, autoSync?: boolean) =>
  invoke<{ ok: true; settings: AcctSettings }>(
    'acct-sync-run',
    { action: 'save_settings', connection_id: connectionId, settings, ...(autoSync === undefined ? {} : { auto_sync: autoSync }) },
    'Could not save the settings.',
  );

export const loadOptions = (connectionId: string) =>
  invoke<AcctOptions>('acct-sync-run', { action: 'options', connection_id: connectionId }, 'Could not load the lists from your accounting system.');

export const disconnectAccounting = (connectionId: string) =>
  invoke<{ ok: true }>('acct-sync-run', { action: 'disconnect', connection_id: connectionId }, 'Could not disconnect.');

export const resolveConflict = (linkId: string, winner: 'vireek' | 'ext') =>
  invoke<{ ok: true }>('acct-sync-run', { action: 'resolve_conflict', link_id: linkId, winner }, 'Could not resolve the conflict.');

const CONN_COLS =
  'id, user_id, provider, tenant_id, region, company_name, status, settings, auto_sync, last_synced_at, last_error, sync_locked_until, refresh_token_expires_at, created_at';

/** The account's connection to one provider, or null when it never connected. */
export async function getConnection(ownerId: string, provider: AcctProvider): Promise<AcctConnection | null> {
  const { data, error } = await supabase
    .from('acct_connections')
    .select(CONN_COLS)
    .eq('user_id', ownerId)
    .eq('provider', provider)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as AcctConnection | null;
}

export async function listRuns(connectionId: string, limit = 8): Promise<AcctRun[]> {
  const { data, error } = await supabase
    .from('acct_sync_runs')
    .select('id, connection_id, trigger, status, stats, error, started_at, finished_at')
    .eq('connection_id', connectionId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as AcctRun[];
}

export const LOG_PAGE_SIZE = 50;

export async function listLog(
  connectionId: string,
  opts: { action?: LogAction | 'all'; entity?: AcctEntity | 'all'; before?: string | null } = {},
): Promise<AcctLogRow[]> {
  let q = supabase
    .from('acct_sync_log')
    .select('id, entity, direction, action, vireek_id, external_id, link_id, message, details, request_ref, created_at')
    .eq('connection_id', connectionId);
  if (opts.action && opts.action !== 'all') q = q.eq('action', opts.action);
  if (opts.entity && opts.entity !== 'all') q = q.eq('entity', opts.entity);
  if (opts.before) q = q.lt('created_at', opts.before);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(LOG_PAGE_SIZE);
  if (error) throw error;
  return (data ?? []) as AcctLogRow[];
}

type RawConflictField = { field: string; vireek: CanonValue; crm?: CanonValue; ext?: CanonValue };

/** Open manual conflicts, each enriched with the two competing values from the log. */
export async function listConflicts(connectionId: string): Promise<AcctConflict[]> {
  const { data: links, error } = await supabase
    .from('acct_record_links')
    .select('id, entity, conflict')
    .eq('connection_id', connectionId)
    .not('conflict', 'is', null)
    .limit(50);
  if (error) throw error;
  const rows = (links ?? []) as { id: string; entity: AcctEntity; conflict: { at?: string; reason?: string } | null }[];
  if (!rows.length) return [];

  const { data: logs } = await supabase
    .from('acct_sync_log')
    .select('link_id, details, created_at')
    .eq('connection_id', connectionId)
    .eq('action', 'conflict')
    .in('link_id', rows.map((r) => r.id))
    .order('created_at', { ascending: false })
    .limit(200);
  const latest = new Map<string, RawConflictField[]>();
  for (const l of (logs ?? []) as { link_id: string; details: { conflicts?: RawConflictField[] } | RawConflictField[] | null }[]) {
    if (latest.has(l.link_id) || !l.details) continue;
    const list = Array.isArray(l.details) ? l.details : l.details.conflicts;
    if (Array.isArray(list)) latest.set(l.link_id, list);
  }
  return rows.map((r) => ({
    link_id: r.id,
    entity: r.entity,
    reason: r.conflict?.reason ?? null,
    at: r.conflict?.at ?? null,
    fields: (latest.get(r.id) ?? []).map((c) => ({ field: c.field, vireek: c.vireek, ext: c.ext ?? c.crm ?? null })),
  }));
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

/** Days until the refresh token expires; null when unknown (NetSuite has no refresh token). */
export function refreshDaysLeft(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  return Math.floor((new Date(iso).getTime() - now) / 86_400_000);
}

/** Settings stored on a connection, or safe defaults when the stored value is missing / invalid. */
export function readSettings(provider: AcctProvider, raw: unknown): AcctSettings {
  const v = validateSettings(provider, raw);
  return v.ok ? v.settings : defaultSettings(provider);
}

/** Why the OAuth callback sent the user back (?reason=...). Keep in sync with acct-oauth-callback. */
export const OAUTH_REASONS: Record<string, string> = {
  access_denied: 'You cancelled the sign-in.',
  invalid_state: 'The sign-in link expired. Please try again.',
  missing_code: 'The provider did not return an authorisation code. Please try again.',
  not_configured: 'This connection is not configured on the server yet. Ask your administrator to set the accounting secrets.',
  no_refresh_token: 'The provider did not grant offline access. Please try again.',
  no_organisation: 'No organisation was shared. Connect again and select the organisation to sync.',
  tenant_in_use: 'That organisation is already connected to another Vireek account.',
  exchange_failed: 'Could not finish connecting. Please try again.',
};
