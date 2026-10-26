import { supabase } from '@/lib/supabase';

/**
 * Customer statements of account — dashboard client library.
 *
 * Thin wrapper over supabase/migrations/20271206000000_customer_statements.sql
 * and the `statements-run` edge function. All balance math lives in the database
 * (get_customer_statement / list_statement_accounts) so the dashboard, the emailed
 * statement and the CSV can never disagree. This file holds pure helpers
 * (periods, validation, formatting, CSV) plus the API calls.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgingKey = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';
export type PeriodPreset = 'last_month' | 'this_month' | 'last_30' | 'ytd' | 'custom';
export type PeriodMode = 'previous_month' | 'last_30_days' | 'year_to_date';
export type ScheduleScope = 'all_open' | 'overdue_only' | 'selected';
export type Frequency = 'weekly' | 'monthly';

export interface StatementAccount {
  customer_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  customer_type: string;
  child_count: number;
  invoice_count: number;
  balance_cents: number;
  overdue_cents: number;
  oldest_due: string | null;
  last_sent_at: string | null;
}

export interface StatementLine {
  date: string;
  kind: 'invoice' | 'payment' | 'refund';
  reference: string;
  description: string;
  customer_name: string;
  invoice_number: string | null;
  charge_cents: number;
  credit_cents: number;
  balance_cents: number;
}

export interface StatementOpenInvoice {
  invoice_id: string;
  invoice_number: string | null;
  invoice_token: string;
  customer_name: string;
  invoice_date: string;
  due_date: string | null;
  total_cents: number;
  balance_cents: number;
  days_past_due: number;
  bucket: AgingKey;
}

export interface Statement {
  customer: { id: string; name: string; email: string | null; phone: string | null; address: string | null };
  period_from: string;
  period_to: string;
  consolidated: boolean;
  members: Array<{ id: string; name: string }>;
  opening_cents: number;
  charges_cents: number;
  payments_cents: number;
  refunds_cents: number;
  closing_cents: number;
  lines: StatementLine[];
  open_invoices: StatementOpenInvoice[];
  aging: Record<AgingKey, number>;
}

export interface StatementSchedule {
  id: string;
  name: string;
  scope: ScheduleScope;
  customer_ids: string[];
  period_mode: PeriodMode;
  frequency: Frequency;
  weekday: number;
  month_day: number;
  send_hour: number;
  timezone: string;
  min_balance_cents: number;
  consolidate: boolean;
  is_active: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: 'sent' | 'partial' | 'failed' | 'skipped' | 'empty' | null;
  last_summary: { sent?: number; failed?: number; skipped?: number; total?: number; note?: string; problems?: string[] } | null;
  consecutive_failures: number;
  paused_reason: string | null;
}

export interface StatementSend {
  id: string;
  schedule_id: string | null;
  customer_id: string | null;
  customer_name: string;
  trigger: 'schedule' | 'manual';
  status: 'sent' | 'failed' | 'skipped';
  recipient: string | null;
  period_from: string;
  period_to: string;
  closing_balance_cents: number;
  consolidated: boolean;
  error: string | null;
  sent_by_email: string | null;
  created_at: string;
}

export interface ScheduleDraft {
  id: string | null;
  name: string;
  scope: ScheduleScope;
  customer_ids: string[];
  period_mode: PeriodMode;
  frequency: Frequency;
  weekday: number;
  month_day: number;
  send_hour: number;
  timezone: string;
  min_balance_dollars: string;
  consolidate: boolean;
  is_active: boolean;
}

export const AGING_KEYS: AgingKey[] = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'];
export const AGING_LABELS: Record<AgingKey, string> = {
  current: 'Current', d1_30: '1–30 days', d31_60: '31–60 days', d61_90: '61–90 days', d90_plus: '90+ days',
};
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const PERIOD_MODE_LABELS: Record<PeriodMode, string> = {
  previous_month: 'Previous calendar month', last_30_days: 'Last 30 days', year_to_date: 'Year to date',
};
export const SCOPE_LABELS: Record<ScheduleScope, string> = {
  all_open: 'Every account with a balance', overdue_only: 'Only accounts with overdue invoices', selected: 'Selected customers',
};
export const MAX_SELECTED_CUSTOMERS = 200;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function usd(cents: number): string {
  const n = Number.isFinite(cents) ? cents : 0;
  const s = (Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}$${s}`;
}

export function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message || 'Something went wrong.';
  }
  return 'Something went wrong.';
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const isoUtc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/** Local calendar date (YYYY-MM-DD) for `now`, not UTC — so "today" is the user's today. */
export function isoToday(now = new Date()): string {
  return isoUtc(now.getFullYear(), now.getMonth(), now.getDate());
}

export function periodForPreset(preset: Exclude<PeriodPreset, 'custom'>, now = new Date()): { from: string; to: string } {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  switch (preset) {
    case 'last_month': return { from: isoUtc(y, m - 1, 1), to: isoUtc(y, m, 0) };
    case 'this_month': return { from: isoUtc(y, m, 1), to: isoUtc(y, m, d) };
    case 'ytd': return { from: isoUtc(y, 0, 1), to: isoUtc(y, m, d) };
    default: return { from: isoUtc(y, m, d - 29), to: isoUtc(y, m, d) };
  }
}

