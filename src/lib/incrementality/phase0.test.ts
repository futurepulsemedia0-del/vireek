import { describe, expect, it } from 'vitest';
import { runPhase0, timeBlockOf, toObservations, weekClusterOf, type Phase0Row } from './phase0';

describe('phase0 helpers', () => {
  it('buckets time in the business time zone, not UTC', () => {
    // 2026-10-10 (Sat) 02:30 UTC = Fri 22:30 in New York => weekday overnight
    expect(timeBlockOf('2026-10-10T02:30:00Z', 'America/New_York')).toBe('weekday_overnight');
    expect(timeBlockOf('2026-10-10T15:00:00Z', 'America/New_York')).toBe('weekend_day');
  });
  it('week cluster is the Monday of the UTC week', () => {
    expect(weekClusterOf('2026-10-10T15:00:00Z')).toBe('2026-10-05');
  });
  it('excludes emergency calls from the contrast and reports how many', () => {
    const rows: Phase0Row[] = Array.from({ length: 50 }, (_, i) => ({
      call_id: `c${i}`, call_datetime: '2026-10-07T15:00:00Z', answered: true, is_emergency: i % 2 === 0,
      source: 'google', intent: 'repair', customer_id: null, booked: false, booked_revenue_cents: 0,
    }));
    const r = runPhase0(toObservations(rows, 'acct', 'UTC'), { reps: 200 });
    expect(r.excludedEmergencyCalls).toBe(25);
    expect(r.bookingRate.estimate).toBeNull(); // nobody unanswered => no contrast, never a guess
    expect(r.bookingRate.assessment.verdict).toBe('insufficient_data');
  });
});
