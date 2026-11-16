import { describe, it, expect } from 'vitest';
import {
  COGS_MARGIN_FLOOR_PCT, formatCents, formatMicroUsd, formatPct1, microToUsd, monthStart, parseCogsAiActions, parseCogsPlans,
  parseCogsTenants, planStatus, recentMonths, type CogsPlanRow,
} from './cogs';

const plan = (over: Partial<CogsPlanRow> = {}): CogsPlanRow => ({
  month: '2026-10-01', planTier: 'starter', tenantsTotal: 4, tenantsBilled: 4, activeTenants: 4, listPriceCents: 9900, priceIsQuoted: false,
  minutesTotal: 100, minutesCosted: 100, callsTotal: 20, callsCosted: 20, voiceCostMicro: 5_000_000, aiActions: 10, aiCostMicro: 1_000_000,
  otherCostMicro: 0, totalCostMicro: 6_000_000, voiceCostPerMinMicro: 50_000, aiCostPerActionMicro: 100_000,
  subscriptionRevenueCents: 39600, grossMarginCents: 38999.4, grossMarginPct: 98.5, callCostCoveragePct: 100, ...over,
});

describe('parsers', () => {
  it('maps the staff_cogs_by_plan payload and accepts numeric strings from PostgREST', () => {
    const rows = parseCogsPlans({ plans: [{ month: '2026-10-01', plan_tier: 'starter', tenants_billed: '2', list_price_cents: 9900, price_is_quoted: false, voice_cost_per_min_micro: '200000.00', gross_margin_pct: null }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ planTier: 'starter', tenantsBilled: 2, listPriceCents: 9900, voiceCostPerMinMicro: 200000, grossMarginPct: null });
  });
  it('keeps a missing price as null, never 0', () => {
    const [r] = parseCogsPlans({ plans: [{ plan_tier: 'free', list_price_cents: null, subscription_revenue_cents: null }] });
    expect(r.listPriceCents).toBeNull();
    expect(r.subscriptionRevenueCents).toBeNull();
  });
  it('returns empty results for malformed input instead of throwing', () => {
    expect(parseCogsPlans(null)).toEqual([]);
    expect(parseCogsPlans({ plans: 'nope' })).toEqual([]);
    expect(parseCogsTenants(undefined)).toEqual({ rows: [], truncated: false });
    expect(parseCogsAiActions([])).toEqual([]);
  });
  it('parses tenants with the truncated flag and AI actions with a default task', () => {
    const t = parseCogsTenants({ tenants: [{ account_id: 'a', plan_tier: 'pro', is_billed: true, total_cost_micro: 12 }], truncated: true });
    expect(t.truncated).toBe(true);
    expect(t.rows[0]).toMatchObject({ accountId: 'a', isBilled: true, totalCostMicro: 12 });
    expect(parseCogsAiActions({ actions: [{ plan_tier: 'starter', ai_actions: 3 }] })[0].taskType).toBe('unattributed');
  });
});

describe('formatting', () => {
  it('converts micro-USD without float drift for whole cents', () => {
    expect(microToUsd(2_290_000)).toBe(2.29);
    expect(microToUsd(null)).toBeNull();
  });
  it('shows small per-unit costs with 4 decimals and larger totals with 2', () => {
    expect(formatMicroUsd(200_000)).toBe('$0.2000');
    expect(formatMicroUsd(2_290_000)).toBe('$2.29');
    expect(formatMicroUsd(-50_000)).toBe('-$0.0500');
    expect(formatMicroUsd(null)).toBe('—');
  });
  it('formats cents and percentages, with a dash for unknown', () => {
    expect(formatCents(9900)).toBe('$99.00');
    expect(formatCents(null)).toBe('—');
    expect(formatPct1(83.333)).toBe('83.3%');
    expect(formatPct1(null)).toBe('—');
  });
});

describe('planStatus', () => {
  it('is ok when margin clears the floor and coverage is complete', () => {
    expect(planStatus(plan())).toBe('ok');
  });
  it('flags a margin strictly below the floor, but not exactly at it', () => {
    expect(planStatus(plan({ grossMarginPct: COGS_MARGIN_FLOOR_PCT - 0.1 }))).toBe('below_floor');
    expect(planStatus(plan({ grossMarginPct: COGS_MARGIN_FLOOR_PCT }))).toBe('ok');
  });
  it('never judges a free or quoted plan on margin', () => {
    expect(planStatus(plan({ listPriceCents: null, grossMarginPct: null }))).toBe('no_price');
    expect(planStatus(plan({ priceIsQuoted: true, grossMarginPct: null }))).toBe('no_price');
  });
  it('never calls a plan ok when cost coverage is low (a missing cost overstates margin)', () => {
    expect(planStatus(plan({ callCostCoveragePct: 50, grossMarginPct: 99 }))).toBe('low_coverage');
  });
  it('reports no revenue when nobody is billed', () => {
    expect(planStatus(plan({ tenantsBilled: 0, grossMarginPct: null }))).toBe('no_revenue');
  });
});

describe('months', () => {
  it('builds UTC month starts and rolls over the year', () => {
    const now = new Date(Date.UTC(2026, 0, 15));
    expect(monthStart(now)).toBe('2026-01-01');
    expect(monthStart(now, 1)).toBe('2025-12-01');
    expect(recentMonths(now, 3)).toEqual(['2026-01-01', '2025-12-01', '2025-11-01']);
  });
  it('always returns at least one month', () => {
    expect(recentMonths(new Date(Date.UTC(2026, 5, 1)), 0)).toHaveLength(1);
  });
});
