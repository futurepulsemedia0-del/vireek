import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const invoke = vi.fn();
vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), functions: { invoke: (...a: unknown[]) => invoke(...a) } },
}));

import {
  agingRows, describeSchedule, dollarsToCents, draftFromSchedule, emptyDraft, fetchStatement, filterAccounts, fmtDate, overdueOf,
  periodForPreset, saveSchedule, sendStatementNow, setBillTo, statementFileName, statementToCsv, summarizeAccounts, usd,
  validatePeriod, validateScheduleDraft, type Statement, type StatementAccount, type StatementSchedule,
} from './statements';

const acct = (o: Partial<StatementAccount>): StatementAccount => ({
  customer_id: 'c1', name: 'Acme Co', email: 'ap@acme.com', phone: '555-0100', customer_type: 'commercial', child_count: 0,
  invoice_count: 1, balance_cents: 10_000, overdue_cents: 0, oldest_due: null, last_sent_at: null, ...o,
});

const statement = (o: Partial<Statement> = {}): Statement => ({
  customer: { id: 'c1', name: 'Acme, "Co"', email: 'ap@acme.com', phone: null, address: null },
  period_from: '2027-01-01', period_to: '2027-01-31', consolidated: false, members: [{ id: 'c1', name: 'Acme' }],
  opening_cents: 0, charges_cents: 50_000, payments_cents: 20_000, refunds_cents: 0, closing_cents: 30_000,
  lines: [
    { date: '2027-01-05', kind: 'invoice', reference: 'INV-1', description: '=HYPERLINK("x")', customer_name: 'Acme', invoice_number: 'INV-1', charge_cents: 50_000, credit_cents: 0, balance_cents: 50_000 },
    { date: '2027-01-20', kind: 'payment', reference: 'p', description: 'Payment (card) for INV-1', customer_name: 'Acme', invoice_number: 'INV-1', charge_cents: 0, credit_cents: 20_000, balance_cents: 30_000 },
  ],
  open_invoices: [], aging: { current: 30_000, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 }, ...o,
});

beforeEach(() => { rpc.mockReset(); invoke.mockReset(); });

describe('formatting', () => {
  it('formats cents as USD, including negatives and bad input', () => {
    expect(usd(123456)).toBe('$1,234.56');
    expect(usd(-500)).toBe('-$5.00');
    expect(usd(Number.NaN)).toBe('$0.00');
  });
  it('formats ISO dates in UTC without day drift', () => {
    expect(fmtDate('2027-03-01')).toBe('Mar 1, 2027');
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate('garbage')).toBe('—');
  });
});

