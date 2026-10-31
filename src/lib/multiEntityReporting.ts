import { supabase } from '@/lib/supabase';

/**
 * Multi-entity reporting — dashboard client library.
 *
 * Thin wrapper over supabase/migrations/20280101000000_multi_entity_reporting.sql.
 * All money is integer cents. The report RPC returns one row per
 * (entity, revenue/expense account) with three numbers:
 *   gross_cents         what that entity booked (its own books)
 *   intercompany_cents  the part that came from intercompany entries
 *   eliminated_cents    the part removed in the combined view
 * The combined view is computed here, so toggling elimination needs no refetch.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PnlType = 'revenue' | 'expense';

export interface ReportingEntity {
  entity_id: string;
  entity_code: string;
  entity_name: string;
  is_default: boolean;
  is_active: boolean;
  entry_count: number;
  created_at: string;
}

export interface MultiEntityPnlRow {
  entity_id: string;
  entity_code: string;
  entity_name: string;
  account_code: string;
  account_name: string;
  type: PnlType;
  gross_cents: number;
  intercompany_cents: number;
  eliminated_cents: number;
}

export interface PnlLine {
  account_code: string;
  account_name: string;
  type: PnlType;
  gross_cents: number;
  intercompany_cents: number;
  eliminated_cents: number;
  /** gross - eliminated: the number shown in the statement. */
  amount_cents: number;
}

export interface PnlTotals {
  revenue_cents: number;
  expense_cents: number;
  net_cents: number;
  /** Net / revenue as a percentage, or null when there is no revenue. */
  margin_pct: number | null;
  intercompany_revenue_cents: number;
  intercompany_expense_cents: number;
  eliminated_revenue_cents: number;
  eliminated_expense_cents: number;
}

export interface PnlStatement {
  revenue: PnlLine[];
  expenses: PnlLine[];
  totals: PnlTotals;
}

export interface EntitySummary {
  entity: ReportingEntity;
  totals: PnlTotals;
  /** This entity's share of all entities' gross revenue (0-100), or null when there is none. */
  revenue_share_pct: number | null;
}

export interface EliminationCheck {
  eliminated_revenue_cents: number;
  eliminated_expense_cents: number;
  mismatch_cents: number;
  balanced: boolean;
}

export interface AccessRow {
  entity_id: string;
  entity_code: string;
  entity_name: string;
  member_user_id: string;
  member_name: string | null;
  member_email: string;
  has_access: boolean;
}

export interface EntityEntryRow {
  entry_id: string;
  entry_number: string;
  entry_date: string;
  memo: string | null;
  source_type: string;
  total_cents: number;
  is_intercompany: boolean;
}

export interface IntercompanyDraft {
  date: string;
  memo: string;
  providerId: string;
  recipientId: string;
  amount: string;
  receivableId: string;
  revenueId: string;
  expenseId: string;
  payableId: string;
}

export type RangePreset = 'month' | 'last_month' | 'quarter' | 'year';

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — unit tested)
// ---------------------------------------------------------------------------

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function normalizePnlRows(raw: unknown): MultiEntityPnlRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      entity_id: String(row.entity_id),
      entity_code: String(row.entity_code),
      entity_name: String(row.entity_name),
      account_code: String(row.account_code),
      account_name: String(row.account_name),
      type: row.type === 'expense' ? 'expense' : 'revenue',
      gross_cents: num(row.gross_cents),
      intercompany_cents: num(row.intercompany_cents),
      eliminated_cents: num(row.eliminated_cents),
    } satisfies MultiEntityPnlRow;
  });
}

const byAccountCode = (a: PnlLine, b: PnlLine) =>
  a.account_code.localeCompare(b.account_code, undefined, { numeric: true });

function buildStatement(rows: MultiEntityPnlRow[], eliminate: boolean): PnlStatement {
  const lines = new Map<string, PnlLine>();
  for (const r of rows) {
    const key = `${r.type}:${r.account_code}`;
    const line =
      lines.get(key) ??
      ({
        account_code: r.account_code,
        account_name: r.account_name,
        type: r.type,
        gross_cents: 0,
        intercompany_cents: 0,
        eliminated_cents: 0,
        amount_cents: 0,
      } satisfies PnlLine);
    line.gross_cents += r.gross_cents;
    line.intercompany_cents += r.intercompany_cents;
    line.eliminated_cents += eliminate ? r.eliminated_cents : 0;
    line.amount_cents = line.gross_cents - line.eliminated_cents;
    lines.set(key, line);
  }

  const all = [...lines.values()].filter((l) => l.gross_cents !== 0 || l.amount_cents !== 0);
  const revenue = all.filter((l) => l.type === 'revenue').sort(byAccountCode);
  const expenses = all.filter((l) => l.type === 'expense').sort(byAccountCode);
  const sum = (ls: PnlLine[], pick: (l: PnlLine) => number) => ls.reduce((s, l) => s + pick(l), 0);

  const revenue_cents = sum(revenue, (l) => l.amount_cents);
  const expense_cents = sum(expenses, (l) => l.amount_cents);
  const net_cents = revenue_cents - expense_cents;

  return {
    revenue,
    expenses,
    totals: {
      revenue_cents,
      expense_cents,
      net_cents,
      margin_pct: revenue_cents > 0 ? (net_cents / revenue_cents) * 100 : null,
      intercompany_revenue_cents: sum(revenue, (l) => l.intercompany_cents),
      intercompany_expense_cents: sum(expenses, (l) => l.intercompany_cents),
      eliminated_revenue_cents: sum(revenue, (l) => l.eliminated_cents),
      eliminated_expense_cents: sum(expenses, (l) => l.eliminated_cents),
    },
  };
}

