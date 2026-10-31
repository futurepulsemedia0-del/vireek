import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  buildCombinedStatement,
  buildEntityStatement,
  dollarsToCents,
  eliminationCheck,
  groupAccess,
  isValidRange,
  normalizePnlRows,
  rangePreset,
  statementToCsv,
  summarizeEntities,
  validateEntityDraft,
  validateIntercompanyDraft,
  type AccessRow,
  type MultiEntityPnlRow,
  type ReportingEntity,
} from './multiEntityReporting';

const MAIN = 'e-main';
const BETA = 'e-beta';
const GAMMA = 'e-gamma';

const row = (over: Partial<MultiEntityPnlRow> & Pick<MultiEntityPnlRow, 'entity_id' | 'account_code' | 'type'>): MultiEntityPnlRow => ({
  entity_code: over.entity_id.toUpperCase(),
  entity_name: over.entity_id,
  account_name: `Account ${over.account_code}`,
  gross_cents: 0,
  intercompany_cents: 0,
  eliminated_cents: 0,
  ...over,
});

// Mirrors the pgTAP fixture: MAIN bills BETA $250 of intercompany services.
const ROWS: MultiEntityPnlRow[] = [
  row({ entity_id: MAIN, account_code: '4000', type: 'revenue', gross_cents: 100000 }),
  row({ entity_id: MAIN, account_code: '4900', type: 'revenue', gross_cents: 25000, intercompany_cents: 25000, eliminated_cents: 25000 }),
  row({ entity_id: BETA, account_code: '4000', type: 'revenue', gross_cents: 40000 }),
  row({ entity_id: BETA, account_code: '6900', type: 'expense', gross_cents: 40000, intercompany_cents: 25000, eliminated_cents: 25000 }),
  row({ entity_id: GAMMA, account_code: '5100', type: 'expense', gross_cents: 30000 }),
];

const entity = (id: string, isDefault = false): ReportingEntity => ({
  entity_id: id,
  entity_code: id.toUpperCase(),
  entity_name: id,
  is_default: isDefault,
  is_active: true,
  entry_count: 0,
  created_at: '2026-01-01T00:00:00Z',
});

describe('per-entity P&L', () => {
  it('keeps intercompany inside the entity’s own books', () => {
    const main = buildEntityStatement(ROWS, MAIN).totals;
    expect(main.revenue_cents).toBe(125000);
    expect(main.net_cents).toBe(125000);
    expect(main.margin_pct).toBe(100);

    const beta = buildEntityStatement(ROWS, BETA).totals;
    expect(beta.revenue_cents).toBe(40000);
    expect(beta.expense_cents).toBe(40000);
    expect(beta.net_cents).toBe(0);
    expect(beta.eliminated_expense_cents).toBe(0);
  });

  it('reports a loss with no margin when there is no revenue', () => {
    const gamma = buildEntityStatement(ROWS, GAMMA).totals;
    expect(gamma.net_cents).toBe(-30000);
    expect(gamma.margin_pct).toBeNull();
  });

  it('returns an empty statement for an entity with no rows', () => {
    const s = buildEntityStatement(ROWS, 'nobody');
    expect(s.revenue).toHaveLength(0);
    expect(s.totals.net_cents).toBe(0);
  });
});

describe('combined view and elimination', () => {
  it('without elimination equals the sum of the entities', () => {
    const t = buildCombinedStatement(ROWS, false).totals;
    expect(t.revenue_cents).toBe(165000);
    expect(t.expense_cents).toBe(70000);
    expect(t.net_cents).toBe(95000);
  });

  it('with elimination removes both sides and leaves net income unchanged', () => {
    const t = buildCombinedStatement(ROWS, true).totals;
    expect(t.revenue_cents).toBe(140000);
    expect(t.expense_cents).toBe(45000);
    expect(t.net_cents).toBe(95000);
    expect(t.eliminated_revenue_cents).toBe(25000);
    expect(t.eliminated_expense_cents).toBe(25000);
  });

  it('merges the same account across entities and sorts by code', () => {
    const s = buildCombinedStatement(ROWS, true);
    expect(s.revenue.map((l) => l.account_code)).toEqual(['4000', '4900']);
    expect(s.revenue[0].amount_cents).toBe(140000);
    expect(s.revenue[1].amount_cents).toBe(0);
  });

  it('is balanced when both halves are eliminated', () => {
    expect(eliminationCheck(ROWS)).toEqual({
      eliminated_revenue_cents: 25000,
      eliminated_expense_cents: 25000,
      mismatch_cents: 0,
      balanced: true,
    });
  });

  it('flags a one-sided elimination', () => {
    const oneSided = ROWS.map((r) => (r.entity_id === BETA && r.type === 'expense' ? { ...r, eliminated_cents: 0 } : r));
    const check = eliminationCheck(oneSided);
    expect(check.balanced).toBe(false);
    expect(check.mismatch_cents).toBe(25000);
  });
});

