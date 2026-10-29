/**
 * Multi-entity accounting — pure logic (no I/O).
 *
 * Mirrors supabase/migrations/20280115000000_multi_entity_accounting.sql.
 * The database owns posting (balanced entries, closed periods, intercompany
 * pairing); this file owns presentation math: consolidation, intercompany
 * elimination, non-controlling interest, validation, formatting and CSV.
 * Money is always integer cents.
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type IcRole = 'ic_receivable' | 'ic_payable' | 'ic_revenue' | 'ic_expense' | 'cash';
export type EntityType = 'operating' | 'holding' | 'branch' | 'other';
export type ConsolidationMethod = 'full' | 'excluded';
export type IcKind = 'sale' | 'service' | 'expense_recharge' | 'loan';
export type IcStatus = 'open' | 'partially_settled' | 'settled' | 'void';
export type PeriodPreset = 'this_month' | 'last_month' | 'this_quarter' | 'ytd' | 'custom';

export const MAX_AMOUNT_CENTS = 100_000_000_000;

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  operating: 'Operating company', holding: 'Holding company', branch: 'Branch / division', other: 'Other',
};
export const METHOD_LABELS: Record<ConsolidationMethod, string> = {
  full: 'Full consolidation', excluded: 'Excluded from consolidation',
};
export const IC_KIND_LABELS: Record<IcKind, string> = {
  sale: 'Sale of goods / parts', service: 'Services rendered', expense_recharge: 'Expense recharge', loan: 'Intercompany loan',
};
export const IC_STATUS_LABELS: Record<IcStatus, string> = {
  open: 'Open', partially_settled: 'Partly settled', settled: 'Settled', void: 'Void',
};
export const PRESET_LABELS: Record<PeriodPreset, string> = {
  this_month: 'This month', last_month: 'Last month', this_quarter: 'This quarter', ytd: 'Year to date', custom: 'Custom',
};

export interface AccountingEntity {
  id: string;
  code: string;
  name: string;
  legal_name: string | null;
  entity_type: EntityType;
  country: string | null;
  ownership_pct: number;
  consolidation_method: ConsolidationMethod;
  is_primary: boolean;
  is_active: boolean;
}

export interface BalanceRow {
  entity_id: string;
  account_id: string;
  code: string;
  name: string;
  type: AccountType;
  normal_balance: 'debit' | 'credit';
  ic_role: IcRole | null;
  cum_debit_cents: number;
  cum_credit_cents: number;
  period_debit_cents: number;
  period_credit_cents: number;
}

export interface IcTransaction {
  id: string;
  txn_number: string;
  txn_date: string;
  kind: IcKind;
  from_entity_id: string;
  to_entity_id: string;
  amount_cents: number;
  settled_cents: number;
  status: IcStatus;
  description: string | null;
  void_reason: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Formatting / parsing
// ---------------------------------------------------------------------------

export function money(cents: number | null | undefined): string {
  const v = Math.round(Number(cents ?? 0));
  const s = `$${(Math.abs(v) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return v < 0 ? `-${s}` : s;
}

/** "1,234.5" -> 123450. Returns null for anything that is not a plain money amount. */
export function parseAmountToCents(input: string): number | null {
  const t = input.trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return 'Something went wrong. Please try again.';
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function isoToday(now: Date = new Date()): string {
  return ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function periodForPreset(preset: PeriodPreset, today: string = isoToday()): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number);
  if (preset === 'last_month') {
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    return { from: ymd(py, pm, 1), to: ymd(py, pm, lastDay(py, pm)) };
  }
  if (preset === 'this_quarter') return { from: ymd(y, Math.floor((m - 1) / 3) * 3 + 1, 1), to: today };
  if (preset === 'ytd') return { from: ymd(y, 1, 1), to: today };
  return { from: ymd(y, m, 1), to: today };
}

export function validatePeriod(from: string, to: string): string | null {
  if (!isIsoDate(from) || !isIsoDate(to)) return 'Enter a valid start and end date.';
  if (from > to) return 'The start date must be on or before the end date.';
  return null;
}

// ---------------------------------------------------------------------------
// Drafts + validation
// ---------------------------------------------------------------------------

export interface EntityDraft {
  id: string | null;
  code: string;
  name: string;
  legal_name: string;
  entity_type: EntityType;
  country: string;
  ownership_pct: string;
  consolidation_method: ConsolidationMethod;
  is_active: boolean;
  is_primary: boolean;
}