export function validatePeriod(from: string, to: string): string | null {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from) || !re.test(to)) return 'Choose a start and end date.';
  if (from > to) return 'The start date must be on or before the end date.';
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > 1100) return 'A statement can cover at most 3 years.';
  return null;
}

export function agingRows(aging: Record<AgingKey, number>): Array<{ key: AgingKey; label: string; cents: number; share: number }> {
  const total = AGING_KEYS.reduce((s, k) => s + (aging[k] || 0), 0);
  return AGING_KEYS.map((key) => ({
    key, label: AGING_LABELS[key], cents: aging[key] || 0, share: total > 0 ? (aging[key] || 0) / total : 0,
  }));
}

export const overdueOf = (aging: Record<AgingKey, number>): number =>
  (aging.d1_30 || 0) + (aging.d31_60 || 0) + (aging.d61_90 || 0) + (aging.d90_plus || 0);

export type AccountFilter = 'all' | 'balance' | 'overdue';

export function filterAccounts(accounts: StatementAccount[], query: string, filter: AccountFilter): StatementAccount[] {
  const q = query.trim().toLowerCase();
  return accounts.filter((a) => {
    if (filter === 'balance' && a.balance_cents <= 0) return false;
    if (filter === 'overdue' && a.overdue_cents <= 0) return false;
    if (!q) return true;
    return a.name.toLowerCase().includes(q) || (a.email ?? '').toLowerCase().includes(q) || (a.phone ?? '').includes(q);
  });
}

export function summarizeAccounts(accounts: StatementAccount[]) {
  return {
    outstanding: accounts.reduce((s, a) => s + Math.max(0, a.balance_cents), 0),
    overdue: accounts.reduce((s, a) => s + Math.max(0, a.overdue_cents), 0),
    withBalance: accounts.filter((a) => a.balance_cents > 0).length,
    consolidated: accounts.filter((a) => a.child_count > 0).length,
  };
}

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
const ordinal = (n: number) => {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
};

export function describeSchedule(s: Pick<StatementSchedule, 'frequency' | 'weekday' | 'month_day' | 'send_hour' | 'timezone'>): string {
  const when = s.frequency === 'weekly' ? `Every ${WEEKDAYS[s.weekday] ?? 'Monday'}` : `Monthly on the ${ordinal(s.month_day)}`;
  return `${when} at ${hourLabel(s.send_hour)} (${s.timezone})`;
}

export function emptyDraft(timezone: string): ScheduleDraft {
  return {
    id: null, name: '', scope: 'all_open', customer_ids: [], period_mode: 'previous_month', frequency: 'monthly',
    weekday: 1, month_day: 1, send_hour: 8, timezone, min_balance_dollars: '1.00', consolidate: true, is_active: true,
  };
}

export function draftFromSchedule(s: StatementSchedule): ScheduleDraft {
  return {
    id: s.id, name: s.name, scope: s.scope, customer_ids: s.customer_ids, period_mode: s.period_mode, frequency: s.frequency,
    weekday: s.weekday, month_day: s.month_day, send_hour: s.send_hour, timezone: s.timezone,
    min_balance_dollars: (s.min_balance_cents / 100).toFixed(2), consolidate: s.consolidate, is_active: s.is_active,
  };
}

export function dollarsToCents(input: string): number | null {
  const t = input.trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export function validateScheduleDraft(d: ScheduleDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (d.name.trim().length < 1) e.name = 'Give this schedule a name.';
  else if (d.name.trim().length > 80) e.name = 'Keep the name under 80 characters.';
  if (d.scope === 'selected') {
    if (d.customer_ids.length === 0) e.customers = 'Pick at least one customer.';
    else if (d.customer_ids.length > MAX_SELECTED_CUSTOMERS) e.customers = `Pick at most ${MAX_SELECTED_CUSTOMERS} customers.`;
  }
  if (dollarsToCents(d.min_balance_dollars) === null) e.min_balance = 'Enter a dollar amount like 25.00.';
  if (d.frequency === 'monthly' && (d.month_day < 1 || d.month_day > 28)) e.month_day = 'Choose a day from 1 to 28.';
  if (d.send_hour < 0 || d.send_hour > 23) e.send_hour = 'Choose an hour.';
  if (!d.timezone) e.timezone = 'Choose a timezone.';
  return e;
}

export function defaultTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

export function timezoneOptions(current: string): string[] {
  let zones: string[] = [];
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    zones = fn ? fn('timeZone') : [];
  } catch { zones = []; }
  if (zones.length === 0) zones = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin'];
  return zones.includes(current) ? zones : [current, ...zones];
}

export function statusTone(status: string | null): string {
  switch (status) {
    case 'sent': return 'bg-success-500/10 text-success-500';
    case 'partial': return 'bg-warning-500/10 text-warning-500';
    case 'failed': return 'bg-danger/10 text-danger';
    default: return 'bg-bg-tertiary text-text-secondary';
  }
}

