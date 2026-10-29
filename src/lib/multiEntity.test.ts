import { describe, it, expect } from 'vitest';
import {
  buildReport, defaultIncludedIds, emptyEntityDraft, emptyIcDraft, emptyJournalLine, icPositions, isIsoDate, money,
  outstandingCents, parseAmountToCents, periodForPreset, reportToCsv, validateEntityDraft, validateIcDraft, validateJournal,
  validateSettlement, validatePeriod,
  type AccountingEntity, type BalanceRow, type IcTransaction,
} from './multiEntity';

const ent = (id: string, over: Partial<AccountingEntity> = {}): AccountingEntity => ({
  id, code: id.toUpperCase(), name: `Entity ${id}`, legal_name: null, entity_type: 'operating', country: null,
  ownership_pct: 100, consolidation_method: 'full', is_primary: false, is_active: true, ...over,
});

const ACCOUNTS = {
  cash: { account_id: 'a-cash', code: '1000', name: 'Cash', type: 'asset', normal_balance: 'debit', ic_role: null },
  rec: { account_id: 'a-rec', code: '1900', name: 'Intercompany Receivable', type: 'asset', normal_balance: 'debit', ic_role: 'ic_receivable' },
  pay: { account_id: 'a-pay', code: '2900', name: 'Intercompany Payable', type: 'liability', normal_balance: 'credit', ic_role: 'ic_payable' },
  eq: { account_id: 'a-eq', code: '3000', name: 'Equity', type: 'equity', normal_balance: 'credit', ic_role: null },
  rev: { account_id: 'a-rev', code: '4950', name: 'Intercompany Revenue', type: 'revenue', normal_balance: 'credit', ic_role: 'ic_revenue' },
  exp: { account_id: 'a-exp', code: '6950', name: 'Intercompany Expense', type: 'expense', normal_balance: 'debit', ic_role: 'ic_expense' },
} as const;

function row(entity: string, acct: keyof typeof ACCOUNTS, d: number, c: number): BalanceRow {
  return { entity_id: entity, ...ACCOUNTS[acct], cum_debit_cents: d, cum_credit_cents: c, period_debit_cents: d, period_credit_cents: c } as BalanceRow;
}

// A provides $10,000 of services to B; B has repaid $4,000.
const rowsA = [row('a', 'cash', 10_400_000, 0), row('a', 'rec', 1_000_000, 400_000), row('a', 'eq', 0, 10_000_000), row('a', 'rev', 0, 1_000_000)];
const rowsB = [row('b', 'cash', 5_000_000, 400_000), row('b', 'exp', 1_000_000, 0), row('b', 'pay', 400_000, 1_000_000), row('b', 'eq', 0, 5_000_000)];
const entities = [ent('a', { is_primary: true }), ent('b', { ownership_pct: 80 })];

describe('money + parsing', () => {
  it('formats cents', () => {
    expect(money(123456)).toBe('$1,234.56');
    expect(money(-5)).toBe('-$0.05');
    expect(money(null)).toBe('$0.00');
  });
  it('parses plain amounts and rejects junk', () => {
    expect(parseAmountToCents('1,250.5')).toBe(125050);
    expect(parseAmountToCents('$0.07')).toBe(7);
    expect(parseAmountToCents('12')).toBe(1200);
    expect(parseAmountToCents('1.234')).toBeNull();
    expect(parseAmountToCents('-5')).toBeNull();
    expect(parseAmountToCents('abc')).toBeNull();
    expect(parseAmountToCents('')).toBeNull();
  });
});

