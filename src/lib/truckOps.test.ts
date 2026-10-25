import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRUCK_OPS_SETTINGS,
  canComplete,
  canShip,
  describeStatus,
  describeVariance,
  forecastUrgency,
  groupForecastByTruck,
  isOk,
  opsErrorMessage,
  parseConfirmQty,
  sortBySeverity,
  transferProgress,
  validateSettings,
  type ForecastRow,
  type TransferLine,
  type TransferOrder,
} from '@/lib/truckOps';

const NOW = Date.parse('2027-01-10T12:00:00Z');
const hoursFromNow = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

function forecastRow(over: Partial<ForecastRow> = {}): ForecastRow {
  return {
    location_id: 'van-1',
    location_name: 'Van 1',
    technician_id: 't1',
    part_id: 'p1',
    part_name: 'Capacitor',
    part_number: 'CAP-1',
    available: 4,
    min_quantity: 2,
    target_quantity: 10,
    upcoming_jobs: 2,
    explicit_demand: 0,
    statistical_demand: 4.8,
    forecast_demand: 5,
    inbound: 0,
    projected: -1,
    suggested_qty: 8,
    warehouse_available: 50,
    fulfillable_qty: 8,
    order_shortfall: 0,
    reason: 'job_demand',
    confidence: 'medium',
    first_short_job_id: 'j1',
    first_short_at: hoursFromNow(30),
    unit_cost_cents: 1000,
    ...over,
  };
}

function line(over: Partial<TransferLine> = {}): TransferLine {
  return {
    id: 'l1',
    transfer_id: 't1',
    part_id: 'p1',
    qty_planned: 10,
    qty_picked: 0,
    qty_received: 0,
    unit_cost_cents: 500,
    picked_at: null,
    pick_scanned: false,
    pick_override_reason: null,
    received_at: null,
    receive_scanned: false,
    receive_override_reason: null,
    replenishment_task_id: null,
    ...over,
  };
}

function order(status: TransferOrder['status'], lines: TransferLine[]): Pick<TransferOrder, 'status' | 'lines'> {
  return { status, lines };
}

describe('forecastUrgency', () => {
  it('is "now" when the truck is already empty', () => {
    expect(forecastUrgency(forecastRow({ available: 0, first_short_at: null }), NOW)).toBe('now');
    expect(forecastUrgency(forecastRow({ available: -3 }), NOW)).toBe('now');
  });
  it('buckets by hours until the first short job', () => {
    expect(forecastUrgency(forecastRow({ first_short_at: hoursFromNow(10) }), NOW)).toBe('now');
    expect(forecastUrgency(forecastRow({ first_short_at: hoursFromNow(48) }), NOW)).toBe('soon');
    expect(forecastUrgency(forecastRow({ first_short_at: hoursFromNow(100) }), NOW)).toBe('planned');
  });
  it('is "planned" with no short job or an unparseable date', () => {
    expect(forecastUrgency(forecastRow({ first_short_at: null }), NOW)).toBe('planned');
    expect(forecastUrgency(forecastRow({ first_short_at: 'nonsense' }), NOW)).toBe('planned');
  });
});

describe('groupForecastByTruck', () => {
  it('totals per truck and orders the worst shortfall first', () => {
    const groups = groupForecastByTruck([
      forecastRow({ location_id: 'a', location_name: 'A', suggested_qty: 5, fulfillable_qty: 5, order_shortfall: 0 }),
      forecastRow({ location_id: 'b', location_name: 'B', part_id: 'p2', suggested_qty: 10, fulfillable_qty: 4, order_shortfall: 6, unit_cost_cents: 100 }),
      forecastRow({ location_id: 'b', location_name: 'B', part_id: 'p3', suggested_qty: 2, fulfillable_qty: 2, order_shortfall: 0, unit_cost_cents: 50 }),
    ]);
    expect(groups.map((g) => g.location_id)).toEqual(['b', 'a']);
    expect(groups[0]).toMatchObject({ totalSuggested: 12, totalFulfillable: 6, totalShortfall: 6, valueCents: 4 * 100 + 2 * 50 });
    expect(groups[0].rows).toHaveLength(2);
  });
  it('returns nothing for no rows', () => {
    expect(groupForecastByTruck([])).toEqual([]);
  });
});

describe('transfer progress and gating', () => {
  it('counts pick confirmations on an open transfer', () => {
    const o = order('open', [line({ id: 'a', picked_at: 'x', qty_picked: 10 }), line({ id: 'b', part_id: 'p2' })]);
    expect(transferProgress(o)).toMatchObject({ lines: 2, confirmed: 1, allConfirmed: false });
    expect(canShip(o)).toBe(false);
  });
  it('can ship once every line is confirmed and something was picked', () => {
    const ok = order('open', [line({ picked_at: 'x', qty_picked: 5 }), line({ id: 'b', part_id: 'p2', picked_at: 'x', qty_picked: 0 })]);
    expect(canShip(ok)).toBe(true);
    const nothing = order('open', [line({ picked_at: 'x', qty_picked: 0 })]);
    expect(canShip(nothing)).toBe(false);
    expect(canShip(order('in_transit', [line({ picked_at: 'x', qty_picked: 5 })]))).toBe(false);
    expect(canShip(order('open', []))).toBe(false);
  });
  it('tracks receive progress only on shipped lines', () => {
    const o = order('in_transit', [
      line({ qty_picked: 10, picked_at: 'x', qty_received: 8, received_at: 'y' }),
      line({ id: 'b', part_id: 'p2', qty_picked: 0, picked_at: 'x' }),
    ]);
    const p = transferProgress(o);
    expect(p).toMatchObject({ lines: 1, confirmed: 1, allConfirmed: true, unitsPicked: 10, unitsReceived: 8, shortUnits: 2 });
    expect(canComplete(o)).toBe(true);
  });
  it('cannot complete with an unconfirmed shipped line or the wrong status', () => {
    expect(canComplete(order('in_transit', [line({ qty_picked: 3, picked_at: 'x' })]))).toBe(false);
    expect(canComplete(order('open', [line({ qty_picked: 3, received_at: 'y' })]))).toBe(false);
    expect(canComplete(order('in_transit', []))).toBe(false);
  });
});