/** Spreadsheet formula injection guard: a cell starting with = + - @ is prefixed with an apostrophe. */
function csvCell(v: string | number): string {
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function statementToCsv(st: Statement): string {
  const money = (c: number) => (c / 100).toFixed(2);
  const rows: Array<Array<string | number>> = [
    ['Statement', st.customer.name], ['Period', `${st.period_from} to ${st.period_to}`], [],
    ['Opening balance', money(st.opening_cents)], ['Charges', money(st.charges_cents)], ['Payments', money(st.payments_cents)],
    ['Refunds', money(st.refunds_cents)], ['Closing balance', money(st.closing_cents)], [],
    ['Date', 'Type', 'Account', 'Description', 'Charges', 'Credits', 'Balance'],
    ...st.lines.map((l) => [l.date, l.kind, l.customer_name, l.description, money(l.charge_cents), money(l.credit_cents), money(l.balance_cents)]),
  ];
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function statementFileName(st: Statement): string {
  const slug = st.customer.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'customer';
  return `statement-${slug}-${st.period_from}-to-${st.period_to}.csv`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function fetchAccounts(asOf?: string): Promise<StatementAccount[]> {
  const { data, error } = await supabase.rpc('list_statement_accounts', { p_as_of: asOf ?? null });
  if (error) throw error;
  return (data ?? []) as StatementAccount[];
}

export async function fetchStatement(customerId: string, from: string, to: string, consolidate: boolean): Promise<Statement> {
  const { data, error } = await supabase.rpc('get_customer_statement', {
    p_customer_id: customerId, p_from: from, p_to: to, p_consolidate: consolidate,
  });
  if (error) throw error;
  return data as Statement;
}

export async function fetchSchedules(): Promise<StatementSchedule[]> {
  const { data, error } = await supabase.from('statement_schedules').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as StatementSchedule[];
}

export const SENDS_PAGE_SIZE = 50;

export async function fetchSends(offset = 0): Promise<StatementSend[]> {
  const { data, error } = await supabase.from('statement_sends').select('*')
    .order('created_at', { ascending: false }).range(offset, offset + SENDS_PAGE_SIZE - 1);
  if (error) throw error;
  return (data ?? []) as StatementSend[];
}

export async function saveSchedule(d: ScheduleDraft): Promise<string> {
  const cents = dollarsToCents(d.min_balance_dollars);
  if (cents === null) throw new Error('Enter a valid minimum balance.');
  const { data, error } = await supabase.rpc('save_statement_schedule', {
    p_id: d.id, p_name: d.name.trim(), p_scope: d.scope, p_customer_ids: d.scope === 'selected' ? d.customer_ids : [],
    p_period_mode: d.period_mode, p_frequency: d.frequency, p_weekday: d.weekday, p_month_day: d.month_day,
    p_send_hour: d.send_hour, p_timezone: d.timezone, p_min_balance_cents: cents, p_consolidate: d.consolidate, p_is_active: d.is_active,
  });
  if (error) throw error;
  return data as string;
}

export async function setScheduleActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_statement_schedule_active', { p_id: id, p_active: active });
  if (error) throw error;
}

export async function deleteSchedule(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_statement_schedule', { p_id: id });
  if (error) throw error;
}

export async function setBillTo(customerId: string, payerId: string | null): Promise<void> {
  const { error } = await supabase.rpc('set_statement_bill_to', { p_customer_id: customerId, p_payer_id: payerId });
  if (error) throw error;
}

export async function searchCustomers(query: string): Promise<Array<{ id: string; name: string; email: string | null; bill_to_customer_id: string | null }>> {
  const q = query.trim().replace(/[\\%_,()]/g, ' ').slice(0, 60);
  if (q.length < 2) return [];
  const { data, error } = await supabase.from('customers').select('id, name, email, bill_to_customer_id')
    .ilike('name', `%${q}%`).order('name').limit(8);
  if (error) throw error;
  return data ?? [];
}

async function invokeStatements(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('statements-run', { body });
  if (error) {
    // functions.invoke hides the JSON error body on non-2xx — recover the server's message when present.
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const j = await ctx.json();
        if (j?.error) throw new Error(String(j.error));
      } catch (inner) {
        if (inner instanceof Error && inner.message) throw inner;
      }
    }
    throw error;
  }
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: unknown }).error) throw new Error(String((data as { error: unknown }).error));
  return (data ?? {}) as Record<string, unknown>;
}

export async function sendStatementNow(args: { customerId: string; from: string; to: string; consolidate: boolean; recipient?: string }) {
  return invokeStatements({
    action: 'send_now', customer_id: args.customerId, period_from: args.from, period_to: args.to,
    consolidate: args.consolidate, ...(args.recipient ? { recipient: args.recipient } : {}),
  });
}

export async function runScheduleNow(scheduleId: string) {
  return invokeStatements({ action: 'run_schedule', schedule_id: scheduleId });
}

export async function fetchCustomerNames(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const { data, error } = await supabase.from('customers').select('id, name').in('id', ids.slice(0, 200));
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((c: { id: string; name: string }) => [c.id, c.name]));
}
