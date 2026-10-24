import { describe, expect, it } from 'vitest';
import { computeFeedAvailability, isValidTimeZone, zonedWallToUtcMs, type FeedSnapshot } from './availability';
import { generateSlots } from '../../../../src/lib/bookingPolicy';

const HOURS = { mon: { open: '09:00', close: '17:00' }, tue: { open: '09:00', close: '17:00' }, wed: { open: '09:00', close: '17:00' },
  thu: { open: '09:00', close: '17:00' }, fri: { open: '09:00', close: '17:00' } };

function snap(over: Partial<FeedSnapshot> = {}, settings: Partial<FeedSnapshot['settings']> = {}): FeedSnapshot {
  return {
    generated_at: '2027-03-01T00:00:00Z', slug: 'acme',
    business: { name: 'Acme', timezone: 'America/New_York', timezone_set: true, services: ['Drain cleaning'] },
    settings: { enabled: true, hours: HOURS, holidays: [], duration_minutes: 60, lead_time_hours: 2, window_days: 14,
      buffer_before: 0, buffer_after: 0, ...settings },
    capacity: { technician_capacity: 0, emergency_reserve: 1, full_threshold_pct: 90 },
    google: { feed_enabled: true, structured_data_enabled: true, partner_status: 'not_applied', horizon_days: 14 },
    busy: [], load_by_day: {}, ...over,
  };
}

const NOW = new Date('2027-03-01T12:00:00Z'); // Monday 07:00 in New York

describe('timezone helpers', () => {
  it('validates zones', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Nope/Zone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
  it('converts wall time and rejects the DST gap', () => {
    expect(zonedWallToUtcMs(2027, 3, 1, 9, 0, 'America/New_York')).toBe(Date.UTC(2027, 2, 1, 14, 0));
    expect(zonedWallToUtcMs(2027, 3, 14, 2, 30, 'America/New_York')).toBeNull(); // spring-forward gap
    expect(zonedWallToUtcMs(2027, 7, 1, 9, 0, 'America/New_York')).toBe(Date.UTC(2027, 6, 1, 13, 0)); // EDT
  });
});

describe('computeFeedAvailability — gating (never publish unverified)', () => {
  it.each([
    [snap({ google: { feed_enabled: false, structured_data_enabled: false, partner_status: 'x', horizon_days: 14 } }), 'feed_disabled'],
    [snap({}, { enabled: false }), 'booking_disabled'],
    [snap({ business: { name: 'A', timezone: null, timezone_set: false, services: ['x'] } }), 'timezone_missing'],
    [snap({ business: { name: 'A', timezone: null, timezone_set: true, services: ['x'] } }), 'timezone_invalid'],
    [snap({}, { hours: null }), 'hours_missing'],
    [snap({ business: { name: 'A', timezone: 'UTC', timezone_set: true, services: [] } }), 'no_services'],
  ])('blocks with a reason', (s, reason) => {
    const r = computeFeedAvailability(s, NOW, { requirePublished: true });
    expect(r.blocked).toBe(reason);
    expect(r.slots).toHaveLength(0);
  });
});

describe('computeFeedAvailability — rules', () => {
  it('respects lead time, weekends, holidays and the business timezone', () => {
    const r = computeFeedAvailability(snap({}, { holidays: ['2027-03-02'] }), NOW);
    expect(r.slots[0].start).toBe('2027-03-01T14:00:00.000Z'); // 09:00 NY, >= now + 2h
    expect(r.slots.some((s) => s.local_date === '2027-03-02')).toBe(false);
    expect(r.slots.some((s) => ['2027-03-06', '2027-03-07'].includes(s.local_date))).toBe(false);
  });

  it('removes slots that overlap busy jobs and honours buffers', () => {
    const busy = [{ start: '2027-03-01T15:00:00Z', duration_minutes: 60 }]; // 10:00 NY
    const noBuf = computeFeedAvailability(snap({ busy }), NOW).slots.map((s) => s.local_time);
    expect(noBuf.slice(0, 3)).toEqual(['09:00', '11:00', '12:00']);
    const buf = computeFeedAvailability(snap({ busy }, { buffer_before: 30, buffer_after: 30 }), NOW).slots.map((s) => s.local_time);
    expect(buf.slice(0, 2)).toEqual(['12:00', '13:00']);
  });

  it('caps published slots per day by remaining normal capacity', () => {
    const s = snap({ capacity: { technician_capacity: 4, emergency_reserve: 1, full_threshold_pct: 90 }, load_by_day: { '2027-03-02': 2 } });
    const r = computeFeedAvailability(s, NOW);
    expect(r.slots.filter((x) => x.local_date === '2027-03-02')).toHaveLength(1); // 4 - 2 - 1 reserve
    expect(r.capacity_mode).toBe('technician_capacity');
  });

  it('publishes nothing on a full day', () => {
    const s = snap({ capacity: { technician_capacity: 10, emergency_reserve: 0, full_threshold_pct: 90 }, load_by_day: { '2027-03-02': 9 } });
    expect(computeFeedAvailability(s, NOW).slots.some((x) => x.local_date === '2027-03-02')).toBe(false);
  });

  it('never publishes more than the booking engine would (parity, business-wide mode)', () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const busy = [{ start: '2027-03-02T15:00:00Z', duration_minutes: 90 }];
    const s = snap({ busy, business: { name: 'A', timezone: zone, timezone_set: true, services: ['x'] } },
      { buffer_before: 15, buffer_after: 15, duration_minutes: 45 });
    const feed = computeFeedAvailability(s, NOW, { maxSlots: 1000 }).slots.map((x) => x.start);
    const legacy = generateSlots({
      hours: HOURS, holidays: [], durationMinutes: 45, leadTimeHours: 2, windowDays: 14, bufferBefore: 15, bufferAfter: 15,
    }, busy.map((b) => ({ start: new Date(b.start), durationMinutes: b.duration_minutes })), NOW, 1000).map((d) => d.toISOString());
    expect(feed.length).toBeGreaterThan(0);
    expect(feed).toEqual(legacy);
  });
});