/** One entity's own books — intercompany is never removed here. */
export function buildEntityStatement(rows: MultiEntityPnlRow[], entityId: string): PnlStatement {
  return buildStatement(
    rows.filter((r) => r.entity_id === entityId),
    false,
  );
}

/** All rows in scope added together, optionally with intercompany eliminated. */
export function buildCombinedStatement(rows: MultiEntityPnlRow[], eliminate: boolean): PnlStatement {
  return buildStatement(rows, eliminate);
}

/**
 * Eliminated revenue must equal eliminated expense (each intercompany pair has
 * one of each). A mismatch means a one-sided entry, e.g. only one half was voided.
 */
export function eliminationCheck(rows: MultiEntityPnlRow[]): EliminationCheck {
  let rev = 0;
  let exp = 0;
  for (const r of rows) {
    if (r.type === 'revenue') rev += r.eliminated_cents;
    else exp += r.eliminated_cents;
  }
  const mismatch = Math.abs(rev - exp);
  return {
    eliminated_revenue_cents: rev,
    eliminated_expense_cents: exp,
    mismatch_cents: mismatch,
    balanced: mismatch === 0,
  };
}

export function summarizeEntities(rows: MultiEntityPnlRow[], entities: ReportingEntity[]): EntitySummary[] {
  const perEntity = entities.map((entity) => ({
    entity,
    totals: buildEntityStatement(rows, entity.entity_id).totals,
  }));
  const grossRevenue = perEntity.reduce((s, p) => s + p.totals.revenue_cents, 0);
  return perEntity.map((p) => ({
    ...p,
    revenue_share_pct: grossRevenue > 0 ? (p.totals.revenue_cents / grossRevenue) * 100 : null,
  }));
}

// -- Dates ------------------------------------------------------------------

export function isoDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function rangePreset(kind: RangePreset, today: Date): { start: string; end: string } {
  const y = today.getFullYear();
  const m = today.getMonth();
  switch (kind) {
    case 'last_month':
      return { start: isoDate(new Date(y, m - 1, 1)), end: isoDate(new Date(y, m, 0)) };
    case 'quarter':
      return { start: isoDate(new Date(y, Math.floor(m / 3) * 3, 1)), end: isoDate(today) };
    case 'year':
      return { start: isoDate(new Date(y, 0, 1)), end: isoDate(today) };
    case 'month':
    default:
      return { start: isoDate(new Date(y, m, 1)), end: isoDate(today) };
  }
}

export function isValidRange(start: string, end: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && start <= end;
}

// -- Forms ------------------------------------------------------------------

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function validateEntityDraft(name: string, code: string): { name?: string; code?: string } {
  const errors: { name?: string; code?: string } = {};
  const n = name.trim();
  if (n.length < 1 || n.length > 120) errors.name = 'Enter a name up to 120 characters.';
  if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(normalizeCode(code))) {
    errors.code = 'Use 1–20 letters, numbers, "-" or "_".';
  }
  return errors;
}

/** "1,234.56" -> 123456. Returns null for anything that is not a positive amount that fits the database. */
export function dollarsToCents(input: string): number | null {
  const cleaned = input.trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 2_147_483_647 ? cents : null;
}

export function validateIntercompanyDraft(d: IntercompanyDraft): Partial<Record<keyof IntercompanyDraft, string>> {
  const e: Partial<Record<keyof IntercompanyDraft, string>> = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) e.date = 'Pick a date.';
  if (!d.providerId) e.providerId = 'Choose the entity providing the service.';
  if (!d.recipientId) e.recipientId = 'Choose the entity receiving it.';
  if (d.providerId && d.providerId === d.recipientId) e.recipientId = 'Pick two different entities.';
  if (dollarsToCents(d.amount) === null) e.amount = 'Enter an amount greater than zero.';
  if (!d.receivableId) e.receivableId = 'Choose a receivable (asset) account.';
  if (!d.revenueId) e.revenueId = 'Choose a revenue account.';
  if (!d.expenseId) e.expenseId = 'Choose an expense account.';
  if (!d.payableId) e.payableId = 'Choose a payable (liability) account.';
  if (d.memo.trim().length > 500) e.memo = 'Keep the memo under 500 characters.';
  return e;
}

// -- Access matrix ----------------------------------------------------------

