import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

import {
  alertRows,
  centsToDollarsInput,
  classifyBudget,
  copyBudgetsFromPreviousMonth,
  dollarsToCents,
  fetchBudgetVariance,
  monthLabel,
  monthStart,
  shiftMonth,
  summarizeBudgets,
  syncBudgetAlerts,
  upsertBudget,
  type BudgetVarianceRow,
} from './budgets';

const row = (over: Partial<BudgetVarianceRow>): BudgetVarianceRow => ({
  budget_id: 'b1',
  account_id: 'a1',
  account_code: '6100',
  account_name: 'Vehicle and Fuel Expense',
  budget_cents: 100_000,
  actual_cents: 0,
  variance_cents: 100_000,
  pct_used: 0,
  warn_at_pct: 80,
  status: 'on_track',
  notes: null,
  ...over,
});

describe('month helpers', () => {
  it('returns the first day of the month', () => {
    expect(monthStart(new Date(2027, 2, 31))).toBe('2027-03-01');
    expect(monthStart(new Date(2027, 11, 5))).toBe('2027-12-01');
  });

  it('shifts months across year boundaries in both directions', () => {
    expect(shiftMonth('2027-01-01', -1)).toBe('2026-12-01');
    expect(shiftMonth('2027-12-01', 1)).toBe('2028-01-01');
    expect(shiftMonth('2027-05-01', 0)).toBe('2027-05-01');
    expect(shiftMonth('2027-03-01', -15)).toBe('2025-12-01');
  });

  it('labels months without timezone drift', () => {
    expect(monthLabel('2027-03-01')).toBe('March 2027');
    expect(monthLabel('2027-01-01', 'short')).toBe('Jan 27');
  });
});

describe('money parsing', () => {
  it('parses typed dollar amounts into cents', () => {
    expect(dollarsToCents('1500')).toBe(150_000);
    expect(dollarsToCents('$1,250.50')).toBe(125_050);
    expect(dollarsToCents('0.1')).toBe(10);
    expect(dollarsToCents('0')).toBe(0);
  });

  it('rejects invalid, negative, and over-precise amounts', () => {
    expect(dollarsToCents('')).toBeNull();
    expect(dollarsToCents('-5')).toBeNull();
    expect(dollarsToCents('12.345')).toBeNull();
    expect(dollarsToCents('abc')).toBeNull();
    expect(dollarsToCents('999999999999')).toBeNull();
  });

  it('round-trips cents to an input string', () => {
    expect(centsToDollarsInput(125_050)).toBe('1250.50');
    expect(dollarsToCents(centsToDollarsInput(7))).toBe(7);
  });
});

describe('classifyBudget', () => {
  it('matches the SQL status rules', () => {
    expect(classifyBudget(1000, 500, 80)).toBe('on_track');
    expect(classifyBudget(1000, 800, 80)).toBe('warning');
    expect(classifyBudget(1000, 1000, 80)).toBe('warning'); // exactly at budget is not "over"
    expect(classifyBudget(1000, 1001, 80)).toBe('over');
    expect(classifyBudget(0, 1, 80)).toBe('over');
    expect(classifyBudget(0, 0, 80)).toBe('on_track');
    expect(classifyBudget(0, 50, 80, false)).toBe('unbudgeted');
  });
});

describe('summarizeBudgets', () => {
  it('totals budgeted categories and keeps unbudgeted spend separate', () => {
    const s = summarizeBudgets([
      row({ budget_cents: 100_000, actual_cents: 90_000, variance_cents: 10_000, status: 'warning' }),
      row({ account_id: 'a2', budget_cents: 50_000, actual_cents: 60_000, variance_cents: -10_000, status: 'over' }),
      row({ account_id: 'a3', budget_id: null, budget_cents: 0, actual_cents: 20_000, variance_cents: -20_000, status: 'unbudgeted' }),
    ]);
    expect(s.budgetCents).toBe(150_000);
    expect(s.actualCents).toBe(170_000);
    expect(s.remainingCents).toBe(0); // budgeted-only: 150k - 150k
    expect(s.unbudgetedCents).toBe(20_000);
    expect(s.pctUsed).toBe(100);
    expect(s.warningCount).toBe(1);
    expect(s.overCount).toBe(1);
  });

  it('handles an empty list without dividing by zero', () => {
    const s = summarizeBudgets([]);
    expect(s.pctUsed).toBeNull();
    expect(s.budgetCents).toBe(0);
  });
});

describe('alertRows', () => {
  it('lists over-budget first, most overspent first, then warnings', () => {
    const out = alertRows([
      row({ account_id: 'w', status: 'warning', variance_cents: 5_000 }),
      row({ account_id: 'o1', status: 'over', variance_cents: -1_000 }),
      row({ account_id: 'o2', status: 'over', variance_cents: -9_000 }),
      row({ account_id: 'ok', status: 'on_track' }),
      row({ account_id: 'u', status: 'unbudgeted' }),
    ]);
    expect(out.map((r) => r.account_id)).toEqual(['o2', 'o1', 'w']);
  });
});

describe('RPC wrappers', () => {
  beforeEach(() => rpc.mockReset());

  it('normalizes numeric strings returned by Postgres', async () => {
    rpc.mockResolvedValue({
      data: [{
        budget_id: null, account_id: 'a1', account_code: '6200', account_name: 'Marketing',
        budget_cents: '0', actual_cents: '12345', variance_cents: '-12345', pct_used: null,
        warn_at_pct: 80, status: 'unbudgeted', notes: null,
      }],
      error: null,
    });
    const out = await fetchBudgetVariance('2027-03-01');
    expect(rpc).toHaveBeenCalledWith('get_budget_variance', { p_month: '2027-03-01' });
    expect(out[0].actual_cents).toBe(12345);
    expect(out[0].pct_used).toBeNull();
  });

  it('throws when the RPC errors', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('You do not have permission to view budgets') });
    await expect(fetchBudgetVariance('2027-03-01')).rejects.toThrow(/permission/);
  });

  it('sends upsert parameters with the expected names', async () => {
    rpc.mockResolvedValue({ data: 'new-id', error: null });
    const id = await upsertBudget({ month: '2027-03-01', accountId: 'a1', amountCents: 5000, warnAtPct: 75, notes: 'fuel' });
    expect(id).toBe('new-id');
    expect(rpc).toHaveBeenCalledWith('upsert_budget', {
      p_month: '2027-03-01', p_account_id: 'a1', p_amount_cents: 5000, p_warn_at_pct: 75, p_notes: 'fuel',
    });
  });

  it('returns the number of copied budgets', async () => {
    rpc.mockResolvedValue({ data: 3, error: null });
    expect(await copyBudgetsFromPreviousMonth('2027-03-01')).toBe(3);
  });

  it('never throws from best-effort alert sync', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('boom') });
    expect(await syncBudgetAlerts('2027-03-01')).toBe(0);
    rpc.mockRejectedValue(new Error('network'));
    expect(await syncBudgetAlerts('2027-03-01')).toBe(0);
  });
});
