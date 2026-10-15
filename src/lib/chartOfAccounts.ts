import { supabase } from '@/lib/supabase';
import { ensureChartOfAccounts, type AccountType } from '@/lib/accounting';

/**
 * Chart of Accounts management — client library.
 *
 * Wraps supabase/migrations/20270410000000_chart_of_accounts_management.sql.
 * Every write goes through a SECURITY DEFINER RPC that re-checks the
 * permission and the ledger-safety rules server-side; the validation in
 * this file only exists to give instant, field-level feedback.
 */

export type NormalBalance = 'debit' | 'credit';

export interface CoaAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  normal_balance: NormalBalance;
  is_system: boolean;
  is_active: boolean;
  parent_account_id: string | null;
  description: string | null;
  line_count: number;
  balance_cents: number;
  mapping_count: number;
}

export interface AccountRow {
  account: CoaAccount;
  depth: number;
}

export interface AccountDraft {
  code: string;
  name: string;
  type: AccountType;
  contra: boolean;
  parentId: string;
  description: string;
}

export type DraftErrors = Partial<Record<'code' | 'name' | 'parent' | 'description', string>>;

export interface ServiceMappingRow {
  service_name: string;
  in_price_book: boolean;
  job_count: number;
  mapping_id: string | null;
  revenue_account_id: string | null;
  notes: string | null;
}

export interface PeriodRow {
  period_start: string;
  period_end: string;
  status: 'open' | 'closed';
  closed_at: string | null;
  entry_count: number;
}