export function groupAccess(rows: AccessRow[]) {
  const entities = new Map<string, { id: string; code: string; name: string }>();
  const members = new Map<string, { id: string; name: string; email: string }>();
  const granted = new Set<string>();
  for (const r of rows) {
    entities.set(r.entity_id, { id: r.entity_id, code: r.entity_code, name: r.entity_name });
    members.set(r.member_user_id, { id: r.member_user_id, name: r.member_name || r.member_email, email: r.member_email });
    if (r.has_access) granted.add(`${r.entity_id}:${r.member_user_id}`);
  }
  return { entities: [...entities.values()], members: [...members.values()], granted };
}

// -- CSV (spreadsheet-formula safe) ------------------------------------------

const csvText = (v: string): string => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csvMoney = (cents: number): string => (cents / 100).toFixed(2);

export function statementToCsv(statement: PnlStatement): string {
  // Text cells are formula-guarded; money cells are plain numbers (negatives stay negative).
  const row = (section: string, code: string, account: string, gross: string, eliminated: string, net: string) =>
    [csvText(section), csvText(code), csvText(account), gross, eliminated, net].join(',');
  const out: string[] = ['Section,Code,Account,Gross,Eliminated,Net'];
  const add = (section: string, ls: PnlLine[]) => {
    for (const l of ls) {
      out.push(row(section, l.account_code, l.account_name, csvMoney(l.gross_cents), csvMoney(l.eliminated_cents), csvMoney(l.amount_cents)));
    }
  };
  add('Revenue', statement.revenue);
  add('Expenses', statement.expenses);
  const t = statement.totals;
  out.push(row('Total', '', 'Total revenue', '', '', csvMoney(t.revenue_cents)));
  out.push(row('Total', '', 'Total expenses', '', '', csvMoney(t.expense_cents)));
  out.push(row('Total', '', 'Net income', '', '', csvMoney(t.net_cents)));
  return out.join('\r\n');
}

// ---------------------------------------------------------------------------
// Supabase RPC wrappers
// ---------------------------------------------------------------------------

export async function fetchEntities(): Promise<ReportingEntity[]> {
  const { data, error } = await supabase.rpc('list_reporting_entities');
  if (error) throw error;
  return ((data ?? []) as ReportingEntity[]).map((e) => ({ ...e, entry_count: num(e.entry_count) }));
}

/** entityIds null = every entity the caller can access. Always fetched with elimination data. */
export async function fetchMultiEntityPnl(start: string, end: string, entityIds: string[] | null): Promise<MultiEntityPnlRow[]> {
  const { data, error } = await supabase.rpc('get_multi_entity_profit_and_loss', {
    p_start: start,
    p_end: end,
    p_entity_ids: entityIds,
    p_eliminate: true,
  });
  if (error) throw error;
  return normalizePnlRows(data);
}

export async function createEntity(name: string, code: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_reporting_entity', { p_name: name.trim(), p_code: normalizeCode(code) });
  if (error) throw error;
  return data as string;
}

export async function updateEntity(entityId: string, name: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.rpc('update_reporting_entity', { p_entity_id: entityId, p_name: name.trim(), p_is_active: isActive });
  if (error) throw error;
}

export async function fetchAccessOverview(): Promise<AccessRow[]> {
  const { data, error } = await supabase.rpc('get_reporting_entity_access_overview');
  if (error) throw error;
  return (data ?? []) as AccessRow[];
}

export async function setEntityAccess(entityId: string, memberUserId: string, granted: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_reporting_entity_access', {
    p_entity_id: entityId,
    p_member_user_id: memberUserId,
    p_granted: granted,
  });
  if (error) throw error;
}

export async function fetchEntityEntries(entityId: string, limit = 100): Promise<EntityEntryRow[]> {
  const { data, error } = await supabase.rpc('list_journal_entries_for_entity', { p_entity_id: entityId, p_limit: limit });
  if (error) throw error;
  return ((data ?? []) as EntityEntryRow[]).map((r) => ({ ...r, total_cents: num(r.total_cents) }));
}

export async function assignEntries(entryIds: string[], entityId: string): Promise<number> {
  const { data, error } = await supabase.rpc('assign_journal_entries_to_entity', { p_entry_ids: entryIds, p_entity_id: entityId });
  if (error) throw error;
  return num(data);
}

export async function postIntercompany(d: IntercompanyDraft): Promise<string> {
  const cents = dollarsToCents(d.amount);
  if (cents === null) throw new Error('Enter an amount greater than zero.');
  const { data, error } = await supabase.rpc('post_intercompany_entry', {
    p_entry_date: d.date,
    p_memo: d.memo.trim(),
    p_provider_entity_id: d.providerId,
    p_recipient_entity_id: d.recipientId,
    p_amount_cents: cents,
    p_receivable_account_id: d.receivableId,
    p_revenue_account_id: d.revenueId,
    p_expense_account_id: d.expenseId,
    p_payable_account_id: d.payableId,
  });
  if (error) throw error;
  return data as string;
}