export const emptyEntityDraft = (): EntityDraft => ({
  id: null, code: '', name: '', legal_name: '', entity_type: 'operating', country: '',
  ownership_pct: '100', consolidation_method: 'full', is_active: true, is_primary: false,
});

export const draftFromEntity = (e: AccountingEntity): EntityDraft => ({
  id: e.id, code: e.code, name: e.name, legal_name: e.legal_name ?? '', entity_type: e.entity_type, country: e.country ?? '',
  ownership_pct: String(e.ownership_pct), consolidation_method: e.consolidation_method, is_active: e.is_active, is_primary: e.is_primary,
});

export type EntityErrors = Partial<Record<'code' | 'name' | 'legal_name' | 'country' | 'ownership_pct', string>>;

export function validateEntityDraft(d: EntityDraft, existing: AccountingEntity[]): EntityErrors {
  const errors: EntityErrors = {};
  const code = d.code.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/.test(code)) errors.code = 'Use 1–20 letters, numbers, dashes or underscores.';
  else if (existing.some((e) => e.id !== d.id && e.code.toLowerCase() === code.toLowerCase())) errors.code = 'That code is already used by another entity.';
  const name = d.name.trim();
  if (name.length < 1 || name.length > 120) errors.name = 'Enter a name up to 120 characters.';
  if (d.legal_name.trim().length > 200) errors.legal_name = 'Legal name is limited to 200 characters.';
  const country = d.country.trim();
  if (country && (country.length < 2 || country.length > 60)) errors.country = 'Enter 2–60 characters.';
  const pct = Number(d.ownership_pct);
  if (d.ownership_pct.trim() === '' || !Number.isFinite(pct) || pct <= 0 || pct > 100 || !/^\d{1,3}(\.\d{1,2})?$/.test(d.ownership_pct.trim())) {
    errors.ownership_pct = 'Enter a percentage above 0 and up to 100 (max 2 decimals).';
  } else if (d.is_primary && pct !== 100) {
    errors.ownership_pct = 'The primary entity is always 100% owned.';
  }
  return errors;
}

export interface IcDraft {
  from_entity_id: string;
  to_entity_id: string;
  kind: IcKind;
  txn_date: string;
  amount: string;
  description: string;
}

export const emptyIcDraft = (today: string = isoToday()): IcDraft => ({
  from_entity_id: '', to_entity_id: '', kind: 'service', txn_date: today, amount: '', description: '',
});

export type IcErrors = Partial<Record<'from_entity_id' | 'to_entity_id' | 'txn_date' | 'amount' | 'description', string>>;

export function validateIcDraft(d: IcDraft, entities: AccountingEntity[]): IcErrors {
  const errors: IcErrors = {};
  const active = new Set(entities.filter((e) => e.is_active).map((e) => e.id));
  if (!d.from_entity_id || !active.has(d.from_entity_id)) errors.from_entity_id = 'Choose the entity that provides the goods, service or loan.';
  if (!d.to_entity_id || !active.has(d.to_entity_id)) errors.to_entity_id = 'Choose the receiving entity.';
  else if (d.to_entity_id === d.from_entity_id) errors.to_entity_id = 'The two entities must be different.';
  if (!isIsoDate(d.txn_date)) errors.txn_date = 'Enter a valid date.';
  const cents = parseAmountToCents(d.amount);
  if (cents === null || cents <= 0) errors.amount = 'Enter an amount like 1,250.00.';
  else if (cents > MAX_AMOUNT_CENTS) errors.amount = 'That amount is too large.';
  if (d.description.trim().length > 500) errors.description = 'Description is limited to 500 characters.';
  return errors;
}

export const outstandingCents = (t: Pick<IcTransaction, 'amount_cents' | 'settled_cents' | 'status'>): number =>
  t.status === 'void' ? 0 : Math.max(0, t.amount_cents - t.settled_cents);

export function validateSettlement(amountInput: string, date: string, txn: IcTransaction): { amount?: string; date?: string } {
  const errors: { amount?: string; date?: string } = {};
  const cents = parseAmountToCents(amountInput);
  if (cents === null || cents <= 0) errors.amount = 'Enter an amount like 1,250.00.';
  else if (cents > outstandingCents(txn)) errors.amount = `Cannot exceed the outstanding ${money(outstandingCents(txn))}.`;
  if (!isIsoDate(date)) errors.date = 'Enter a valid date.';
  else if (date < txn.txn_date) errors.date = 'Settlement cannot be dated before the transaction.';
  return errors;
}

