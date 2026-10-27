import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

import {
  computePerDiem,
  daysBetween,
  describeRate,
  fetchPerDiemPolicy,
  pickRate,
  reviewPerDiemTrip,
  savePerDiemTrip,
  tripSummary,
  type PerDiemPolicy,
  type PerDiemTrip,
} from './perDiem';

const policy = (over: Partial<PerDiemPolicy> = {}): PerDiemPolicy => ({
  configured: true,
  enabled: true,
  minDistanceMiles: 50,
  requireOvernight: true,
  defaultMealCents: 6800,
  defaultLodgingCapCents: 12000,
  firstLastDayPct: 75,
  lodgingRequiresReceipt: true,
  canEdit: true,
  rates: [
    { state: 'CO', city: null, mealCents: 7400, lodgingCapCents: 14000 },
    { state: 'CO', city: 'Denver', mealCents: 8000, lodgingCapCents: 20000 },
  ],
  ...over,
});

const trip = (over: Record<string, unknown> = {}) => ({
  state: 'TX',
  city: '',
  startDate: '2026-10-05',
  endDate: '2026-10-08',
  oneWayMiles: 120,
  lodgingActualCents: 0,
  ...over,
});

describe('daysBetween', () => {
  it('counts whole days and rejects bad input', () => {
    expect(daysBetween('2026-10-05', '2026-10-08')).toBe(3);
    expect(daysBetween('2026-10-05', '2026-10-05')).toBe(0);
    expect(Number.isNaN(daysBetween('2026-10-05', 'nope'))).toBe(true);
  });

  it('is not thrown off by a daylight-saving change', () => {
    expect(daysBetween('2026-11-01', '2026-11-02')).toBe(1);
  });
});

describe('pickRate', () => {
  it('prefers city, then state, then default', () => {
    expect(pickRate(policy(), 'CO', ' denver ').source).toBe('city');
    expect(pickRate(policy(), 'CO', 'Boulder').source).toBe('state');
    expect(pickRate(policy(), 'TX', 'Austin')).toEqual({ mealCents: 6800, lodgingCapCents: 12000, source: 'default' });
  });
});

describe('computePerDiem', () => {
  it('pays first and last day at the percentage and middle days in full', () => {
    // 4 days at $68: 2 partial x 75% + 2 full = 3.5 x 6800 = 23800
    const c = computePerDiem(policy(), trip());
    expect(c?.days).toBe(4);
    expect(c?.nights).toBe(3);
    expect(c?.mealTotalCents).toBe(23800);
    expect(c?.totalCents).toBe(23800);
  });

  it('caps lodging at the nightly cap x nights and reports the overage', () => {
    const c = computePerDiem(policy(), trip({ lodgingActualCents: 50000 }));
    expect(c?.lodgingAllowedCents).toBe(36000);
    expect(c?.lodgingOverCents).toBe(14000);
    expect(c?.totalCents).toBe(23800 + 36000);
  });

  it('pays lodging at actual cost when under the cap', () => {
    const c = computePerDiem(policy(), trip({ lodgingActualCents: 30000 }));
    expect(c?.lodgingAllowedCents).toBe(30000);
    expect(c?.lodgingOverCents).toBe(0);
  });

  it('uses the city rate', () => {
    const c = computePerDiem(policy(), trip({ state: 'CO', city: 'Denver', lodgingActualCents: 90000 }));
    expect(c?.rateSource).toBe('city');
    expect(c?.mealTotalCents).toBe(28000);
    expect(c?.lodgingAllowedCents).toBe(60000);
  });

  it('rejects trips under the minimum distance', () => {
    const c = computePerDiem(policy(), trip({ oneWayMiles: 49.9 }));
    expect(c?.eligible).toBe(false);
    expect(c?.reason).toBe('too_close');
    expect(c?.totalCents).toBe(0);
  });

  it('requires an overnight when the rule is on, and allows a day trip when it is off', () => {
    const dayTrip = trip({ endDate: '2026-10-05' });
    expect(computePerDiem(policy(), dayTrip)?.reason).toBe('not_overnight');
    const c = computePerDiem(policy({ requireOvernight: false }), dayTrip);
    expect(c?.eligible).toBe(true);
    expect(c?.mealTotalCents).toBe(5100);
  });

  it('pays nothing when per diem is off', () => {
    expect(computePerDiem(policy({ enabled: false }), trip())?.reason).toBe('disabled');
  });

  it('returns null for impossible dates', () => {
    expect(computePerDiem(policy(), trip({ endDate: '2026-10-01' }))).toBeNull();
    expect(computePerDiem(policy(), trip({ endDate: '2027-01-01' }))).toBeNull();
  });
});

describe('labels and summary', () => {
  it('describes the rate that applied', () => {
    expect(describeRate('city', 'CO', 'Denver')).toBe('Denver, CO rate');
    expect(describeRate('state', 'CO', '')).toBe('CO state rate');
    expect(describeRate('default', 'TX', '')).toBe('Account default rate');
  });

  it('totals what is awaiting review and approved', () => {
    const t = (status: PerDiemTrip['status'], totalCents: number) => ({ status, totalCents }) as PerDiemTrip;
    expect(tripSummary([t('submitted', 100), t('submitted', 50), t('approved', 700), t('draft', 9), t('rejected', 9)])).toEqual({
      awaiting: 2,
      awaitingCents: 150,
      approvedCents: 700,
    });
  });
});

describe('client calls', () => {
  beforeEach(() => rpc.mockReset());

  it('maps the policy payload', async () => {
    rpc.mockResolvedValue({
      data: {
        configured: true, enabled: true, min_distance_miles: 75, require_overnight: false,
        default_meal_cents: 7000, default_lodging_cap_cents: 15000, first_last_day_pct: 50,
        lodging_requires_receipt: true, can_edit: true,
        rates: [{ state: 'CO', city: null, meal_cents: 7400, lodging_cap_cents: 14000 }],
      },
      error: null,
    });
    const p = await fetchPerDiemPolicy();
    expect(p.minDistanceMiles).toBe(75);
    expect(p.requireOvernight).toBe(false);
    expect(p.rates).toEqual([{ state: 'CO', city: null, mealCents: 7400, lodgingCapCents: 14000 }]);
  });

  it('sends the trip with the exact RPC parameter names', async () => {
    rpc.mockResolvedValue({ data: 'trip-1', error: null });
    const id = await savePerDiemTrip(
      null,
      { ...trip({ state: 'CO', city: ' Denver ' }), jobId: null, notes: '', receiptPath: null, receiptMime: null },
      true,
    );
    expect(id).toBe('trip-1');
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe('save_per_diem_trip');
    expect(args.p_submit).toBe(true);
    expect(args.p_data.destination_city).toBe('Denver');
    expect(args.p_data.destination_state).toBe('CO');
  });

  it('surfaces the server message on review failure', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('You cannot review your own trip') });
    await expect(reviewPerDiemTrip('t1', 'approved')).rejects.toThrow('own trip');
  });
});