describe('periods', () => {
  const now = new Date(2027, 2, 15); // 15 Mar 2027 (local)
  it('computes last month, this month, ytd and last 30 days', () => {
    expect(periodForPreset('last_month', now)).toEqual({ from: '2027-02-01', to: '2027-02-28' });
    expect(periodForPreset('this_month', now)).toEqual({ from: '2027-03-01', to: '2027-03-15' });
    expect(periodForPreset('ytd', now)).toEqual({ from: '2027-01-01', to: '2027-03-15' });
    expect(periodForPreset('last_30', now)).toEqual({ from: '2027-02-14', to: '2027-03-15' });
  });
  it('rolls last month across a year boundary', () => {
    expect(periodForPreset('last_month', new Date(2027, 0, 10))).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
  it('validates ranges', () => {
    expect(validatePeriod('2027-01-01', '2027-01-31')).toBeNull();
    expect(validatePeriod('', '2027-01-31')).toMatch(/start and end/);
    expect(validatePeriod('2027-02-01', '2027-01-31')).toMatch(/on or before/);
    expect(validatePeriod('2020-01-01', '2027-01-01')).toMatch(/3 years/);
  });
});

describe('aging + accounts', () => {
  it('computes shares and overdue totals', () => {
    const aging = { current: 50, d1_30: 25, d31_60: 25, d61_90: 0, d90_plus: 0 };
    const rows = agingRows(aging);
    expect(rows.find((r) => r.key === 'current')?.share).toBe(0.5);
    expect(overdueOf(aging)).toBe(50);
    expect(agingRows({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 }).every((r) => r.share === 0)).toBe(true);
  });
  it('filters by search and balance/overdue', () => {
    const list = [acct({}), acct({ customer_id: 'c2', name: 'Beta LLC', email: null, balance_cents: 0 }), acct({ customer_id: 'c3', name: 'Gamma', email: 'pay@gamma.com', overdue_cents: 500 })];
    expect(filterAccounts(list, '', 'balance').map((a) => a.customer_id)).toEqual(['c1', 'c3']);
    expect(filterAccounts(list, '', 'overdue').map((a) => a.customer_id)).toEqual(['c3']);
    expect(filterAccounts(list, 'beta', 'all').map((a) => a.customer_id)).toEqual(['c2']);
    expect(filterAccounts(list, 'AP@ACME', 'all').map((a) => a.customer_id)).toEqual(['c1']);
  });
  it('summarizes the receivable book', () => {
    const s = summarizeAccounts([acct({ overdue_cents: 2_000 }), acct({ customer_id: 'c2', child_count: 3, balance_cents: 5_000 })]);
    expect(s).toEqual({ outstanding: 15_000, overdue: 2_000, withBalance: 2, consolidated: 1 });
  });
});

describe('schedules', () => {
  const sched: StatementSchedule = {
    id: 's1', name: 'Monthly', scope: 'all_open', customer_ids: [], period_mode: 'previous_month', frequency: 'monthly', weekday: 1,
    month_day: 2, send_hour: 8, timezone: 'America/Chicago', min_balance_cents: 2500, consolidate: true, is_active: true,
    next_run_at: null, last_run_at: null, last_status: null, last_summary: null, consecutive_failures: 0, paused_reason: null,
  };
  it('describes cadence in plain English', () => {
    expect(describeSchedule(sched)).toBe('Monthly on the 2nd at 8:00 AM (America/Chicago)');
    expect(describeSchedule({ ...sched, frequency: 'weekly', weekday: 5, send_hour: 13 })).toBe('Every Friday at 1:00 PM (America/Chicago)');
    expect(describeSchedule({ ...sched, month_day: 11, send_hour: 0 })).toBe('Monthly on the 11th at 12:00 AM (America/Chicago)');
  });
  it('parses dollars to cents strictly', () => {
    expect(dollarsToCents('25')).toBe(2500);
    expect(dollarsToCents('$1,250.5')).toBe(125050);
    expect(dollarsToCents('12.345')).toBeNull();
    expect(dollarsToCents('abc')).toBeNull();
    expect(dollarsToCents('-5')).toBeNull();
  });
  it('validates drafts', () => {
    const ok = { ...emptyDraft('UTC'), name: 'Monthly' };
    expect(validateScheduleDraft(ok)).toEqual({});
    expect(validateScheduleDraft({ ...ok, name: '  ' }).name).toBeDefined();
    expect(validateScheduleDraft({ ...ok, scope: 'selected' }).customers).toBeDefined();
    expect(validateScheduleDraft({ ...ok, scope: 'selected', customer_ids: ['a'] }).customers).toBeUndefined();
    expect(validateScheduleDraft({ ...ok, min_balance_dollars: 'x' }).min_balance).toBeDefined();
    expect(validateScheduleDraft({ ...ok, month_day: 31 }).month_day).toBeDefined();
  });
  it('round-trips a schedule through a draft', () => {
    expect(draftFromSchedule(sched).min_balance_dollars).toBe('25.00');
  });
});

describe('csv export', () => {
  it('escapes quotes and neutralizes spreadsheet formulas', () => {
    const csv = statementToCsv(statement());
    expect(csv).toContain('"Acme, ""Co"""');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/,=HYPERLINK/);
    expect(csv).toContain('Closing balance,300.00');
  });
  it('builds a safe file name', () => {
    expect(statementFileName(statement())).toBe('statement-acme-co-2027-01-01-to-2027-01-31.csv');
  });
});

describe('api', () => {
  it('fetchStatement passes the period and consolidation flag', async () => {
    rpc.mockResolvedValue({ data: statement(), error: null });
    await fetchStatement('c1', '2027-01-01', '2027-01-31', false);
    expect(rpc).toHaveBeenCalledWith('get_customer_statement', { p_customer_id: 'c1', p_from: '2027-01-01', p_to: '2027-01-31', p_consolidate: false });
  });
  it('surfaces database errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Not authorized' } });
    await expect(fetchStatement('c1', '2027-01-01', '2027-01-31', true)).rejects.toMatchObject({ message: 'Not authorized' });
  });
  it('saveSchedule converts dollars to cents and drops customers unless scope=selected', async () => {
    rpc.mockResolvedValue({ data: 's1', error: null });
    await saveSchedule({ ...emptyDraft('UTC'), name: ' Monthly ', min_balance_dollars: '10.50', customer_ids: ['x'] });
    const args = rpc.mock.calls[0][1];
    expect(args).toMatchObject({ p_name: 'Monthly', p_min_balance_cents: 1050, p_customer_ids: [], p_scope: 'all_open' });
  });
  it('setBillTo unlinks with null', async () => {
    rpc.mockResolvedValue({ error: null });
    await setBillTo('c2', null);
    expect(rpc).toHaveBeenCalledWith('set_statement_bill_to', { p_customer_id: 'c2', p_payer_id: null });
  });
  it('sendStatementNow recovers the server error message from a non-2xx response', async () => {
    invoke.mockResolvedValue({ data: null, error: { message: 'Edge Function returned a non-2xx status code', context: { json: async () => ({ error: 'No valid email on file.' }) } } });
    await expect(sendStatementNow({ customerId: 'c1', from: '2027-01-01', to: '2027-01-31', consolidate: true })).rejects.toThrow('No valid email on file.');
  });
  it('sendStatementNow only sends a recipient override when given', async () => {
    invoke.mockResolvedValue({ data: { ok: true, recipient: 'a@b.co' }, error: null });
    await sendStatementNow({ customerId: 'c1', from: '2027-01-01', to: '2027-01-31', consolidate: true });
    expect(invoke.mock.calls[0][1].body).not.toHaveProperty('recipient');
    await sendStatementNow({ customerId: 'c1', from: '2027-01-01', to: '2027-01-31', consolidate: true, recipient: 'a@b.co' });
    expect(invoke.mock.calls[1][1].body.recipient).toBe('a@b.co');
  });
});
