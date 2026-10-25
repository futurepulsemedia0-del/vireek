import { describe, expect, it } from 'vitest';
import {
  addDays,
  applyActions,
  breakEvenElasticity,
  buildCurve,
  buildStabilizerReport,
  detectWindows,
  guardrailFor,
  marginAfterDiscount,
  maxDiscountForFloor,
  stabilityScore,
  type CurveCore,
  type HistoryPayload,
} from './seasonalStabilizer';

const WEEK_START = '2026-10-19';

function seasonalHistory(overrides: Partial<HistoryPayload> = {}, weeksBack = 150): HistoryPayload {
  const first = addDays(WEEK_START, -7 * weeksBack);
  const rows: HistoryPayload['weekly'] = [];
  for (let i = 0; i < weeksBack; i++) {
    const w = addDays(first, 7 * i);
    const d = new Date(`${w}T00:00:00Z`);
    const doy = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000);
    const ang = (doy / 365) * 2 * Math.PI;
    const summer = 1 + 0.8 * Math.max(0, Math.sin(ang - 1.2));
    const winter = 1 + 0.5 * Math.max(0, Math.cos(ang + 0.2));
    rows.push({ w, line: 'ac repair', jobs: Math.round(20 * summer), revenue_cents: Math.round(900_000 * summer * (0.3 + (0.7 * summer) / 1.8)), minutes: Math.round(20 * summer * 120) });
    rows.push({ w, line: 'heating', jobs: Math.round(12 * winter), revenue_cents: Math.round(700_000 * winter * (winter > 1.2 ? 1.3 : 0.7)), minutes: Math.round(12 * winter * 150) });
    rows.push({ w, line: 'maintenance', jobs: 8, revenue_cents: 160_000, minutes: 480 });
  }
  return {
    timezone: 'America/New_York',
    today: '2026-10-24',
    week_start: WEEK_START,
    industry: 'hvac',
    service_area: 'springfield',
    weekly: rows,
    booked_ahead: [],
    line_margin: [
      { line: 'ac repair', margin_pct: 48, sample: 40 },
      { line: 'heating', margin_pct: 52, sample: 30 },
    ],
    margin_floor_pct: 20,
    default_cost_ratio_pct: 55,
    weather_monthly: [],
    regional: null,
    tech: { headcount: 4, capacity_jobs_per_day: 24, avg_hourly_cost_cents: null },
    memberships: { active: 40, offered: 0, mrr_cents: 100_000 },
    membership_plans: [{ id: 'p1', name: 'Comfort Club', price_cents: 29_900, billing_interval: 'yearly' }],
    fixed_monthly_cents: 4_500_000,
    cash: { starting_balance_cents: 6_000_000, default_cost_ratio_pct: 55 },
    cash_snapshot: null,
    settings: { deferrable_service_lines: ['maintenance', 'heating'] },
    ...overrides,
  };
}

describe('margin guardrail math', () => {
  it('computes margin after a discount', () => {
    expect(marginAfterDiscount(40, 0)).toBeCloseTo(40, 5);
    expect(marginAfterDiscount(40, 10)).toBeCloseTo(33.33, 1);
  });

  it('finds the largest discount that keeps the floor', () => {
    const d = maxDiscountForFloor(40, 20);
    expect(marginAfterDiscount(40, d)).toBeCloseTo(20, 4);
    expect(maxDiscountForFloor(15, 20)).toBe(0);
  });

  it('caps an incentive to the floor and blocks when there is no room', () => {
    const capped = guardrailFor(22, 20, 5);
    expect(capped.status).toBe('within_floor');
    expect(capped.capped).toBe(true);
    expect(capped.margin_after_pct).toBeGreaterThanOrEqual(20);
    const blocked = guardrailFor(20, 20, 5);
    expect(blocked.status).toBe('blocked');
    expect(guardrailFor(50, 20, 0).status).toBe('not_applicable');
  });

  it('reports when a valley discount can never break even', () => {
    expect(breakEvenElasticity(40, 10, 40)).not.toBeNull();
    expect(breakEvenElasticity(10, 50, 0)).toBeNull();
  });
});

describe('detectWindows', () => {
  const weeks = Array.from({ length: 12 }, (_, k) => addDays(WEEK_START, 7 * k));
  it('finds a peak and a valley and bridges one-week gaps', () => {
    const ratios = [1, 1, 1.3, 1.4, 1, 1.3, 1, 0.6, 0.6, 0.7, 1, 1];
    const w = detectWindows(ratios, weeks, 85, 115);
    expect(w.map((x) => x.kind)).toEqual(['peak', 'valley']);
    expect(w[0].start_k).toBe(2);
    expect(w[0].end_k).toBe(5);
  });

  it('ignores a single marginal week', () => {
    expect(detectWindows([1, 1, 1.16, 1, 1, 1, 1, 1, 1, 1, 1, 1], weeks, 85, 115)).toHaveLength(0);
  });
});

