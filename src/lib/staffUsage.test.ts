import { describe, it, expect } from 'vitest';
import {
  buildDailyCosts,
  computeTenantEconomics,
  computeTotals,
  csvCell,
  filterAndSort,
  formatMinutes,
  formatUsd,
  paginate,
  parseReport,
  periodWindow,
  planEconomics,
  tenantsToCsv,
  type TenantUsageRow,
} from './staffUsage';

function row(over: Partial<TenantUsageRow> = {}): TenantUsageRow {
  return {
    account_id: 'acc-1', email: 'a@x.com', company_name: 'Cool Air', plan: 'starter',
    ai_cost_usd: 2, ai_calls: 10, ai_failed: 1, ai_fallbacks: 0, input_tokens: 1000, output_tokens: 500,
    voice_seconds: 18000, voice_calls: 40, ...over,
  };
}

describe('planEconomics', () => {
  it('reads price, included minutes (with thousands separators) and overage from the pricing source of truth', () => {
    expect(planEconomics('starter')).toMatchObject({ monthlyPrice: 79, includedMinutes: 400, overageRate: 0.2 });
    expect(planEconomics('professional')).toMatchObject({ monthlyPrice: 199, includedMinutes: 1500, overageRate: 0.15 });
  });
  it('treats enterprise as unpriced/unlimited and unknown plans safely', () => {
    expect(planEconomics('enterprise')).toMatchObject({ monthlyPrice: null, includedMinutes: Infinity, overageRate: null });
    expect(planEconomics('mystery')).toMatchObject({ id: 'unknown', monthlyPrice: null, name: 'mystery' });
    expect(planEconomics(null).name).toBe('Unknown');
  });
});

