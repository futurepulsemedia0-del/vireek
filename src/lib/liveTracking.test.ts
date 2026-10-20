import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }));

import {
  formatArrivalWindow,
  freshness,
  minutesRemaining,
  osmEmbedUrl,
  resolveEta,
  type JobTracking,
} from './liveTracking';

const NOW = Date.parse('2027-03-01T15:00:00Z');
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

const base: JobTracking = {
  business_name: 'Acme HVAC',
  customer_name: 'Sam',
  service_type: 'AC repair',
  job_status: 'en_route',
  scheduled_datetime: '2027-03-01T15:00:00Z',
  technician_name: 'Alex Rivera',
  technician_photo_url: null,
  eta_minutes: null,
  eta_set_at: null,
  technician_lat: null,
  technician_lng: null,
  location_updated_at: null,
  position_source: null,
  site_lat: null,
  site_lng: null,
  arrival_window_start: '2027-03-01T15:00:00Z',
  arrival_window_end: '2027-03-01T16:00:00Z',
  arrived_at: null,
  can_reschedule: false,
  review_token: null,
  review_status: null,
  server_time: null,
};
const make = (over: Partial<JobTracking> = {}): JobTracking => ({ ...base, ...over });

describe('minutesRemaining', () => {
  it('counts down from when the ETA was set', () => {
    expect(minutesRemaining(20, ago(5 * 60), NOW)).toBe(15);
  });
  it('floors at 0 once elapsed', () => {
    expect(minutesRemaining(10, ago(30 * 60), NOW)).toBe(0);
  });
  it('is null without data or with a bad timestamp', () => {
    expect(minutesRemaining(null, ago(0), NOW)).toBeNull();
    expect(minutesRemaining(10, null, NOW)).toBeNull();
    expect(minutesRemaining(10, 'garbage', NOW)).toBeNull();
  });
});

describe('resolveEta', () => {
  const live = { technician_lat: 30.0, technician_lng: -97.0, site_lat: 30.05, site_lng: -97.0 };

  it('is null unless the technician is en route', () => {
    expect(resolveEta(make({ job_status: 'scheduled', ...live, location_updated_at: ago(30) }), NOW)).toBeNull();
    expect(resolveEta(make({ job_status: 'in_progress' }), NOW)).toBeNull();
  });
  it('prefers a fresh live GPS fix', () => {
    const r = resolveEta(make({ ...live, location_updated_at: ago(60), eta_minutes: 90, eta_set_at: ago(0) }), NOW);
    expect(r?.source).toBe('live');
    expect(r!.minutes).toBeGreaterThan(5);
    expect(r!.minutes).toBeLessThan(25);
  });
  it('falls back to the technician-set ETA when the fix is stale', () => {
    const r = resolveEta(make({ ...live, location_updated_at: ago(15 * 60), eta_minutes: 20, eta_set_at: ago(5 * 60) }), NOW);
    expect(r).toEqual({ minutes: 15, source: 'technician' });
  });
  it('falls back to the technician-set ETA without site coordinates', () => {
    const r = resolveEta(make({ eta_minutes: 20, eta_set_at: ago(5 * 60) }), NOW);
    expect(r).toEqual({ minutes: 15, source: 'technician' });
  });
  it('is null when nothing is known', () => {
    expect(resolveEta(make(), NOW)).toBeNull();
  });
});

describe('formatArrivalWindow', () => {
  const opts = { nowMs: NOW, timeZone: 'UTC', locale: 'en-US' };

  it('labels today and shows the range', () => {
    expect(formatArrivalWindow('2027-03-01T15:00:00Z', '2027-03-01T16:00:00Z', opts)).toMatch(/^Today, 3:00\sPM – 4:00\sPM$/);
  });
  it('labels other days with the weekday and date', () => {
    expect(formatArrivalWindow('2027-03-03T15:00:00Z', '2027-03-03T16:00:00Z', opts)).toMatch(/^Wed, Mar 3, 3:00\sPM – 4:00\sPM$/);
  });
  it('shows a single time when the end is missing or invalid', () => {
    expect(formatArrivalWindow('2027-03-01T15:00:00Z', null, opts)).toMatch(/^Today, 3:00\sPM$/);
    expect(formatArrivalWindow('2027-03-01T15:00:00Z', '2027-03-01T14:00:00Z', opts)).toMatch(/^Today, 3:00\sPM$/);
  });
  it('is null for a missing or invalid start', () => {
    expect(formatArrivalWindow(null, null, opts)).toBeNull();
    expect(formatArrivalWindow('nope', null, opts)).toBeNull();
  });
});

describe('freshness', () => {
  it('describes recent, older and very old fixes', () => {
    expect(freshness(ago(10), NOW)).toEqual({ label: 'Updated just now', stale: false });
    expect(freshness(ago(60), NOW)).toEqual({ label: 'Updated 1 min ago', stale: false });
    expect(freshness(ago(10 * 60), NOW)).toEqual({ label: 'Updated 10 min ago', stale: true });
    expect(freshness(ago(2 * 3600), NOW)).toEqual({ label: 'Updated over an hour ago', stale: true });
  });
  it('is null without a valid timestamp', () => {
    expect(freshness(null, NOW)).toBeNull();
    expect(freshness('x', NOW)).toBeNull();
  });
});

describe('osmEmbedUrl', () => {
  it('marks the technician', () => {
    expect(osmEmbedUrl({ lat: 30.5, lng: -97.5 })).toContain('marker=30.5%2C-97.5');
  });
  it('widens the bounding box to include the job site', () => {
    const url = new URL(osmEmbedUrl({ lat: 30.0, lng: -97.0 }, { lat: 30.2, lng: -96.8 }));
    const [w, s, e, n] = url.searchParams.get('bbox')!.split(',').map(Number);
    expect(w).toBeLessThan(-97.0);
    expect(s).toBeLessThan(30.0);
    expect(e).toBeGreaterThan(-96.8);
    expect(n).toBeGreaterThan(30.2);
  });
});