describe('entity summaries', () => {
  it('computes each entity’s share of gross revenue', () => {
    const s = summarizeEntities(ROWS, [entity(MAIN, true), entity(BETA), entity(GAMMA)]);
    expect(s[0].revenue_share_pct).toBeCloseTo((125000 / 165000) * 100, 6);
    expect(s[1].revenue_share_pct).toBeCloseTo((40000 / 165000) * 100, 6);
    expect(s[2].revenue_share_pct).toBe(0);
  });

  it('has no share when nothing was earned', () => {
    expect(summarizeEntities([], [entity(MAIN, true)])[0].revenue_share_pct).toBeNull();
  });
});

describe('normalizePnlRows', () => {
  it('coerces numeric strings and rejects non-arrays', () => {
    const out = normalizePnlRows([
      { entity_id: 'a', entity_code: 'A', entity_name: 'A', account_code: '4000', account_name: 'Sales', type: 'revenue', gross_cents: '1200', intercompany_cents: null, eliminated_cents: undefined },
    ]);
    expect(out[0].gross_cents).toBe(1200);
    expect(out[0].intercompany_cents).toBe(0);
    expect(out[0].eliminated_cents).toBe(0);
    expect(normalizePnlRows(null)).toEqual([]);
  });
});

describe('dates', () => {
  const today = new Date(2026, 10, 15); // 15 Nov 2026 (local)
  it('builds range presets', () => {
    expect(rangePreset('month', today)).toEqual({ start: '2026-11-01', end: '2026-11-15' });
    expect(rangePreset('last_month', today)).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(rangePreset('quarter', today)).toEqual({ start: '2026-10-01', end: '2026-11-15' });
    expect(rangePreset('year', today)).toEqual({ start: '2026-01-01', end: '2026-11-15' });
  });
  it('rolls last month back across a year boundary', () => {
    expect(rangePreset('last_month', new Date(2027, 0, 9))).toEqual({ start: '2026-12-01', end: '2026-12-31' });
  });
  it('validates ranges', () => {
    expect(isValidRange('2026-01-01', '2026-01-01')).toBe(true);
    expect(isValidRange('2026-02-01', '2026-01-01')).toBe(false);
    expect(isValidRange('', '2026-01-01')).toBe(false);
  });
});

describe('forms', () => {
  it('parses dollars to cents safely', () => {
    expect(dollarsToCents('1,234.56')).toBe(123456);
    expect(dollarsToCents('$5')).toBe(500);
    expect(dollarsToCents('0.5')).toBe(50);
    expect(dollarsToCents('0')).toBeNull();
    expect(dollarsToCents('-4')).toBeNull();
    expect(dollarsToCents('1.234')).toBeNull();
    expect(dollarsToCents('abc')).toBeNull();
    expect(dollarsToCents('99999999999')).toBeNull();
  });

  it('validates entity drafts', () => {
    expect(validateEntityDraft('Beta LLC', 'beta')).toEqual({});
    expect(validateEntityDraft('', 'beta').name).toBeTruthy();
    expect(validateEntityDraft('Beta', 'bad code!').code).toBeTruthy();
  });

  it('validates intercompany drafts', () => {
    const ok = {
      date: '2026-09-20', memo: '', providerId: 'a', recipientId: 'b', amount: '250',
      receivableId: 'r', revenueId: 'v', expenseId: 'x', payableId: 'p',
    };
    expect(validateIntercompanyDraft(ok)).toEqual({});
    expect(validateIntercompanyDraft({ ...ok, recipientId: 'a' }).recipientId).toBeTruthy();
    expect(validateIntercompanyDraft({ ...ok, amount: '0' }).amount).toBeTruthy();
  });
});

describe('access matrix', () => {
  it('groups rows into entities, members and grants', () => {
    const rows: AccessRow[] = [
      { entity_id: 'e1', entity_code: 'MAIN', entity_name: 'Main', member_user_id: 'u1', member_name: null, member_email: 'u1@x.test', has_access: true },
      { entity_id: 'e2', entity_code: 'BETA', entity_name: 'Beta', member_user_id: 'u1', member_name: null, member_email: 'u1@x.test', has_access: false },
    ];
    const g = groupAccess(rows);
    expect(g.entities).toHaveLength(2);
    expect(g.members).toHaveLength(1);
    expect(g.members[0].name).toBe('u1@x.test');
    expect(g.granted.has('e1:u1')).toBe(true);
    expect(g.granted.has('e2:u1')).toBe(false);
  });
});

describe('CSV export', () => {
  it('guards text cells against spreadsheet formulas but keeps negative money', () => {
    const rows = [
      row({ entity_id: MAIN, account_code: '4000', type: 'revenue', gross_cents: 1000, account_name: '=HYPERLINK("x")' }),
      row({ entity_id: MAIN, account_code: '6000', type: 'expense', gross_cents: 5000 }),
    ];
    const csv = statementToCsv(buildCombinedStatement(rows, true));
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('Total,,Net income,,,-40.00');
  });
});