describe('periods', () => {
  it('computes presets', () => {
    expect(periodForPreset('last_month', '2027-01-15')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(periodForPreset('last_month', '2027-03-02')).toEqual({ from: '2027-02-01', to: '2027-02-28' });
    expect(periodForPreset('this_quarter', '2027-05-20')).toEqual({ from: '2027-04-01', to: '2027-05-20' });
    expect(periodForPreset('ytd', '2027-05-20')).toEqual({ from: '2027-01-01', to: '2027-05-20' });
    expect(periodForPreset('this_month', '2027-05-20')).toEqual({ from: '2027-05-01', to: '2027-05-20' });
  });
  it('validates dates', () => {
    expect(isIsoDate('2027-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(validatePeriod('2027-02-01', '2027-01-01')).toMatch(/on or before/);
    expect(validatePeriod('2027-01-01', '2027-01-31')).toBeNull();
  });
});

describe('validation', () => {
  it('validates entities', () => {
    const ok = { ...emptyEntityDraft(), code: 'TX-01', name: 'Texas LLC' };
    expect(validateEntityDraft(ok, entities)).toEqual({});
    expect(validateEntityDraft({ ...ok, code: 'a' }, entities).code).toMatch(/already used/);
    expect(validateEntityDraft({ ...ok, code: '-x' }, entities).code).toBeDefined();
    expect(validateEntityDraft({ ...ok, ownership_pct: '0' }, entities).ownership_pct).toBeDefined();
    expect(validateEntityDraft({ ...ok, ownership_pct: '100.5' }, entities).ownership_pct).toBeDefined();
    expect(validateEntityDraft({ ...ok, ownership_pct: '60', is_primary: true }, entities).ownership_pct).toMatch(/primary/);
    expect(validateEntityDraft({ ...ok, name: '  ' }, entities).name).toBeDefined();
  });
  it('validates intercompany drafts', () => {
    const base = { ...emptyIcDraft('2027-01-10'), from_entity_id: 'a', to_entity_id: 'b', amount: '100' };
    expect(validateIcDraft(base, entities)).toEqual({});
    expect(validateIcDraft({ ...base, to_entity_id: 'a' }, entities).to_entity_id).toMatch(/different/);
    expect(validateIcDraft({ ...base, amount: '0' }, entities).amount).toBeDefined();
    expect(validateIcDraft({ ...base, from_entity_id: '' }, entities).from_entity_id).toBeDefined();
    expect(validateIcDraft(base, [ent('a'), ent('b', { is_active: false })]).to_entity_id).toBeDefined();
  });
  it('validates settlements', () => {
    const t: IcTransaction = { id: 't', txn_number: 'IC-1', txn_date: '2027-01-10', kind: 'service', from_entity_id: 'a', to_entity_id: 'b', amount_cents: 100_000, settled_cents: 40_000, status: 'partially_settled', description: null, void_reason: null, created_at: '' };
    expect(outstandingCents(t)).toBe(60_000);
    expect(validateSettlement('600', '2027-01-11', t)).toEqual({});
    expect(validateSettlement('600.01', '2027-01-11', t).amount).toMatch(/outstanding/);
    expect(validateSettlement('10', '2027-01-09', t).date).toBeDefined();
  });
  it('validates journals', () => {
    const l = (account_id: string, debit: string, credit: string) => ({ ...emptyJournalLine(), account_id, debit, credit });
    expect(validateJournal('2027-01-01', '', [l('x', '10', ''), l('y', '', '10'), emptyJournalLine()]).error).toBeNull();
    expect(validateJournal('2027-01-01', '', [l('x', '10', ''), l('y', '', '9')]).error).toMatch(/Out of balance by \$1\.00/);
    expect(validateJournal('2027-01-01', '', [l('x', '10', '')]).error).toMatch(/two lines/);
    expect(validateJournal('2027-01-01', '', [l('x', '10', '5'), l('y', '', '5')]).error).toMatch(/either/);
    expect(validateJournal('2027-01-01', '', [l('', '10', ''), l('y', '', '10')]).error).toMatch(/choose an account/);
    expect(validateJournal('bad', '', [])).toMatchObject({ error: 'Enter a valid date.' });
    const ok = validateJournal('2027-01-01', '', [l('x', '10.5', ''), l('y', '', '10.50')]);
    expect(ok.payload).toEqual([{ account_id: 'x', debit_cents: 1050, credit_cents: 0, description: null }, { account_id: 'y', debit_cents: 0, credit_cents: 1050, description: null }]);
  });
});

describe('consolidation', () => {
  it('eliminates matched intercompany balances and computes NCI', () => {
    const r = buildReport([...rowsA, ...rowsB], entities, ['a', 'b']);
    expect(r.consolidated).toBe(true);
    expect(r.assets.find((l) => l.code === '1000')?.consolidated_cents).toBe(15_000_000);
    const rec = r.assets.find((l) => l.code === '1900');
    expect(rec).toMatchObject({ combined_cents: 600_000, elimination_cents: -600_000, consolidated_cents: 0 });
    expect(r.liabilities.find((l) => l.code === '2900')?.consolidated_cents).toBe(0);
    expect(r.revenue[0]).toMatchObject({ combined_cents: 1_000_000, consolidated_cents: 0 });
    expect(r.totals).toMatchObject({
      revenue_cents: 0, expense_cents: 0, net_income_cents: 0, total_assets_cents: 15_000_000, total_liabilities_cents: 0,
      equity_accounts_cents: 15_000_000, cumulative_earnings_cents: 0, unreconciled_cents: 0, total_liabilities_equity_cents: 15_000_000,
      nci_net_income_cents: -200_000, nci_equity_cents: 800_000,
    });
    expect(r.eliminations).toEqual({ revenue_cents: 1_000_000, expense_cents: 1_000_000, receivable_cents: 600_000, payable_cents: 600_000 });
    expect(r.checks).toEqual({ trade_difference_cents: 0, balance_difference_cents: 0, intercompany_ok: true, balanced: true });
  });

  it('flags an out-of-agreement intercompany pair but keeps the sheet balanced', () => {
    const bad = [row('b', 'cash', 5_000_000, 400_000), row('b', 'exp', 900_000, 0), row('b', 'pay', 400_000, 900_000), row('b', 'eq', 0, 5_000_000)];
    const r = buildReport([...rowsA, ...bad], entities, ['a', 'b']);
    expect(r.checks.trade_difference_cents).toBe(100_000);
    expect(r.checks.balance_difference_cents).toBe(100_000);
    expect(r.checks.intercompany_ok).toBe(false);
    expect(r.checks.balanced).toBe(true);
  });

  it('shows an unreconciled line when one side was posted by hand', () => {
    const handPosted = [row('a', 'cash', 10_100_000, 0), row('a', 'rec', 1_300_000, 400_000), row('a', 'eq', 0, 10_000_000), row('a', 'rev', 0, 1_000_000)];
    const r = buildReport([...handPosted, ...rowsB], entities, ['a', 'b']);
    expect(r.totals.unreconciled_cents).toBe(-300_000);
    expect(r.checks.balanced).toBe(true);
    expect(r.checks.intercompany_ok).toBe(false);
  });

  it('reports a single entity standalone with no eliminations', () => {
    const r = buildReport([...rowsA, ...rowsB], entities, ['b']);
    expect(r.consolidated).toBe(false);
    expect(r.liabilities[0]).toMatchObject({ code: '2900', consolidated_cents: 600_000, elimination_cents: 0 });
    expect(r.totals).toMatchObject({ net_income_cents: -1_000_000, nci_equity_cents: 0, total_assets_cents: 4_600_000, total_liabilities_equity_cents: 4_600_000 });
    expect(r.checks.balanced).toBe(true);
  });

  it('ignores rows for entities that are not included and handles empty data', () => {
    const r = buildReport([], entities, ['a', 'b']);
    expect(r.totals.total_assets_cents).toBe(0);
    expect(r.checks.balanced).toBe(true);
    expect(buildReport(rowsA, entities, ['b']).assets).toHaveLength(0);
  });

  it('defaults to active, fully consolidated entities', () => {
    expect(defaultIncludedIds([ent('a'), ent('b', { consolidation_method: 'excluded' }), ent('c', { is_active: false })])).toEqual(['a']);
  });
});

describe('intercompany positions + csv', () => {
  it('groups outstanding balances per pair and skips settled/void', () => {
    const t = (id: string, from: string, to: string, amt: number, settled: number, status: IcTransaction['status']): IcTransaction => ({
      id, txn_number: id, txn_date: '2027-01-01', kind: 'sale', from_entity_id: from, to_entity_id: to, amount_cents: amt, settled_cents: settled, status, description: null, void_reason: null, created_at: '',
    });
    const p = icPositions([t('1', 'a', 'b', 1000, 0, 'open'), t('2', 'a', 'b', 500, 200, 'partially_settled'), t('3', 'b', 'a', 900, 900, 'settled'), t('4', 'b', 'a', 700, 0, 'void')]);
    expect(p).toEqual([{ from_entity_id: 'a', to_entity_id: 'b', open_cents: 1300, count: 2 }]);
  });
  it('exports csv and neutralizes spreadsheet formulas', () => {
    const rows = [...rowsA, ...rowsB].map((r) => (r.code === '1000' ? { ...r, name: '=HYPERLINK("x")' } : r));
    const csv = reportToCsv(buildReport(rows, entities, ['a', 'b']), { from: '2027-01-01', to: '2027-01-31' });
    expect(csv).toContain('Report period 2027-01-01 to 2027-01-31');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('Total assets,,,,,150000.00');
    expect(csv).toContain('Of which non-controlling interest,,,,,8000.00');
  });
});