describe('periodWindow', () => {
  const now = new Date('2026-10-08T15:00:00Z');
  it('rolling windows start at UTC midnight n-1 days ago', () => {
    const w = periodWindow('30d', now);
    expect(w.days).toBe(30);
    expect(w.start.toISOString()).toBe('2026-09-09T00:00:00.000Z');
    expect(w.end.toISOString()).toBe(now.toISOString());
  });
  it('month-to-date starts on the 1st and prorates by elapsed days', () => {
    const w = periodWindow('mtd', now);
    expect(w.start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(w.days).toBeCloseTo(7.625, 3);
  });
});

describe('computeTenantEconomics', () => {
  it('healthy: list price minus AI + voice cost', () => {
    const e = computeTenantEconomics(row(), 0.12, 30); // 300 min -> $36 voice, +$2 AI
    expect(e.voiceCostUsd).toBeCloseTo(36, 6);
    expect(e.totalCostUsd).toBeCloseTo(38, 6);
    expect(e.revenueUsd).toBe(79);
    expect(e.marginUsd).toBeCloseTo(41, 6);
    expect(e.marginPct).toBeCloseTo(51.9, 1);
    expect(e.health).toBe('healthy');
  });
  it('adds metered overage revenue beyond the included minutes', () => {
    const e = computeTenantEconomics(row({ voice_seconds: 500 * 60, ai_cost_usd: 5 }), 0.12, 30);
    expect(e.revenueUsd).toBeCloseTo(79 + 100 * 0.2, 6);
    expect(e.marginUsd).toBeCloseTo(99 - 65, 6);
  });
  it('flags thin (<30%) and loss-making tenants', () => {
    expect(computeTenantEconomics(row({ voice_seconds: 0, ai_cost_usd: 60 }), 0.12, 30).health).toBe('thin');
    const loss = computeTenantEconomics(row({ voice_seconds: 0, ai_cost_usd: 100 }), 0.12, 30);
    expect(loss.health).toBe('loss');
    expect(loss.marginUsd).toBeCloseTo(-21, 6);
  });
  it('free plan with any cost is a loss with no percentage', () => {
    const e = computeTenantEconomics(row({ plan: 'free', voice_seconds: 0, ai_cost_usd: 0.5 }), 0.12, 30);
    expect(e).toMatchObject({ revenueUsd: 0, health: 'loss', marginPct: null });
  });
  it('enterprise/unknown plans are unpriced (no fabricated margin)', () => {
    const e = computeTenantEconomics(row({ plan: 'enterprise' }), 0.12, 30);
    expect(e).toMatchObject({ revenueUsd: null, marginUsd: null, marginPct: null, health: 'unpriced' });
  });
  it('prorates the subscription and included minutes for partial periods', () => {
    const e = computeTenantEconomics(row({ voice_seconds: 0, ai_cost_usd: 0 }), 0.12, 15);
    expect(e.revenueUsd).toBeCloseTo(39.5, 6);
  });
});

describe('computeTotals', () => {
  it('computes margin over priced tenants only and counts problem tenants', () => {
    const rows = [
      computeTenantEconomics(row(), 0.12, 30),
      computeTenantEconomics(row({ account_id: 'b', voice_seconds: 0, ai_cost_usd: 100 }), 0.12, 30),
      computeTenantEconomics(row({ account_id: 'c', plan: 'enterprise', ai_cost_usd: 500 }), 0.12, 30),
    ];
    const t = computeTotals(rows, 1.5);
    expect(t.tenants).toBe(3);
    expect(t.revenueUsd).toBe(158);
    expect(t.lossMakers).toBe(1);
    expect(t.unpricedTenants).toBe(1);
    expect(t.marginUsd).toBeCloseTo(158 - 38 - 100, 6);
    expect(t.aiCostUsd).toBeCloseTo(2 + 100 + 500, 6);
    expect(t.unattributedCostUsd).toBe(1.5);
  });
  it('has a null margin % with no priced revenue', () => {
    expect(computeTotals([]).marginPct).toBeNull();
  });
});

describe('filterAndSort / paginate', () => {
  const a = computeTenantEconomics(row({ account_id: 'a', company_name: 'Alpha HVAC', ai_cost_usd: 1 }), 0.12, 30);
  const b = computeTenantEconomics(row({ account_id: 'b', company_name: 'Beta Plumbing', voice_seconds: 0, ai_cost_usd: 100 }), 0.12, 30);
  const c = computeTenantEconomics(row({ account_id: 'c', company_name: 'Gamma', plan: 'enterprise' }), 0.12, 30);
  it('sorts by margin descending with unknown values last in both directions', () => {
    const desc = filterAndSort([b, c, a], { query: '', health: 'all', sortKey: 'margin', sortDir: 'desc' });
    expect(desc.map((r) => r.account_id)).toEqual(['a', 'b', 'c']);
    const asc = filterAndSort([a, b, c], { query: '', health: 'all', sortKey: 'margin', sortDir: 'asc' });
    expect(asc.map((r) => r.account_id)).toEqual(['b', 'a', 'c']);
  });
  it('searches name/email/id prefix and filters by health', () => {
    expect(filterAndSort([a, b, c], { query: 'plumb', health: 'all', sortKey: 'name', sortDir: 'asc' }).map((r) => r.account_id)).toEqual(['b']);
    expect(filterAndSort([a, b, c], { query: '', health: 'loss', sortKey: 'name', sortDir: 'asc' }).map((r) => r.account_id)).toEqual(['b']);
  });
  it('paginates and clamps out-of-range pages', () => {
    const items = Array.from({ length: 120 }, (_, i) => i);
    expect(paginate(items, 1, 50).items).toHaveLength(50);
    expect(paginate(items, 3, 50).items).toHaveLength(20);
    expect(paginate(items, 99, 50).page).toBe(3);
    expect(paginate([], 1, 50)).toMatchObject({ pages: 1, page: 1, items: [] });
  });
});

describe('buildDailyCosts', () => {
  it('fills gaps with zeros and prices voice minutes', () => {
    const out = buildDailyCosts(
      [{ day: '2026-10-07', ai_cost_usd: 1, ai_calls: 3, voice_seconds: 600 }],
      new Date('2026-10-06T00:00:00Z'),
      new Date('2026-10-08T12:00:00Z'),
      0.12,
    );
    expect(out.map((d) => d.day)).toEqual(['2026-10-06', '2026-10-07', '2026-10-08']);
    expect(out[0].totalUsd).toBe(0);
    expect(out[1].voiceCostUsd).toBeCloseTo(1.2, 6);
    expect(out[1].totalUsd).toBeCloseTo(2.2, 6);
  });
});

describe('csv + formatting + parsing', () => {
  it('quotes cells and neutralises spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-5 apples')).toBe("'-5 apples");
    expect(csvCell(null)).toBe('');
    expect(csvCell(-5)).toBe('-5');
  });
  it('exports one header + one line per tenant', () => {
    const csv = tenantsToCsv([computeTenantEconomics(row(), 0.12, 30)]);
    expect(csv.split('\n')).toHaveLength(2);
    expect(csv.split('\n')[1]).toContain('Cool Air');
  });
  it('formats money, minutes', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(0.0123)).toBe('$0.0123');
    expect(formatUsd(-3)).toBe('-$3.00');
    expect(formatUsd(null)).toBe('—');
    expect(formatMinutes(0)).toBe('0 min');
    expect(formatMinutes(12.34)).toBe('12.3 min');
    expect(formatMinutes(1234.5)).toBe('1,235 min');
  });
  it('parses the RPC payload defensively (numeric strings, missing arrays) and rejects junk', () => {
    expect(parseReport(null)).toBeNull();
    expect(parseReport({})).toBeNull();
    const r = parseReport({
      tenants: [{ account_id: 'x', plan: 'starter', ai_cost_usd: '1.5', voice_seconds: '120' }],
      unattributed_cost_usd: '0.25', truncated: true,
    });
    expect(r?.tenants[0]).toMatchObject({ account_id: 'x', ai_cost_usd: 1.5, voice_seconds: 120, ai_calls: 0, email: null });
    expect(r?.daily).toEqual([]);
    expect(r?.unattributed_cost_usd).toBe(0.25);
    expect(r?.truncated).toBe(true);
  });
});
