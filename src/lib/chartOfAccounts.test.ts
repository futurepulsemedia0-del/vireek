import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/accounting', () => ({ ensureChartOfAccounts: vi.fn() }));

import {
  buildAccountRows,
  countUnmapped,
  describeAuditEvent,
  descendantIds,
  errMsg,
  filterRows,
  isContra,
  lockedThroughLabel,
  money,
  monthName,
  naturalBalance,
  suggestNextCode,
  summarizeAccounts,
  validateAccountDraft,
  type AccountDraft,
  type AuditEvent,
  type CoaAccount,
  type PeriodRow,
  type ServiceMappingRow,
} from './chartOfAccounts';

const acct = (over: Partial<CoaAccount> & Pick<CoaAccount, 'id' | 'code'>): CoaAccount => ({
  name: `Account ${over.code}`,
  type: 'asset',
  normal_balance: 'debit',
  is_system: false,
  is_active: true,
  parent_account_id: null,
  description: null,
  line_count: 0,
  balance_cents: 0,
  mapping_count: 0,
  ...over,
});

const draft = (over: Partial<AccountDraft> = {}): AccountDraft => ({
  code: '1300',
  name: 'Prepaid Expenses',
  type: 'asset',
  contra: false,
  parentId: '',
  description: '',
  ...over,
});

describe('naturalBalance / isContra', () => {
  it('maps each type to its natural side and flips for contra accounts', () => {
    expect(naturalBalance('asset')).toBe('debit');
    expect(naturalBalance('expense')).toBe('debit');
    expect(naturalBalance('liability')).toBe('credit');
    expect(naturalBalance('equity')).toBe('credit');
    expect(naturalBalance('revenue')).toBe('credit');
    expect(naturalBalance('asset', true)).toBe('credit');
    expect(naturalBalance('revenue', true)).toBe('debit');
  });

  it('detects contra accounts from the stored normal balance', () => {
    expect(isContra({ type: 'asset', normal_balance: 'credit' })).toBe(true);
    expect(isContra({ type: 'asset', normal_balance: 'debit' })).toBe(false);
    expect(isContra({ type: 'revenue', normal_balance: 'debit' })).toBe(true);
  });
});

describe('money / errMsg / monthName', () => {
  it('formats negative cents with a leading minus', () => {
    expect(money(123456)).toBe('$1,234.56');
    expect(money(-500)).toBe('-$5.00');
    expect(money(0)).toBe('$0.00');
  });

  it('extracts messages from Error objects and plain Postgrest-style errors', () => {
    expect(errMsg(new Error('boom'))).toBe('boom');
    expect(errMsg({ message: 'Account code 1000 is already in use' })).toBe('Account code 1000 is already in use');
    expect(errMsg(null)).toBe('Something went wrong.');
    expect(errMsg({ message: '' })).toBe('Something went wrong.');
  });

  it('names months without timezone drift', () => {
    expect(monthName('2027-01-01')).toBe('January');
    expect(monthName('2027-12-01')).toBe('December');
  });
});

describe('buildAccountRows', () => {
  it('orders by numeric code and nests children under their parent', () => {
    const rows = buildAccountRows([
      acct({ id: 'c', code: '1110', parent_account_id: 'a' }),
      acct({ id: 'b', code: '1200' }),
      acct({ id: 'a', code: '1000' }),
      acct({ id: 'd', code: '1100', parent_account_id: 'a' }),
      acct({ id: 'e', code: '999' }),
    ]);
    expect(rows.map((r) => [r.account.code, r.depth])).toEqual([
      ['999', 0],
      ['1000', 0],
      ['1100', 1],
      ['1110', 1],
      ['1200', 0],
    ]);
  });

  it('treats an account with a missing parent as a root', () => {
    const rows = buildAccountRows([acct({ id: 'a', code: '1000', parent_account_id: 'ghost' })]);
    expect(rows).toEqual([{ account: expect.objectContaining({ id: 'a' }), depth: 0 }]);
  });

  it('never loops or drops accounts when data contains a cycle', () => {
    const rows = buildAccountRows([
      acct({ id: 'a', code: '1000', parent_account_id: 'b' }),
      acct({ id: 'b', code: '1100', parent_account_id: 'a' }),
    ]);
    expect(rows.map((r) => r.account.id).sort()).toEqual(['a', 'b']);
  });
});

