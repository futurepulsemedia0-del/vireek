import { supabase } from '@/lib/supabase';

/**
 * Budgets — dashboard client library.
 *
 * Thin wrapper over supabase/migrations/20270402000000_budgets.sql.
 * "Actual" always comes from the posted general ledger (expense accounts in
 * chart_of_accounts), so budgets can never drift from the books. All writes
 * go through SECURITY DEFINER RPCs that enforce account scoping + permissions.
 */

export type BudgetStatus = 'on_track' | 'warning' | 'over' | 'unbudgeted';

export interface BudgetVarianceRow {
  budget_id: string | null;
  account_id: string;
  account_code: string;
  account_name: string;
  budget_cents: number;
  actual_cents: number;
  /** budget - actual; negative means overspent. */
  variance_cents: number;
  pct_used: number | null;
  warn_at_pct: number;
  status: BudgetStatus;
  notes: string | null;
}

export interface BudgetTrendPoint {
  period_month: string;
  budget_cents: number;
  actual_cents: number;
}

export interface BudgetSummary {
  budgetCents: number;
  actualCents: number;
  remainingCents: number;
  pctUsed: number | null;
  unbudgetedCents: number;
  warningCount: number;
  overCount: number;
}

export interface UpsertBudgetInput {
  month: string;
  accountId: string;
  amountCents: number;
  warnAtPct: number;
  notes?: string | null;
}

// ------------------------------------------------------------------
// Pure helpers (unit-tested)
// ------------------------------------------------------------------

/** First day of the month for a date, as YYYY-MM-DD, using the local calendar. */
export function monthStart(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/** Shift a YYYY-MM-01 month key by n months (negative = back). */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12;
  return `${ny}-${String(nm + 1).padStart(2, '0')}-01`;
}

export function monthLabel(month: string, style: 'long' | 'short' = 'long'): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: style,
    year: style === 'long' ? 'numeric' : '2-digit',
    timeZone: 'UTC',
  });
}

/** Parse a user-typed dollar amount ("1,250.50", "$300") into integer cents; null if invalid. */
export function dollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(parseFloat(cleaned) * 100);
  return Number.isSafeInteger(cents) && cents <= 100_000_000_000 ? cents : null;
}

export function centsToDollarsInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Mirrors the SQL status rules so client previews match the database. */
export function classifyBudget(budgetCents: number, actualCents: number, warnAtPct: number, hasBudget = true): BudgetStatus {
  if (!hasBudget) return 'unbudgeted';
  if (actualCents > budgetCents) return 'over';
  if (budgetCents > 0 && (actualCents * 100) / budgetCents >= warnAtPct) return 'warning';
  return 'on_track';
}

export function summarizeBudgets(rows: BudgetVarianceRow[]): BudgetSummary {
  let budgetCents = 0;
  let budgetedActual = 0;
  let unbudgetedCents = 0;
  let warningCount = 0;
  let overCount = 0;
  for (const r of rows) {
    if (r.status === 'unbudgeted') {
      unbudgetedCents += r.actual_cents;
      continue;
    }
    budgetCents += r.budget_cents;
    budgetedActual += r.actual_cents;
    if (r.status === 'warning') warningCount += 1;
    if (r.status === 'over') overCount += 1;
  }
  return {
    budgetCents,
    actualCents: budgetedActual + unbudgetedCents,
    remainingCents: budgetCents - budgetedActual,
    pctUsed: budgetCents > 0 ? Math.round((budgetedActual * 1000) / budgetCents) / 10 : null,
    unbudgetedCents,
    warningCount,
    overCount,
  };
}

/** Rows needing attention, worst first (over by most, then closest to limit). */
export function alertRows(rows: BudgetVarianceRow[]): BudgetVarianceRow[] {
  return rows
    .filter((r) => r.status === 'over' || r.status === 'warning')
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'over' ? -1 : 1;
      return a.variance_cents - b.variance_cents;
    });
}

export const STATUS_LABEL: Record<BudgetStatus, string> = {
  on_track: 'On track',
  warning: 'Nearing limit',
  over: 'Over budget',
  unbudgeted: 'No budget',
};

// ------------------------------------------------------------------
// Data access
// ------------------------------------------------------------------

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

export async function fetchBudgetVariance(month: string): Promise<BudgetVarianceRow[]> {
  const { data, error } = await supabase.rpc('get_budget_variance', { p_month: month });
  if (error) throw error;
  return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
    budget_id: (r.budget_id as string | null) ?? null,
    account_id: r.account_id as string,
    account_code: r.account_code as string,
    account_name: r.account_name as string,
    budget_cents: num(r.budget_cents),
    actual_cents: num(r.actual_cents),
    variance_cents: num(r.variance_cents),
    pct_used: r.pct_used === null || r.pct_used === undefined ? null : num(r.pct_used),
    warn_at_pct: num(r.warn_at_pct),
    status: r.status as BudgetStatus,
    notes: (r.notes as string | null) ?? null,
  }));
}

export async function fetchBudgetTrend(endMonth: string, months = 6): Promise<BudgetTrendPoint[]> {
  const { data, error } = await supabase.rpc('get_budget_trend', { p_end_month: endMonth, p_months: months });
  if (error) throw error;
  return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
    period_month: String(r.period_month),
    budget_cents: num(r.budget_cents),
    actual_cents: num(r.actual_cents),
  }));
}

export async function upsertBudget(input: UpsertBudgetInput): Promise<string> {
  const { data, error } = await supabase.rpc('upsert_budget', {
    p_month: input.month,
    p_account_id: input.accountId,
    p_amount_cents: input.amountCents,
    p_warn_at_pct: input.warnAtPct,
    p_notes: input.notes ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function deleteBudget(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_budget', { p_id: id });
  if (error) throw error;
}

export async function copyBudgetsFromPreviousMonth(month: string): Promise<number> {
  const { data, error } = await supabase.rpc('copy_budgets_from_previous_month', { p_month: month });
  if (error) throw error;
  return num(data);
}

/** Best-effort: raises in-app notifications for newly crossed thresholds. Never throws. */
export async function syncBudgetAlerts(month: string): Promise<number> {
  try {
    const { data, error } = await supabase.rpc('sync_budget_alerts', { p_month: month });
    if (error) return 0;
    return num(data);
  } catch {
    return 0;
  }
}