export interface AuditEvent {
  id: string;
  actor_id: string | null;
  entity_type: 'account' | 'service_mapping' | 'period';
  entity_id: string | null;
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export const ACCOUNT_TYPES: {
  type: AccountType;
  label: string;
  natural: NormalBalance;
  range: [number, number];
  hint: string;
}[] = [
  { type: 'asset', label: 'Asset', natural: 'debit', range: [1000, 1999], hint: 'What the business owns: cash, receivables, vehicles, inventory.' },
  { type: 'liability', label: 'Liability', natural: 'credit', range: [2000, 2999], hint: 'What the business owes: payables, sales tax, loans, cards.' },
  { type: 'equity', label: 'Equity', natural: 'credit', range: [3000, 3999], hint: "Owner's stake: capital, draws, retained earnings." },
  { type: 'revenue', label: 'Revenue', natural: 'credit', range: [4000, 4999], hint: 'Income from services, parts and other sources.' },
  { type: 'expense', label: 'Expense', natural: 'debit', range: [5000, 9999], hint: 'Costs of doing business: parts, payroll, fuel, rent.' },
];

export const CODE_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{1,15}$/;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function typeMeta(type: AccountType) {
  return ACCOUNT_TYPES.find((t) => t.type === type) ?? ACCOUNT_TYPES[0];
}

export function naturalBalance(type: AccountType, contra = false): NormalBalance {
  const natural = typeMeta(type).natural;
  if (!contra) return natural;
  return natural === 'debit' ? 'credit' : 'debit';
}

export function isContra(a: Pick<CoaAccount, 'type' | 'normal_balance'>): boolean {
  return a.normal_balance !== typeMeta(a.type).natural;
}

/** Signed money string that, unlike formatCents, puts the minus sign first. */
export function money(cents: number): string {
  const abs = Math.abs(cents) / 100;
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${cents < 0 ? '-' : ''}$${s}`;
}

export function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message || 'Something went wrong.';
  }
  return 'Something went wrong.';
}

const byCode = (a: CoaAccount, b: CoaAccount) => a.code.localeCompare(b.code, undefined, { numeric: true });

/**
 * Depth-first, code-ordered tree flattening. An account whose parent is
 * missing from the list is treated as a root, and a visited-set makes the
 * walk safe even if bad data ever contained a cycle.
 */
export function buildAccountRows(accounts: CoaAccount[]): AccountRow[] {
  const ids = new Set(accounts.map((a) => a.id));
  const children = new Map<string, CoaAccount[]>();
  const roots: CoaAccount[] = [];
  for (const a of accounts) {
    if (a.parent_account_id && ids.has(a.parent_account_id) && a.parent_account_id !== a.id) {
      const list = children.get(a.parent_account_id) ?? [];
      list.push(a);
      children.set(a.parent_account_id, list);
    } else {
      roots.push(a);
    }
  }
  const out: AccountRow[] = [];
  const seen = new Set<string>();
  const walk = (a: CoaAccount, depth: number) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    out.push({ account: a, depth });
    for (const c of (children.get(a.id) ?? []).sort(byCode)) walk(c, depth + 1);
  };
  for (const r of roots.sort(byCode)) walk(r, 0);
  // Anything unreachable (a pure cycle) is still shown rather than silently dropped.
  for (const a of [...accounts].sort(byCode)) walk(a, 0);
  return out;
}

export function filterRows(
  rows: AccountRow[],
  opts: { query: string; type: AccountType | 'all'; showInactive: boolean },
): AccountRow[] {
  const q = opts.query.trim().toLowerCase();
  return rows.filter(({ account: a }) => {
    if (!opts.showInactive && !a.is_active) return false;
    if (opts.type !== 'all' && a.type !== opts.type) return false;
    if (!q) return true;
    return a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q);
  });
}

/** The account itself plus everything beneath it — used to keep a parent picker cycle-free. */
export function descendantIds(accounts: CoaAccount[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of accounts) {
      if (a.parent_account_id && out.has(a.parent_account_id) && !out.has(a.id)) {
        out.add(a.id);
        grew = true;
      }
    }
  }
  return out;
}

export function validateAccountDraft(draft: AccountDraft, accounts: CoaAccount[], editingId: string | null): DraftErrors {
  const errors: DraftErrors = {};
  const code = draft.code.trim();
  const name = draft.name.trim();

  if (!code) errors.code = 'Enter an account code.';
  else if (!CODE_PATTERN.test(code)) errors.code = 'Use 2–16 letters, numbers, dots or dashes.';
  else if (accounts.some((a) => a.id !== editingId && a.code.toLowerCase() === code.toLowerCase())) {
    errors.code = 'That code is already in use.';
  }

  if (!name) errors.name = 'Enter an account name.';
  else if (name.length > 120) errors.name = 'Keep the name under 120 characters.';

  if (draft.description.trim().length > 500) errors.description = 'Keep the description under 500 characters.';

  if (draft.parentId) {
    const parent = accounts.find((a) => a.id === draft.parentId);
    if (!parent) errors.parent = 'Parent account not found.';
    else if (parent.type !== draft.type) errors.parent = 'A sub-account must have the same type as its parent.';
    else if (editingId && descendantIds(accounts, editingId).has(parent.id)) errors.parent = 'That would create a loop in the tree.';
  }
  return errors;
}

/** Next free code inside the type's conventional range, stepping by 10 for room to insert later. */
export function suggestNextCode(accounts: CoaAccount[], type: AccountType): string {
  const [lo, hi] = typeMeta(type).range;
  const used = new Set(accounts.map((a) => a.code));
  const inRange = accounts
    .filter((a) => /^\d+$/.test(a.code))
    .map((a) => Number(a.code))
    .filter((n) => n >= lo && n <= hi);
  const start = inRange.length ? Math.max(...inRange) : lo - 10;
  for (let n = start + 10; n <= hi; n += 10) if (!used.has(String(n))) return String(n);
  for (let n = lo; n <= hi; n += 1) if (!used.has(String(n))) return String(n);
  return '';
}

export function summarizeAccounts(accounts: CoaAccount[]) {
  const active = accounts.filter((a) => a.is_active);
  return {
    active: active.length,
    inactive: accounts.length - active.length,
    system: accounts.filter((a) => a.is_system).length,
    withActivity: accounts.filter((a) => a.line_count > 0).length,
  };
}

export function countUnmapped(rows: ServiceMappingRow[]): number {
  return rows.filter((r) => !r.mapping_id).length;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'YYYY-MM-DD' -> 'March' without any timezone drift. */
export function monthName(isoDate: string): string {
  const m = Number(isoDate.slice(5, 7));
  return MONTHS[m - 1] ?? isoDate;
}

/** Latest fully-closed month among the rows, e.g. "March 2027", or null when nothing is closed. */
export function lockedThroughLabel(rows: PeriodRow[]): string | null {
  const closed = rows.filter((r) => r.status === 'closed').map((r) => r.period_start).sort();
  const last = closed[closed.length - 1];
  return last ? `${monthName(last)} ${last.slice(0, 4)}` : null;
}

export function describeAuditEvent(e: AuditEvent): string {
  const d = e.detail ?? {};
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  switch (`${e.entity_type}:${e.action}`) {
    case 'account:created':
      return `Created account ${str('code')} · ${str('name')}`;
    case 'account:updated': {
      const after = (d.after ?? {}) as Record<string, unknown>;
      return `Edited account ${String(after.code ?? '')} · ${String(after.name ?? '')}`;
    }
    case 'account:deactivated':
      return `Deactivated account ${str('code')} · ${str('name')}`;
    case 'account:reactivated':
      return `Reactivated account ${str('code')} · ${str('name')}`;
    case 'service_mapping:mapped':
      return `Mapped “${str('service')}” to ${str('account_code')} · ${str('account_name')}`;
    case 'service_mapping:unmapped':
      return `Removed mapping for “${str('service')}”`;
    case 'period:closed':
      return `Closed ${monthName(str('period_start'))} ${str('period_start').slice(0, 4)}`;
    case 'period:reopened':
      return `Reopened ${monthName(str('period_start'))} ${str('period_start').slice(0, 4)}${str('reason') ? ` — ${str('reason')}` : ''}`;
    case 'period:locked_through':
      return `Locked ${String(d.months_closed ?? 0)} month(s) through ${monthName(str('through'))} ${str('through').slice(0, 4)}`;
    default:
      return `${e.entity_type.replace('_', ' ')} ${e.action.replace('_', ' ')}`;
  }
}

// ---------------------------------------------------------------------------
// API (all throw on failure)
// ---------------------------------------------------------------------------

export async function seedStandardChart(): Promise<void> {
  await ensureChartOfAccounts();
}

export async function fetchAccountsOverview(): Promise<CoaAccount[]> {
  const { data, error } = await supabase.rpc('get_chart_of_accounts_overview');
  if (error) throw error;
  return ((data ?? []) as CoaAccount[]).map((a) => ({
    ...a,
    line_count: Number(a.line_count),
    balance_cents: Number(a.balance_cents),
    mapping_count: Number(a.mapping_count),
  }));
}

export async function createAccount(d: AccountDraft): Promise<string> {
  const { data, error } = await supabase.rpc('create_chart_account', {
    p_code: d.code.trim(),
    p_name: d.name.trim(),
    p_type: d.type,
    p_parent_account_id: d.parentId || null,
    p_description: d.description.trim() || null,
    p_contra: d.contra,
  });
  if (error) throw error;
  return data as string;
}

export async function updateAccount(id: string, d: AccountDraft): Promise<void> {
  const { error } = await supabase.rpc('update_chart_account', {
    p_id: id,
    p_code: d.code.trim(),
    p_name: d.name.trim(),
    p_type: d.type,
    p_contra: d.contra,
    p_parent_account_id: d.parentId || null,
    p_description: d.description.trim() || null,
  });
  if (error) throw error;
}

export async function setAccountActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_chart_account_active', { p_id: id, p_active: active });
  if (error) throw error;
}

export async function fetchServiceMappings(): Promise<ServiceMappingRow[]> {
  const { data, error } = await supabase.rpc('get_service_mapping_overview');
  if (error) throw error;
  return ((data ?? []) as ServiceMappingRow[]).map((r) => ({ ...r, job_count: Number(r.job_count) }));
}

export async function mapService(serviceName: string, revenueAccountId: string, notes?: string): Promise<string> {
  const { data, error } = await supabase.rpc('upsert_service_account_mapping', {
    p_service_name: serviceName,
    p_revenue_account_id: revenueAccountId,
    p_notes: notes?.trim() || null,
  });
  if (error) throw error;
  return data as string;
}

export async function unmapService(mappingId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_service_account_mapping', { p_id: mappingId });
  if (error) throw error;
}

export async function fetchPeriods(year: number): Promise<PeriodRow[]> {
  const { data, error } = await supabase.rpc('get_accounting_periods_overview', { p_year: year });
  if (error) throw error;
  return ((data ?? []) as PeriodRow[]).map((r) => ({ ...r, entry_count: Number(r.entry_count) }));
}

export async function setPeriodStatus(periodStart: string, status: 'open' | 'closed', reason?: string): Promise<void> {
  const { error } = await supabase.rpc('set_accounting_period_status', {
    p_period_start: periodStart,
    p_status: status,
    p_reason: reason?.trim() || null,
  });
  if (error) throw error;
}

export async function lockPeriodsThrough(throughMonth: string, reason?: string): Promise<number> {
  const { data, error } = await supabase.rpc('lock_accounting_periods_through', {
    p_through_month: throughMonth,
    p_reason: reason?.trim() || null,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/** accountOwnerId = owner's profile id, or a team member's account_owner_id. */
export async function fetchAuditEvents(accountOwnerId: string, limit = 50): Promise<AuditEvent[]> {
  const { data, error } = await supabase
    .from('accounting_audit_events')
    .select('id, actor_id, entity_type, entity_id, action, detail, created_at')
    .eq('user_id', accountOwnerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as AuditEvent[];
}