describe('filterRows', () => {
  const rows = buildAccountRows([
    acct({ id: 'a', code: '1000', name: 'Cash and Bank' }),
    acct({ id: 'b', code: '4000', name: 'Service Revenue', type: 'revenue', normal_balance: 'credit' }),
    acct({ id: 'c', code: '6100', name: 'Fuel', type: 'expense', is_active: false, description: 'Truck diesel' }),
  ]);

  it('hides inactive accounts unless asked', () => {
    expect(filterRows(rows, { query: '', type: 'all', showInactive: false }).map((r) => r.account.id)).toEqual(['a', 'b']);
    expect(filterRows(rows, { query: '', type: 'all', showInactive: true })).toHaveLength(3);
  });

  it('filters by type and by code, name or description (case-insensitive)', () => {
    expect(filterRows(rows, { query: '', type: 'revenue', showInactive: true }).map((r) => r.account.id)).toEqual(['b']);
    expect(filterRows(rows, { query: 'CASH', type: 'all', showInactive: true }).map((r) => r.account.id)).toEqual(['a']);
    expect(filterRows(rows, { query: 'diesel', type: 'all', showInactive: true }).map((r) => r.account.id)).toEqual(['c']);
    expect(filterRows(rows, { query: '41', type: 'all', showInactive: true })).toHaveLength(0);
  });
});

describe('descendantIds', () => {
  it('returns the account and all nested children', () => {
    const accounts = [
      acct({ id: 'a', code: '1000' }),
      acct({ id: 'b', code: '1100', parent_account_id: 'a' }),
      acct({ id: 'c', code: '1110', parent_account_id: 'b' }),
      acct({ id: 'x', code: '1200' }),
    ];
    expect([...descendantIds(accounts, 'a')].sort()).toEqual(['a', 'b', 'c']);
    expect([...descendantIds(accounts, 'x')]).toEqual(['x']);
  });
});

describe('validateAccountDraft', () => {
  const accounts = [
    acct({ id: 'a', code: '1000' }),
    acct({ id: 'b', code: '1100', parent_account_id: 'a' }),
    acct({ id: 'r', code: '4000', type: 'revenue', normal_balance: 'credit' }),
  ];

  it('accepts a valid draft', () => {
    expect(validateAccountDraft(draft(), accounts, null)).toEqual({});
  });

  it('requires and pattern-checks the code', () => {
    expect(validateAccountDraft(draft({ code: '' }), accounts, null).code).toBeTruthy();
    expect(validateAccountDraft(draft({ code: '1' }), accounts, null).code).toBeTruthy();
    expect(validateAccountDraft(draft({ code: '12 00' }), accounts, null).code).toBeTruthy();
    expect(validateAccountDraft(draft({ code: '1200-A.1' }), accounts, null).code).toBeUndefined();
  });

  it('rejects duplicate codes but allows keeping your own code while editing', () => {
    expect(validateAccountDraft(draft({ code: '1000' }), accounts, null).code).toMatch(/in use/);
    expect(validateAccountDraft(draft({ code: '1000' }), accounts, 'a').code).toBeUndefined();
    expect(validateAccountDraft(draft({ code: '1000' }), accounts, 'b').code).toMatch(/in use/);
  });

  it('requires a name and bounds the description', () => {
    expect(validateAccountDraft(draft({ name: '   ' }), accounts, null).name).toBeTruthy();
    expect(validateAccountDraft(draft({ description: 'x'.repeat(501) }), accounts, null).description).toBeTruthy();
  });

  it('requires a parent of the same type and blocks loops', () => {
    expect(validateAccountDraft(draft({ parentId: 'r' }), accounts, null).parent).toMatch(/same type/);
    expect(validateAccountDraft(draft({ parentId: 'a' }), accounts, null).parent).toBeUndefined();
    expect(validateAccountDraft(draft({ code: '1000', parentId: 'b' }), accounts, 'a').parent).toMatch(/loop/);
    expect(validateAccountDraft(draft({ parentId: 'missing' }), accounts, null).parent).toBeTruthy();
  });
});

