import { describe, it, expect } from 'vitest';
import { summarizeCrewProductivity, totals } from './metrics.ts';
import type { VisitRow } from './types.ts';

const v = (id: string, o: Partial<VisitRow> = {}): VisitRow => ({ id, contract_id: 'c', addon_id: null, kind: 'maintenance', status: 'completed', skip_reason: null, visit_date: '2027-04-05', scheduled_at: '2027-04-05T14:00:00Z', crew_id: 'k1', crew_size: 2, route_position: 1, planned_minutes: 60, started_at: '2027-04-05T14:05:00Z', completed_at: '2027-04-05T15:05:00Z', price_cents: 6000, billed_invoice_id: null, tasks_total: 5, tasks_done: 5, ...o });
const range = { from: '2027-04-01', to: '2027-04-30' };

describe('landscaping crew metrics', () => {
  it('computes efficiency, on-time, revenue per labor hour', () => {
    const [m] = summarizeCrewProductivity([v('a'), v('b', { completed_at: '2027-04-05T14:35:00Z', started_at: '2027-04-05T14:05:00Z' })], range);
    expect(m.completed).toBe(2);
    expect(m.actualMinutes).toBe(90);
    expect(m.efficiency).toBeCloseTo(120 / 90, 2);
    expect(m.onTimeRate).toBe(1);
    expect(m.laborHours).toBe(3);
    expect(m.revenuePerLaborHourCents).toBe(4000);
    expect(m.taskCompletionRate).toBe(1);
  });
  it('counts skips by reason; completion rate excludes cancelled and open visits', () => {
    const [m] = summarizeCrewProductivity([v('a'), v('w', { status: 'skipped', skip_reason: 'weather' }), v('c', { status: 'cancelled' }), v('o', { status: 'scheduled', started_at: null, completed_at: null })], range);
    expect(m.skippedByReason).toEqual({ weather: 1 });
    expect(m.completionRate).toBe(0.5);
    expect(m.scheduled).toBe(3);
  });
  it('visits without times never skew ratios and are reported', () => {
    const [m] = summarizeCrewProductivity([v('a', { started_at: null, completed_at: null })], range);
    expect(m.missingTimeData).toBe(1);
    expect(m.efficiency).toBeNull();
    expect(m.revenuePerLaborHourCents).toBeNull();
  });
  it('late starts reduce on-time rate; date range and crews are respected; empty input is empty', () => {
    const rows = summarizeCrewProductivity([v('a', { started_at: '2027-04-05T14:40:00Z' }), v('b', { crew_id: 'k2' }), v('out', { visit_date: '2027-05-02' })], range);
    expect(rows.map((r) => [r.crewId, r.scheduled])).toEqual([['k1', 1], ['k2', 1]]);
    expect(rows[0].onTimeRate).toBe(0);
    expect(summarizeCrewProductivity([], range)).toEqual([]);
    expect(totals(rows).completed).toBe(2);
  });
});
