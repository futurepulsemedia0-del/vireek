import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  describeRule,
  emptyRuleDraft,
  formatKpi,
  formatUsd,
  isCurrentPeriod,
  ordinal,
  periodLabel,
  periodWindow,
  podium,
  sanitizeWeights,
  shiftAnchor,
  sortBoard,
  summarizePayouts,
  thresholdToInput,
  validateRuleDraft,
  type LeaderboardRow,
  type RuleDraft,
  type SpiffKpi,
} from './technicianLeaderboard';

const ranks = (overall: number | null): LeaderboardRow['ranks'] => ({
  overall,
  first_time_fix_rate: overall,
  upsell_rate: overall,
  csat_avg: overall,
  revenue_cents: overall,
  jobs_completed: overall,
});

const row = (name: string, overall: number | null, over: Partial<LeaderboardRow> = {}): LeaderboardRow => ({
  team_member_id: name.toLowerCase(),
  name,
  is_me: false,
  jobs_completed: 5,
  first_time_fix_rate: 90,
  upsell_rate: 30,
  upsell_opportunities: 4,
  csat_avg: 4.8,
  csat_responses: 5,
  revenue_cents: 500_000,
  overall_score: 80,
  eligible: overall !== null,
  ranks: ranks(overall),
  ...over,
});

const draft = (over: Partial<RuleDraft> = {}): RuleDraft => ({ ...emptyRuleDraft(), name: 'Rule', threshold: '90', payout: '25', ...over });