describe('suggestNextCode', () => {
  it('steps by 10 inside the conventional range for the type', () => {
    const accounts = [acct({ id: 'a', code: '1000' }), acct({ id: 'b', code: '1500' })];
    expect(suggestNextCode(accounts, 'asset')).toBe('1510');
    expect(suggestNextCode(accounts, 'liability')).toBe('2000');
    expect(suggestNextCode([], 'revenue')).toBe('4000');
  });

  it('ignores non-numeric codes and falls back to single steps when the range is full of tens', () => {
    expect(suggestNextCode([acct({ id: 'a', code: 'X-1' })], 'equity')).toBe('3000');
    const full = [];
    for (let n = 1000; n <= 1999; n += 10) full.push(acct({ id: String(n), code: String(n) }));
    expect(suggestNextCode(full, 'asset')).toBe('1001');
  });

  it('returns an empty string when the whole range is taken', () => {
    const full = [];
    for (let n = 3000; n <= 3999; n += 1) full.push(acct({ id: String(n), code: String(n), type: 'equity', normal_balance: 'credit' }));
    expect(suggestNextCode(full, 'equity')).toBe('');
  });
});

describe('summaries', () => {
  it('counts active, inactive, system and used accounts', () => {
    expect(
      summarizeAccounts([
        acct({ id: 'a', code: '1000', is_system: true, line_count: 4 }),
        acct({ id: 'b', code: '1100', is_active: false }),
        acct({ id: 'c', code: '1200' }),
      ]),
    ).toEqual({ active: 2, inactive: 1, system: 1, withActivity: 1 });
  });

  it('counts services that still have no mapping', () => {
    const r = (mapping_id: string | null): ServiceMappingRow => ({
      service_name: 'x', in_price_book: true, job_count: 1, mapping_id, revenue_account_id: mapping_id ? 'a' : null, notes: null,
    });
    expect(countUnmapped([r(null), r('m1'), r(null)])).toBe(2);
    expect(countUnmapped([])).toBe(0);
  });

  it('reports the latest closed month, or null', () => {
    const p = (period_start: string, status: 'open' | 'closed'): PeriodRow => ({
      period_start, period_end: period_start, status, closed_at: null, entry_count: 0,
    });
    expect(lockedThroughLabel([p('2027-01-01', 'closed'), p('2027-02-01', 'closed'), p('2027-03-01', 'open')])).toBe('February 2027');
    expect(lockedThroughLabel([p('2027-01-01', 'open')])).toBeNull();
  });
});

describe('describeAuditEvent', () => {
  const ev = (entity_type: AuditEvent['entity_type'], action: string, detail: Record<string, unknown>): AuditEvent => ({
    id: '1', actor_id: null, entity_type, entity_id: null, action, detail, created_at: '2027-04-01T00:00:00Z',
  });

  it('describes account, mapping and period events in plain language', () => {
    expect(describeAuditEvent(ev('account', 'created', { code: '1300', name: 'Prepaid' }))).toBe('Created account 1300 · Prepaid');
    expect(describeAuditEvent(ev('service_mapping', 'mapped', { service: 'AC Repair', account_code: '4000', account_name: 'Service Revenue' }))).toBe(
      'Mapped “AC Repair” to 4000 · Service Revenue',
    );
    expect(describeAuditEvent(ev('period', 'closed', { period_start: '2027-03-01' }))).toBe('Closed March 2027');
    expect(describeAuditEvent(ev('period', 'reopened', { period_start: '2027-03-01', reason: 'Late vendor bill' }))).toBe(
      'Reopened March 2027 — Late vendor bill',
    );
  });

  it('falls back gracefully for unknown events', () => {
    expect(describeAuditEvent(ev('account', 'archived_forever', {}))).toBe('account archived forever');
  });
});
