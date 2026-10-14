import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: { rpc: vi.fn() } }));

import { supabase } from './supabase';
import {
  buildTrend,
  currentTotalCents,
  currentWagesCents,
  describePayType,
  earningsMix,
  fetchEarnings,
  fetchEarningsDetail,
  formatAgo,
  formatDay,
  formatHours,
  loadCachedEarnings,
  parseDetail,
  parseSummary,
  periodLabel,
  periodTakeHomeCents,
  periodTotalCents,
  periodWagesCents,
  saveCachedEarnings,
  type EarningsSummary,
  type PastPeriod,
} from './techEarnings';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

const past = (over: Partial<PastPeriod> = {}): PastPeriod => ({
  pay_run_id: 'r1', item_id: 'i1', pay_period_start: '2026-09-01', pay_period_end: '2026-09-14', pay_date: '2026-09-19', status: 'paid',
  regular_hours: 80, overtime_hours: 4, regular_pay_cents: 240000, overtime_pay_cents: 18000, salary_pay_cents: 0, commission_cents: 12000,
  bonus_cents: 0, gross_pay_cents: 270000, tax_withholding_cents: 54000, other_deductions_cents: 0, net_pay_cents: 216000, paid_at: '2026-09-19T00:00:00Z',
  tips_cents: 3500, ...over,
});

const summary = (over: Partial<EarningsSummary> = {}): EarningsSummary => ({
  employee: { id: 'e1', full_name: 'Tech One', pay_type: 'hourly', pay_schedule: 'biweekly', commission_rate_percent: 0, employment_type: 'w2' },
  current: {
    since: '2026-09-15', regular_hours: 14, overtime_hours: 2, pending_timesheets: 1, regular_pay_cents: 42000, overtime_pay_cents: 9000,
    salary_pay_cents: 0, commission_cents: 14000, commission_count: 3, tips_cents: 2500,
  },
  periods: [past()],
  generated_at: '2026-10-09T10:00:00.000Z',
  ...over,
});

beforeEach(() => {
  window.localStorage.clear();
  rpc.mockReset();
});

describe('money math', () => {
  it('adds up the current estimate: wages + commission + tips', () => {
    const s = summary();
    expect(currentWagesCents(s.current)).toBe(51000);
    expect(currentTotalCents(s.current)).toBe(51000 + 14000 + 2500);
  });
  it('adds up a finished period: gross + tips, and take-home = net + tips', () => {
    const p = past();
    expect(periodTotalCents(p)).toBe(273500);
    expect(periodTakeHomeCents(p)).toBe(219500);
    expect(periodWagesCents(p)).toBe(258000);
  });
  it('counts bonus as wages', () => {
    expect(periodWagesCents(past({ bonus_cents: 5000 }))).toBe(263000);
  });
});

describe('earningsMix', () => {
  it('always adds up to exactly 100%', () => {
    for (const [w, c, t] of [[1, 1, 1], [3333, 3333, 3334], [51000, 14000, 2500], [1, 0, 0], [7, 11, 13]]) {
      expect(earningsMix(w, c, t).reduce((s, p) => s + p.percent, 0)).toBe(100);
    }
  });
  it('is all zeros when nothing was earned, and ignores negatives', () => {
    expect(earningsMix(0, 0, 0).every((p) => p.percent === 0)).toBe(true);
    expect(earningsMix(-500, 1000, 0).map((p) => p.percent)).toEqual([0, 100, 0]);
  });
  it('never gives a share to a part that earned nothing', () => {
    expect(earningsMix(100, 0, 0).map((p) => p.percent)).toEqual([100, 0, 0]);
  });
});

describe('dates and labels', () => {
  it('formats plain dates without shifting them by time zone', () => {
    expect(formatDay('2026-09-14')).toBe('Sep 14');
    expect(formatDay('2026-01-01')).toBe('Jan 1');
    expect(formatDay(null)).toBe('—');
    expect(formatDay('nonsense')).toBe('—');
  });
  it('labels a period, adding years only when it crosses one', () => {
    expect(periodLabel('2026-09-01', '2026-09-14')).toBe('Sep 1 – Sep 14, 2026');
    expect(periodLabel('2025-12-22', '2026-01-04')).toBe('Dec 22, 2025 – Jan 4, 2026');
  });
  it('formats hours and ages', () => {
    expect(formatHours(8)).toBe('8 h');
    expect(formatHours(7.5)).toBe('7.5 h');
    expect(formatAgo(null)).toBe('never');
    expect(formatAgo(1_000_000 - 5 * 60_000, 1_000_000)).toBe('5 min ago');
  });
  it('describes pay types', () => {
    expect(describePayType(summary().employee)).toBe('Hourly');
    expect(describePayType({ ...summary().employee, pay_type: 'commission_only', commission_rate_percent: 12 })).toBe('Commission only · 12%');
    expect(describePayType({ ...summary().employee, pay_type: 'salary_plus_commission', commission_rate_percent: 0 })).toBe('Salary + commission');
  });
});

describe('buildTrend', () => {
  it('runs oldest to newest and ends with the running estimate', () => {
    const s = summary({
      periods: [
        past({ item_id: 'i3', pay_period_end: '2026-09-28', gross_pay_cents: 100000, tips_cents: 0 }),
        past({ item_id: 'i2', pay_period_end: '2026-09-14', gross_pay_cents: 200000, tips_cents: 0 }),
      ],
    });
    const bars = buildTrend(s);
    expect(bars.map((b) => b.id)).toEqual(['i2', 'i3', 'current']);
    expect(bars[0].height).toBe(100);
    expect(bars[1].height).toBe(50);
    expect(bars[2].current).toBe(true);
  });
  it('keeps a small amount visible and an empty one flat', () => {
    const s = summary({
      periods: [past({ item_id: 'a', gross_pay_cents: 1, tips_cents: 0 }), past({ item_id: 'b', gross_pay_cents: 0, tips_cents: 0 })],
      current: { ...summary().current, regular_pay_cents: 1000000, overtime_pay_cents: 0, commission_cents: 0, tips_cents: 0 },
    });
    const bars = buildTrend(s);
    expect(bars.find((b) => b.id === 'a')?.height).toBe(6);
    expect(bars.find((b) => b.id === 'b')?.height).toBe(0);
  });
  it('limits how many past periods it shows', () => {
    const periods = Array.from({ length: 10 }, (_, n) => past({ item_id: `i${n}` }));
    expect(buildTrend(summary({ periods }), 4)).toHaveLength(5);
  });
});