describe('parseConfirmQty', () => {
  it('accepts whole numbers within range', () => {
    expect(parseConfirmQty('0', 5)).toEqual({ ok: true, value: 0 });
    expect(parseConfirmQty(' 5 ', 5)).toEqual({ ok: true, value: 5 });
  });
  it('rejects blanks, decimals, negatives, text and values above the max', () => {
    for (const bad of ['', '  ', '1.5', '-1', 'abc', '1e3', '99999999']) {
      expect(parseConfirmQty(bad, 5).ok).toBe(false);
    }
    expect(parseConfirmQty('6', 5)).toEqual({ ok: false, error: 'At most 5.' });
  });
});

describe('describeStatus / isOk', () => {
  it('turns statuses into sentences, with details when the server sends them', () => {
    expect(describeStatus({ status: 'scan_required' })).toMatch(/scan/i);
    expect(describeStatus({ status: 'wrong_part', scanned_part: 'Contactor' })).toBe('That barcode is Contactor, not this part.');
    expect(describeStatus({ status: 'insufficient_stock', part: 'Capacitor', available: 3 })).toBe('Capacitor: Not enough stock at the source. Only 3 available.');
    expect(describeStatus({ status: 'invalid_quantity', max: 9 })).toBe('Enter a quantity between 0 and 9.');
    expect(describeStatus({ status: 'unconfirmed_lines', count: 2 })).toBe('2 line(s) still need confirming.');
  });
  it('never returns an empty message', () => {
    expect(describeStatus({ status: 'something_new' })).toMatch(/something went wrong/i);
    expect(describeStatus(null)).toMatch(/something went wrong/i);
  });
  it('isOk defaults to "ok" and accepts custom success statuses', () => {
    expect(isOk({ status: 'ok' })).toBe(true);
    expect(isOk({ status: 'completed' }, 'completed')).toBe(true);
    expect(isOk({ status: 'forbidden' })).toBe(false);
    expect(isOk(null)).toBe(false);
  });
});

describe('describeVariance', () => {
  it('explains each kind using the stored details', () => {
    expect(describeVariance({ kind: 'count_shortage', quantity: 2, details: { expected: 5, counted: 3 } })).toBe('Counted 3 but the system expected 5.');
    expect(describeVariance({ kind: 'transfer_shortage', quantity: 2, details: { picked: 16, received: 14, transfer_number: 'TO-1' } })).toBe('Shipped 16, truck received 14 (TO-1).');
    expect(describeVariance({ kind: 'overuse_vs_job', quantity: 1, details: { required: 2, used: 3 } })).toBe('Used 3 but the job only required 2.');
    expect(describeVariance({ kind: 'shrink_pattern', quantity: null, details: { rate_pct: 23.5, fleet_median_pct: 4, window_days: 30 } })).toContain('23.5%');
  });
  it('degrades gracefully when details are missing', () => {
    expect(describeVariance({ kind: 'count_shortage', quantity: 1, details: {} })).toContain('?');
  });
});

describe('sortBySeverity', () => {
  it('puts critical first without mutating the input', () => {
    const input = [{ severity: 'info' as const }, { severity: 'critical' as const }, { severity: 'warning' as const }];
    expect(sortBySeverity(input).map((x) => x.severity)).toEqual(['critical', 'warning', 'info']);
    expect(input[0].severity).toBe('info');
  });
});

describe('validateSettings', () => {
  it('accepts the defaults', () => {
    expect(validateSettings(DEFAULT_TRUCK_OPS_SETTINGS)).toEqual({});
  });
  it('flags every value the database CHECK constraints would reject', () => {
    const errors = validateSettings({
      ...DEFAULT_TRUCK_OPS_SETTINGS,
      forecast_horizon_days: 0,
      history_days: 7,
      safety_factor: 0.9,
      audit_interval_days: 181,
      shrink_alert_pct: 0.1,
      shrink_min_value_cents: -1,
      alert_cooldown_hours: 200,
    });
    expect(Object.keys(errors).sort()).toEqual([
      'alert_cooldown_hours',
      'audit_interval_days',
      'forecast_horizon_days',
      'history_days',
      'safety_factor',
      'shrink_alert_pct',
      'shrink_min_value_cents',
    ]);
  });
  it('rejects fractional day counts and NaN', () => {
    expect(validateSettings({ ...DEFAULT_TRUCK_OPS_SETTINGS, forecast_horizon_days: 2.5 }).forecast_horizon_days).toBeDefined();
    expect(validateSettings({ ...DEFAULT_TRUCK_OPS_SETTINGS, safety_factor: Number.NaN }).safety_factor).toBeDefined();
  });
});

describe('opsErrorMessage', () => {
  it('maps permission, offline and missing-migration errors', () => {
    expect(opsErrorMessage({ code: '42501' })).toMatch(/permission/i);
    expect(opsErrorMessage({ message: 'Failed to fetch' })).toMatch(/offline/i);
    expect(opsErrorMessage({ code: 'PGRST202', message: 'x' })).toMatch(/migration/i);
    expect(opsErrorMessage(null)).toMatch(/something went wrong/i);
    expect(opsErrorMessage({ code: 'XX000', message: 'secret internals' })).not.toContain('secret');
  });
});