export interface JournalLineDraft { account_id: string; debit: string; credit: string; description: string }
export interface JournalLinePayload { account_id: string; debit_cents: number; credit_cents: number; description: string | null }

export const emptyJournalLine = (): JournalLineDraft => ({ account_id: '', debit: '', credit: '', description: '' });

export function journalTotals(lines: JournalLineDraft[]): { debit: number; credit: number } {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    debit += parseAmountToCents(l.debit) ?? 0;
    credit += parseAmountToCents(l.credit) ?? 0;
  }
  return { debit, credit };
}

/** Returns the first problem, or null plus the normalized payload the RPC expects. */
export function validateJournal(
  date: string, memo: string, lines: JournalLineDraft[],
): { error: string | null; payload: JournalLinePayload[] } {
  const payload: JournalLinePayload[] = [];
  if (!isIsoDate(date)) return { error: 'Enter a valid date.', payload };
  if (memo.trim().length > 500) return { error: 'Memo is limited to 500 characters.', payload };
  for (const [i, l] of lines.entries()) {
    const blank = !l.account_id && !l.debit.trim() && !l.credit.trim();
    if (blank) continue;
    if (!l.account_id) return { error: `Line ${i + 1}: choose an account.`, payload };
    const d = l.debit.trim() ? parseAmountToCents(l.debit) : 0;
    const c = l.credit.trim() ? parseAmountToCents(l.credit) : 0;
    if (d === null || c === null) return { error: `Line ${i + 1}: enter a valid amount.`, payload };
    if ((d > 0) === (c > 0)) return { error: `Line ${i + 1}: enter either a debit or a credit.`, payload };
    if (d > MAX_AMOUNT_CENTS || c > MAX_AMOUNT_CENTS) return { error: `Line ${i + 1}: amount is too large.`, payload };
    payload.push({ account_id: l.account_id, debit_cents: d, credit_cents: c, description: l.description.trim() || null });
  }
  if (payload.length < 2) return { error: 'A journal entry needs at least two lines.', payload };
  const debit = payload.reduce((s, l) => s + l.debit_cents, 0);
  const credit = payload.reduce((s, l) => s + l.credit_cents, 0);
  if (debit !== credit) return { error: `Out of balance by ${money(Math.abs(debit - credit))}.`, payload };
  return { error: null, payload };
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

export interface ReportLine {
  account_id: string;
  code: string;
  name: string;
  type: AccountType;
  combined_cents: number;
  elimination_cents: number;
  consolidated_cents: number;
  by_entity: Record<string, number>;
}

export interface ConsolidatedReport {
  entity_ids: string[];
  /** true when more than one entity is combined (eliminations + NCI apply). */
  consolidated: boolean;
  revenue: ReportLine[];
  expenses: ReportLine[];
  assets: ReportLine[];
  liabilities: ReportLine[];
  equity: ReportLine[];
  totals: {
    revenue_cents: number;
    expense_cents: number;
    net_income_cents: number;
    nci_net_income_cents: number;
    parent_net_income_cents: number;
    total_assets_cents: number;
    total_liabilities_cents: number;
    equity_accounts_cents: number;
    cumulative_earnings_cents: number;
    unreconciled_cents: number;
    total_liabilities_equity_cents: number;
    nci_equity_cents: number;
  };
  eliminations: { revenue_cents: number; expense_cents: number; receivable_cents: number; payable_cents: number };
  checks: { trade_difference_cents: number; balance_difference_cents: number; intercompany_ok: boolean; balanced: boolean };
}

export const defaultIncludedIds = (entities: AccountingEntity[]): string[] =>
  entities.filter((e) => e.is_active && e.consolidation_method === 'full').map((e) => e.id);

interface Agg {
  account_id: string; code: string; name: string; type: AccountType; role: IcRole | null;
  per: number; cum: number; byPer: Record<string, number>; byCum: Record<string, number>;
}

const num = (v: unknown) => Math.round(Number(v ?? 0)) || 0;
const side = (row: BalanceRow, d: number, c: number) => (row.normal_balance === 'debit' ? d - c : c - d);

export function buildReport(rows: BalanceRow[], entities: AccountingEntity[], includeIds: string[]): ConsolidatedReport {
  const ids = new Set(includeIds);
  const included = entities.filter((e) => ids.has(e.id));
  const eliminate = included.length > 1;
  const agg = new Map<string, Agg>();
  const stats: Record<string, { ni: number; assets: number; liabilities: number }> = {};

  for (const row of rows) {
    if (!ids.has(row.entity_id)) continue;
    const per = side(row, num(row.period_debit_cents), num(row.period_credit_cents));
    const cum = side(row, num(row.cum_debit_cents), num(row.cum_credit_cents));
    const a = agg.get(row.account_id) ?? {
      account_id: row.account_id, code: row.code, name: row.name, type: row.type, role: row.ic_role,
      per: 0, cum: 0, byPer: {}, byCum: {},
    };
    a.per += per;
    a.cum += cum;
    a.byPer[row.entity_id] = (a.byPer[row.entity_id] ?? 0) + per;
    a.byCum[row.entity_id] = (a.byCum[row.entity_id] ?? 0) + cum;
    agg.set(row.account_id, a);

    const s = (stats[row.entity_id] ??= { ni: 0, assets: 0, liabilities: 0 });
    if (row.type === 'revenue') s.ni += per;
    else if (row.type === 'expense') s.ni -= per;
    else if (row.type === 'asset') s.assets += cum;
    else if (row.type === 'liability') s.liabilities += cum;
  }

  let revPer = 0, expPer = 0, revCum = 0, expCum = 0;
  let rec = 0, pay = 0, icRevCum = 0, icExpCum = 0, icRevPer = 0, icExpPer = 0;
  for (const a of agg.values()) {
    if (a.type === 'revenue') {
      revPer += a.per; revCum += a.cum;
      if (a.role === 'ic_revenue') { icRevCum += a.cum; icRevPer += a.per; }
    } else if (a.type === 'expense') {
      expPer += a.per; expCum += a.cum;
      if (a.role === 'ic_expense') { icExpCum += a.cum; icExpPer += a.per; }
    }
    if (a.role === 'ic_receivable') rec += a.cum;
    if (a.role === 'ic_payable') pay += a.cum;
  }

  const eliminated = (a: Agg, kind: 'per' | 'cum') => {
    if (!eliminate) return false;
    return kind === 'per' ? a.role === 'ic_revenue' || a.role === 'ic_expense' : a.role === 'ic_receivable' || a.role === 'ic_payable';
  };
  const line = (a: Agg, kind: 'per' | 'cum'): ReportLine => {
    const combined = kind === 'per' ? a.per : a.cum;
    const elim = eliminated(a, kind) ? -combined : 0;
    return {
      account_id: a.account_id, code: a.code, name: a.name, type: a.type,
      combined_cents: combined, elimination_cents: elim, consolidated_cents: combined + elim,
      by_entity: { ...(kind === 'per' ? a.byPer : a.byCum) },
    };
  };
  const section = (type: AccountType, kind: 'per' | 'cum') =>
    [...agg.values()]
      .filter((a) => a.type === type && (kind === 'per' ? a.per : a.cum) !== 0)
      .sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }))
      .map((a) => line(a, kind));
  const sum = (ls: ReportLine[]) => ls.reduce((s, l) => s + l.consolidated_cents, 0);

  const revenue = section('revenue', 'per');
  const expenses = section('expense', 'per');
  const assets = section('asset', 'cum');
  const liabilities = section('liability', 'cum');
  const equity = section('equity', 'cum');

  let nciNi = 0, nciBs = 0;
  if (eliminate) {
    for (const e of included) {
      const share = 1 - Number(e.ownership_pct) / 100;
      const s = stats[e.id];
      if (share <= 0 || !s) continue;
      nciNi += Math.round(share * s.ni);
      nciBs += Math.round(share * (s.assets - s.liabilities));
    }
  }

  const revenueTotal = sum(revenue);
  const expenseTotal = sum(expenses);
  const netIncome = revenueTotal - expenseTotal;
  const cumulativeEarnings = revCum - expCum - (eliminate ? icRevCum - icExpCum : 0);
  const unreconciled = eliminate ? icRevCum - icExpCum - (rec - pay) : 0;
  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const equityAccounts = sum(equity);
  const totalLE = totalLiabilities + equityAccounts + cumulativeEarnings + unreconciled;
  const tradeDiff = eliminate ? icRevPer - icExpPer : 0;
  const balanceDiff = eliminate ? rec - pay : 0;

  return {
    entity_ids: included.map((e) => e.id),
    consolidated: eliminate,
    revenue, expenses, assets, liabilities, equity,
    totals: {
      revenue_cents: revenueTotal, expense_cents: expenseTotal, net_income_cents: netIncome,
      nci_net_income_cents: nciNi, parent_net_income_cents: netIncome - nciNi,
      total_assets_cents: totalAssets, total_liabilities_cents: totalLiabilities, equity_accounts_cents: equityAccounts,
      cumulative_earnings_cents: cumulativeEarnings, unreconciled_cents: unreconciled,
      total_liabilities_equity_cents: totalLE, nci_equity_cents: nciBs,
    },
    eliminations: {
      revenue_cents: eliminate ? icRevPer : 0, expense_cents: eliminate ? icExpPer : 0,
      receivable_cents: eliminate ? rec : 0, payable_cents: eliminate ? pay : 0,
    },
    checks: {
      trade_difference_cents: tradeDiff, balance_difference_cents: balanceDiff,
      intercompany_ok: tradeDiff === 0 && balanceDiff === 0, balanced: totalAssets === totalLE,
    },
  };
}