describe('parseSummary (server data is untrusted)', () => {
  it('rejects garbage', () => {
    expect(parseSummary(null)).toBeNull();
    expect(parseSummary({})).toBeNull();
    expect(parseSummary({ employee: { id: 'e' }, current: {} })).toBeNull();
  });
  it('coerces numbers, defaults unknown enums and drops malformed periods', () => {
    const s = parseSummary({
      employee: { id: 'e1', full_name: 'A', pay_type: 'weird', pay_schedule: 'daily', commission_rate_percent: '12.5' },
      current: { since: '2026-09-15', regular_hours: '14', commission_cents: 1500.4, tips_cents: null, pending_timesheets: -3 },
      periods: [
        { item_id: 'i1', pay_run_id: 'r1', pay_period_start: '2026-09-01T00:00:00Z', pay_period_end: '2026-09-14', status: 'weird', gross_pay_cents: '1000', tips_cents: 'x' },
        { item_id: 'i2' },
        'junk',
      ],
    });
    expect(s?.employee).toMatchObject({ pay_type: 'hourly', pay_schedule: 'biweekly', commission_rate_percent: 12.5, employment_type: 'w2' });
    expect(s?.current).toMatchObject({ regular_hours: 14, commission_cents: 1500, tips_cents: 0, pending_timesheets: 0 });
    expect(s?.periods).toHaveLength(1);
    expect(s?.periods[0]).toMatchObject({ pay_period_start: '2026-09-01', pay_date: '2026-09-14', status: 'approved', gross_pay_cents: 1000, tips_cents: 0 });
  });
});

describe('parseDetail', () => {
  it('keeps good lines and drops bad ones', () => {
    const d = parseDetail({
      commissions: [{ id: 'c1', customer_name: 'Smith', basis_amount_cents: 80000, commission_rate_percent: 10, commission_cents: 8000, created_at: '2026-10-02T00:00:00Z' }, { nope: 1 }],
      timesheets: [{ id: 't1', work_date: '2026-10-01', regular_hours: 8, overtime_hours: 2 }, { id: 't2' }],
      tips: [{ id: 'p1', amount_cents: 2500, source: 'cash' }],
    });
    expect(d?.commissions).toHaveLength(1);
    expect(d?.timesheets).toEqual([{ id: 't1', work_date: '2026-10-01', regular_hours: 8, overtime_hours: 2, status: 'approved', customer_name: null }]);
    expect(d?.tips[0]).toMatchObject({ amount_cents: 2500, source: 'cash', note: null });
    expect(parseDetail('x')).toBeNull();
  });
});

describe('device cache', () => {
  it('stores the last good summary per user', () => {
    saveCachedEarnings('u1', summary());
    expect(loadCachedEarnings('u1')?.employee.full_name).toBe('Tech One');
    expect(loadCachedEarnings('u2')).toBeNull();
  });
  it('survives corrupted storage', () => {
    window.localStorage.setItem('vk:tech-earnings:v1:u1', '{oops');
    expect(loadCachedEarnings('u1')).toBeNull();
  });
});

describe('server calls', () => {
  it('fetchEarnings parses a good response and asks for the default page size', async () => {
    rpc.mockResolvedValue({ data: summary(), error: null });
    const r = await fetchEarnings();
    expect(r.ok && r.data.periods).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith('get_my_earnings', { p_limit: 12 });
  });
  it('fetchEarnings maps blocked states, network failures and unreadable data', async () => {
    rpc.mockResolvedValueOnce({ data: { error: 'no_pay_profile' }, error: null });
    expect(await fetchEarnings()).toMatchObject({ ok: false, reason: 'no_pay_profile' });
    rpc.mockResolvedValueOnce({ data: { error: 'not_a_technician' }, error: null });
    expect(await fetchEarnings()).toMatchObject({ ok: false, reason: 'not_a_technician' });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'TypeError: Failed to fetch' } });
    expect(await fetchEarnings()).toMatchObject({ ok: false, reason: 'network' });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    expect(await fetchEarnings()).toMatchObject({ ok: false, reason: 'error' });
    rpc.mockResolvedValueOnce({ data: { hello: 1 }, error: null });
    expect(await fetchEarnings()).toMatchObject({ ok: false, reason: 'error' });
    rpc.mockRejectedValueOnce(new Error('Load failed'));
    expect(await fetchEarnings()).toMatchObject({ ok: false, reason: 'network' });
  });
  it('fetchEarningsDetail sends null for the current period and maps not_found', async () => {
    rpc.mockResolvedValueOnce({ data: { commissions: [], timesheets: [], tips: [] }, error: null });
    expect(await fetchEarningsDetail(null)).toMatchObject({ ok: true });
    expect(rpc).toHaveBeenCalledWith('get_my_earnings_detail', { p_item_id: null });
    rpc.mockResolvedValueOnce({ data: { error: 'not_found' }, error: null });
    expect(await fetchEarningsDetail('x')).toMatchObject({ ok: false, reason: 'not_found' });
  });
});