describe('periodWindow', () => {
  it('uses Monday-start ISO weeks', () => {
    expect(periodWindow('weekly', '2026-10-14')).toEqual({ start: '2026-10-12', end: '2026-10-18' }); // Wed
    expect(periodWindow('weekly', '2026-10-18')).toEqual({ start: '2026-10-12', end: '2026-10-18' }); // Sun
    expect(periodWindow('weekly', '2026-10-12')).toEqual({ start: '2026-10-12', end: '2026-10-18' }); // Mon
  });

  it('handles month lengths and leap years', () => {
    expect(periodWindow('monthly', '2026-02-10')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(periodWindow('monthly', '2028-02-10')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(periodWindow('monthly', '2026-12-31')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
  });

  it('spans year boundaries for weeks', () => {
    expect(periodWindow('weekly', '2027-01-01')).toEqual({ start: '2026-12-28', end: '2027-01-03' });
  });
});

describe('shiftAnchor / isCurrentPeriod', () => {
  it('moves by whole periods', () => {
    expect(shiftAnchor('weekly', '2026-10-14', -1)).toBe('2026-10-05');
    expect(shiftAnchor('weekly', '2026-10-14', 1)).toBe('2026-10-19');
    expect(shiftAnchor('monthly', '2026-01-15', -1)).toBe('2025-12-01');
    expect(shiftAnchor('monthly', '2026-12-15', 1)).toBe('2027-01-01');
  });

  it('knows the current period', () => {
    expect(isCurrentPeriod('weekly', '2026-10-13', '2026-10-18')).toBe(true);
    expect(isCurrentPeriod('weekly', '2026-10-11', '2026-10-18')).toBe(false);
    expect(isCurrentPeriod('monthly', '2026-10-01', '2026-10-31')).toBe(true);
  });
});

describe('periodLabel', () => {
  it('labels months and weeks readably', () => {
    expect(periodLabel('monthly', '2026-10-01', '2026-10-31')).toBe('October 2026');
    expect(periodLabel('weekly', '2026-10-12', '2026-10-18')).toBe('Oct 12 – 18, 2026');
    expect(periodLabel('weekly', '2026-10-26', '2026-11-01')).toBe('Oct 26 – Nov 1, 2026');
  });
});

describe('formatting', () => {
  it('formats money and KPIs', () => {
    expect(formatUsd(12_345)).toBe('$123.45');
    expect(formatUsd(null)).toBe('$0.00');
    expect(formatKpi('first_time_fix_rate', 93.456)).toBe('93.5%');
    expect(formatKpi('csat_avg', 4.8)).toBe('4.80 / 5');
    expect(formatKpi('revenue_cents', 250_000)).toBe('$2,500.00');
    expect(formatKpi('jobs_completed', 12)).toBe('12');
    expect(formatKpi('overall', null)).toBe('—');
  });

  it('writes ordinals including teens', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
  });
});

describe('sortBoard / podium', () => {
  const rows = [row('Cara', 3), row('Zed', null), row('Abe', 1), row('Bo', 2), row('Ana', null)];

  it('sorts best first and sinks unranked rows, alphabetically', () => {
    expect(sortBoard(rows, 'overall').map((r) => r.name)).toEqual(['Abe', 'Bo', 'Cara', 'Ana', 'Zed']);
  });

  it('does not mutate its input', () => {
    const before = rows.map((r) => r.name);
    sortBoard(rows, 'overall');
    expect(rows.map((r) => r.name)).toEqual(before);
  });

  it('keeps tied ranks together and orders them by name', () => {
    const tied = [row('Mia', 1), row('Al', 1), row('Zo', 3)];
    expect(sortBoard(tied, 'overall').map((r) => r.name)).toEqual(['Al', 'Mia', 'Zo']);
  });

  it('returns only the top three for the podium', () => {
    expect(podium([...rows, row('Dan', 4)], 'overall').map((r) => r.name)).toEqual(['Abe', 'Bo', 'Cara']);
  });

  it('ranks by an individual KPI independently of overall', () => {
    const a = row('A', 1, { ranks: { ...ranks(1), csat_avg: 2 } });
    const b = row('B', 2, { ranks: { ...ranks(2), csat_avg: 1 } });
    const kpi: SpiffKpi = 'csat_avg';
    expect(sortBoard([a, b], kpi).map((r) => r.name)).toEqual(['B', 'A']);
  });
});

describe('validateRuleDraft — threshold rules', () => {
  it('accepts a valid rule and converts dollars to cents', () => {
    const v = validateRuleDraft(draft({ kpi: 'revenue_cents', threshold: '5,000.50', payout: '$100' }));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.threshold).toBe(500_050);
      expect(v.payload.payout_cents).toBe(10_000);
      expect(v.payload.rank_payouts_cents).toBeNull();
    }
  });

  it('keeps percentage and rating thresholds in their own units', () => {
    const pct = validateRuleDraft(draft({ kpi: 'first_time_fix_rate', threshold: '92.5' }));
    const stars = validateRuleDraft(draft({ kpi: 'csat_avg', threshold: '4.7' }));
    expect(pct.ok && pct.payload.threshold).toBe(92.5);
    expect(stars.ok && stars.payload.threshold).toBe(4.7);
  });

  it('rejects out-of-range targets per KPI', () => {
    expect(validateRuleDraft(draft({ kpi: 'first_time_fix_rate', threshold: '101' })).ok).toBe(false);
    expect(validateRuleDraft(draft({ kpi: 'upsell_rate', threshold: '150' })).ok).toBe(false);
    expect(validateRuleDraft(draft({ kpi: 'csat_avg', threshold: '5.5' })).ok).toBe(false);
    expect(validateRuleDraft(draft({ kpi: 'csat_avg', threshold: '0.5' })).ok).toBe(false);
    expect(validateRuleDraft(draft({ kpi: 'overall', threshold: '120' })).ok).toBe(false);
    expect(validateRuleDraft(draft({ kpi: 'jobs_completed', threshold: '7.5' })).ok).toBe(false);
  });

  it('requires a name, a target and a sane payout', () => {
    const bad = validateRuleDraft(draft({ name: '  ', threshold: '', payout: '0' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['name', 'payout', 'threshold']);
    expect(validateRuleDraft(draft({ payout: '10001' })).ok).toBe(false);
    expect(validateRuleDraft(draft({ payout: '10000' })).ok).toBe(true);
    expect(validateRuleDraft(draft({ payout: '12.345' })).ok).toBe(false);
  });

  it('validates the minimum-jobs field', () => {
    expect(validateRuleDraft(draft({ min_jobs: '-1' })).ok).toBe(false);
    expect(validateRuleDraft(draft({ min_jobs: '2.5' })).ok).toBe(false);
    expect(validateRuleDraft(draft({ min_jobs: '1001' })).ok).toBe(false);
    expect(validateRuleDraft(draft({ min_jobs: '0' })).ok).toBe(true);
  });
});

describe('validateRuleDraft — rank rules', () => {
  const rank = (rankPayouts: string[]) => validateRuleDraft(draft({ rule_type: 'rank', kpi: 'overall', rankPayouts }));

  it('builds a payout ladder in cents and drops trailing blanks', () => {
    const v = rank(['100', '50', '', '']);
    expect(v.ok && v.payload.rank_payouts_cents).toEqual([10_000, 5_000]);
    expect(v.ok && v.payload.payout_cents).toBeNull();
    expect(v.ok && v.payload.threshold).toBeNull();
  });

  it('treats a blank place in the middle as $0', () => {
    const v = rank(['100', '', '25']);
    expect(v.ok && v.payload.rank_payouts_cents).toEqual([10_000, 0, 2_500]);
  });

  it('requires first place to pay and rejects junk', () => {
    expect(rank(['', '', '']).ok).toBe(false);
    expect(rank(['0', '50']).ok).toBe(false);
    expect(rank(['abc']).ok).toBe(false);
    expect(rank(['10001']).ok).toBe(false);
  });

  it('caps the ladder at 10 places', () => {
    expect(rank(Array(10).fill('1')).ok).toBe(true);
    expect(rank(Array(11).fill('1')).ok).toBe(false);
  });
});

describe('describeRule / thresholdToInput', () => {
  it('describes threshold and rank rules for humans', () => {
    expect(describeRule({ kpi: 'first_time_fix_rate', period: 'weekly', rule_type: 'threshold', threshold: 95, payout_cents: 5_000, rank_payouts_cents: null }))
      .toBe('First-time fix of 95.0%+ in a week → $50.00');
    expect(describeRule({ kpi: 'csat_avg', period: 'monthly', rule_type: 'threshold', threshold: 4.8, payout_cents: 10_000, rank_payouts_cents: null }))
      .toBe('Customer rating of 4.80+ stars in a month → $100.00');
    expect(describeRule({ kpi: 'revenue_cents', period: 'weekly', rule_type: 'threshold', threshold: 500_000, payout_cents: 7_500, rank_payouts_cents: null }))
      .toBe('Revenue of $5,000.00+ in a week → $75.00');
    expect(describeRule({ kpi: 'overall', period: 'monthly', rule_type: 'rank', threshold: null, payout_cents: null, rank_payouts_cents: [20_000, 10_000, 5_000] }))
      .toBe('Top Overall score each month: 1st $200.00 · 2nd $100.00 · 3rd $50.00');
  });

  it('round-trips revenue thresholds between cents and the form', () => {
    expect(thresholdToInput('revenue_cents', 500_050)).toBe('5000.5');
    expect(thresholdToInput('csat_avg', 4.5)).toBe('4.5');
    expect(thresholdToInput('csat_avg', null)).toBe('');
    const v = validateRuleDraft(draft({ kpi: 'revenue_cents', threshold: thresholdToInput('revenue_cents', 500_050) }));
    expect(v.ok && v.payload.threshold).toBe(500_050);
  });
});

describe('summarizePayouts', () => {
  const p = (status: 'pending' | 'approved' | 'paid' | 'rejected', amount_cents: number, pay_run_id: string | null = null, has_payroll_profile = true) =>
    ({ status, amount_cents, pay_run_id, has_payroll_profile });

  it('buckets by status and flags money that cannot reach payroll', () => {
    const t = summarizePayouts([
      p('pending', 1_000),
      p('approved', 2_000),
      p('approved', 3_000, 'run-1'),
      p('approved', 4_000, null, false),
      p('paid', 5_000, 'run-0'),
      p('rejected', 6_000),
    ]);
    expect(t).toEqual({ pending: 1_000, approved: 9_000, paid: 5_000, rejected: 6_000, awaitingPayroll: 2_000, blocked: 4_000 });
  });

  it('returns zeros for an empty list', () => {
    expect(summarizePayouts([])).toEqual({ pending: 0, approved: 0, paid: 0, rejected: 0, awaitingPayroll: 0, blocked: 0 });
  });
});

describe('sanitizeWeights', () => {
  it('clamps and rounds weights', () => {
    const w = sanitizeWeights(['csat_avg', 'upsell_rate'], { csat_avg: 150.4, upsell_rate: -5 });
    expect(w?.csat_avg).toBe(100);
    expect(w?.upsell_rate).toBe(0);
  });

  it('refuses a configuration where nothing would count', () => {
    expect(sanitizeWeights(['csat_avg'], { csat_avg: 0, revenue_cents: 50 })).toBeNull();
    expect(sanitizeWeights([], DEFAULT_WEIGHTS)).toBeNull();
  });

  it('ignores non-finite input', () => {
    const w = sanitizeWeights(['revenue_cents'], { revenue_cents: Number.NaN, first_time_fix_rate: 10 });
    expect(w).toBeNull();
  });
});