// ---------------------------------------------------------------------------
// Intercompany positions
// ---------------------------------------------------------------------------

export interface IcPosition { from_entity_id: string; to_entity_id: string; open_cents: number; count: number }

/** Outstanding receivable (from -> to) per entity pair, largest first. */
export function icPositions(txns: IcTransaction[]): IcPosition[] {
  const map = new Map<string, IcPosition>();
  for (const t of txns) {
    const open = outstandingCents(t);
    if (open <= 0) continue;
    const key = `${t.from_entity_id}>${t.to_entity_id}`;
    const p = map.get(key) ?? { from_entity_id: t.from_entity_id, to_entity_id: t.to_entity_id, open_cents: 0, count: 0 };
    p.open_cents += open;
    p.count += 1;
    map.set(key, p);
  }
  return [...map.values()].sort((a, b) => b.open_cents - a.open_cents);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const csvText = (v: string) => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const dollars = (c: number) => (c / 100).toFixed(2);

export function reportToCsv(report: ConsolidatedReport, period: { from: string; to: string }): string {
  const out: string[] = [];
  const head = ['Section', 'Code', 'Account', 'Combined', 'Eliminations', 'Consolidated'].join(',');
  out.push(csvText(`Report period ${period.from} to ${period.to}`), head);
  const add = (section: string, ls: ReportLine[]) => {
    for (const l of ls) out.push([csvText(section), csvText(l.code), csvText(l.name), dollars(l.combined_cents), dollars(l.elimination_cents), dollars(l.consolidated_cents)].join(','));
  };
  const total = (label: string, cents: number) => out.push([csvText(label), '', '', '', '', dollars(cents)].join(','));
  add('Revenue', report.revenue); total('Total revenue', report.totals.revenue_cents);
  add('Expenses', report.expenses); total('Total expenses', report.totals.expense_cents);
  total('Net income', report.totals.net_income_cents);
  if (report.consolidated) { total('Net income attributable to non-controlling interest', report.totals.nci_net_income_cents); total('Net income attributable to owners', report.totals.parent_net_income_cents); }
  add('Assets', report.assets); total('Total assets', report.totals.total_assets_cents);
  add('Liabilities', report.liabilities); total('Total liabilities', report.totals.total_liabilities_cents);
  add('Equity', report.equity);
  total('Cumulative earnings', report.totals.cumulative_earnings_cents);
  if (report.totals.unreconciled_cents !== 0) total('Intercompany difference (unreconciled)', report.totals.unreconciled_cents);
  total('Total liabilities and equity', report.totals.total_liabilities_equity_cents);
  if (report.consolidated) total('Of which non-controlling interest', report.totals.nci_equity_cents);
  return out.join('\n');
}

export function reportFileName(period: { from: string; to: string }): string {
  return `consolidated-report-${period.from}_to_${period.to}.csv`;
}