describe('curve + score', () => {
  const core: CurveCore = {
    weeks: Array.from({ length: 4 }, (_, k) => addDays(WEEK_START, 7 * k)),
    demand_revenue_cents: [100, 300, 100, 100],
    demand_hours: [10, 30, 10, 10],
    hours_available: true,
    cap_load: 20,
    gm_pct: 50,
    weekly_fixed_cents: 0,
    start_cash_cents: 0,
  };

  it('caps revenue at capacity and reports the unmet demand', () => {
    const c = buildCurve(core, []);
    expect(c[1].revenue_cents).toBe(200);
    expect(c[1].overloaded).toBe(true);
    expect(c[1].unmet_revenue_cents).toBe(100);
  });

  it('extra staffed hours recover the revenue', () => {
    const c = buildCurve(core, [{ w: core.weeks[1], line: '*', revenue_cents: 0, hours: 0, extra_hours: 10, recurring_cents: 0 }]);
    expect(c[1].revenue_cents).toBe(300);
    expect(c[1].overloaded).toBe(false);
  });

  it('scores a flat year higher than a swingy one and stays within 0-100', () => {
    const flat = stabilityScore(Array.from({ length: 52 }, () => ({ revenue_cents: 100, overloaded: false })));
    const swingy = stabilityScore(Array.from({ length: 52 }, (_, i) => ({ revenue_cents: i % 26 < 8 ? 40 : 160, overloaded: i % 26 >= 8 })));
    expect(flat.score).toBe(100);
    expect(swingy.score).toBeLessThan(flat.score);
    expect(swingy.score).toBeGreaterThanOrEqual(0);
  });
});

describe('buildStabilizerReport', () => {
  it('reports insufficient data without history', () => {
    const r = buildStabilizerReport(seasonalHistory({ weekly: [] }));
    expect(r.status).toBe('insufficient_data');
    expect(r.actions).toHaveLength(0);
  });

  it('reports insufficient data when there is no invoiced revenue', () => {
    const h = seasonalHistory();
    const r = buildStabilizerReport({ ...h, weekly: h.weekly.map((x) => ({ ...x, revenue_cents: 0 })) });
    expect(r.status).toBe('insufficient_data');
  });

  it('measures seasonality, finds peaks and valleys and scores stability', () => {
    const r = buildStabilizerReport(seasonalHistory());
    expect(r.status).toBe('ok');
    expect(r.horizon).toHaveLength(52);
    expect(r.windows.some((w) => w.kind === 'peak')).toBe(true);
    expect(r.windows.some((w) => w.kind === 'valley')).toBe(true);
    expect(r.stability.score).toBeGreaterThanOrEqual(0);
    expect(r.stability.score).toBeLessThanOrEqual(100);
    expect(r.lines[0].seasonality).toBe('measured');
  });

  it('is flat and low-confidence with under a year of history', () => {
    const r = buildStabilizerReport(seasonalHistory({}, 30));
    expect(r.status).toBe('ok');
    expect(r.confidence).toBe('low');
    expect(r.windows).toHaveLength(0);
  });

  it('is deterministic', () => {
    const a = buildStabilizerReport(seasonalHistory());
    const b = buildStabilizerReport(seasonalHistory());
    expect(JSON.stringify(a.actions)).toBe(JSON.stringify(b.actions));
  });

  it('every action has revenue + margin impact, a measurable window and in-range guardrail data', () => {
    const r = buildStabilizerReport(seasonalHistory());
    expect(r.actions.length).toBeGreaterThan(0);
    for (const a of r.actions) {
      expect(Number.isFinite(a.est_revenue_cents)).toBe(true);
      expect(Number.isFinite(a.est_margin_cents)).toBe(true);
      expect(a.measure_windows.length).toBeGreaterThan(0);
      expect(a.window_end >= a.window_start).toBe(true);
      expect(a.fingerprint.startsWith(a.action_type)).toBe(true);
      if (a.margin_pct_after !== null && a.guardrail_status === 'within_floor') {
        expect(a.margin_pct_after).toBeGreaterThanOrEqual(a.margin_floor_pct ?? 0);
      }
    }
  });

  it('applying the proposed actions never makes the year less stable', () => {
    const r = buildStabilizerReport(seasonalHistory());
    const withActions = applyActions(r, r.actions.map((a) => ({ status: 'proposed', details: a.details })), new Set(['proposed']));
    expect(withActions.score.score).toBeGreaterThanOrEqual(r.stability.score);
    const none = applyActions(r, [], new Set(['proposed']));
    expect(none.score.score).toBe(r.stability.score);
  });

  it('does not re-propose a window that already has an approved action', () => {
    const first = buildStabilizerReport(seasonalHistory());
    const target = first.actions[0];
    const second = buildStabilizerReport(seasonalHistory(), {
      existing: [{ action_type: target.action_type, service_line: target.service_line, window_start: target.window_start, window_end: target.window_end, status: 'approved' }],
    });
    expect(second.actions.some((a) => a.action_type === target.action_type && a.service_line === target.service_line && a.window_start === target.window_start)).toBe(false);
  });

  it('sizes memberships to the valley fixed-cost gap and needs none when covered', () => {
    const r = buildStabilizerReport(seasonalHistory());
    expect(r.membership).not.toBeNull();
    expect(r.membership!.plans[0].additional_needed).toBeGreaterThan(0);
    const covered = buildStabilizerReport(seasonalHistory({ fixed_monthly_cents: 100_000 }));
    expect(covered.membership!.plans[0].additional_needed).toBe(0);
  });

  it('builds a cash-reserve plan and omits it without fixed costs', () => {
    const r = buildStabilizerReport(seasonalHistory());
    expect(r.cash).not.toBeNull();
    expect(r.cash!.reserve_needed_cents).toBeGreaterThanOrEqual(r.cash!.buffer_cents);
    const none = buildStabilizerReport(seasonalHistory({ fixed_monthly_cents: 0 }));
    expect(none.cash).toBeNull();
    expect(none.membership).toBeNull();
  });
});
