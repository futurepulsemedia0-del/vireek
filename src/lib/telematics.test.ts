import { describe, it, expect, vi } from 'vitest';

// Pure helpers only: keep the Supabase client out of this unit test.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { ageLabel, liveStatus, maintenanceStatus, safetyTier } from './telematics';

const NOW = Date.parse('2027-02-15T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

describe('liveStatus', () => {
  it('is offline without a fix or when stale', () => {
    expect(liveStatus(undefined, NOW)).toBe('offline');
    expect(liveStatus({ speed_mph: 30, engine_state: 'on', last_fix_at: ago(30) }, NOW)).toBe('offline');
  });
  it('distinguishes moving / idling / stopped', () => {
    expect(liveStatus({ speed_mph: 35, engine_state: 'on', last_fix_at: ago(1) }, NOW)).toBe('moving');
    expect(liveStatus({ speed_mph: 0, engine_state: 'idle', last_fix_at: ago(1) }, NOW)).toBe('idling');
    expect(liveStatus({ speed_mph: 0, engine_state: 'off', last_fix_at: ago(1) }, NOW)).toBe('stopped');
  });
});

describe('helpers', () => {
  it('formats ages', () => {
    expect(ageLabel(null, NOW)).toBe('never');
    expect(ageLabel(ago(0), NOW)).toBe('just now');
    expect(ageLabel(ago(45), NOW)).toBe('45m ago');
    expect(ageLabel(ago(180), NOW)).toBe('3h ago');
  });
  it('tiers safety scores', () => {
    expect([92, 80, 61, 10].map(safetyTier)).toEqual(['excellent', 'good', 'watch', 'at_risk']);
  });
  it('computes maintenance status client-side the same way as the engine', () => {
    const s = { id: '1', vehicle_id: 'v', name: 'Oil', interval_miles: 5000, interval_days: null, last_service_miles: 10000, last_service_date: null, active: true };
    expect(maintenanceStatus(s, 15100, NOW).status).toBe('overdue');
    expect(maintenanceStatus(s, 14600, NOW).status).toBe('due_soon');
    expect(maintenanceStatus(s, 11000, NOW).status).toBe('ok');
  });
});
