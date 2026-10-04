import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS, deriveTrips, haversineMeters, isValidPoint, maintenanceStatus, normalizeSettings,
  operationalTruth, safetyScore, safetyTier, shouldLogBreadcrumb, stepGeofence, type Fix,
} from './engine';

const HOME = { lat: 30.2672, lng: -97.7431 };
// ~0.001 deg lat ≈ 111 m
const at = (dLat: number, dLng = 0) => ({ lat: HOME.lat + dLat, lng: HOME.lng + dLng });
const fix = (t: number, p: { lat: number; lng: number }, speedMph: number | null = 0, engine: Fix['engine'] = 'on'): Fix => ({ t, lat: p.lat, lng: p.lng, speedMph, engine });

describe('geo basics', () => {
  it('haversine is ~111 m per 0.001 deg latitude', () => {
    expect(haversineMeters(HOME, at(0.001))).toBeGreaterThan(105);
    expect(haversineMeters(HOME, at(0.001))).toBeLessThan(118);
  });
  it('rejects null-island and out-of-range points', () => {
    expect(isValidPoint({ lat: 0, lng: 0 })).toBe(false);
    expect(isValidPoint({ lat: 91, lng: 10 })).toBe(false);
    expect(isValidPoint(HOME)).toBe(true);
  });
  it('clamps and defaults settings', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ geofence_radius_m: 99999 }).geofence_radius_m).toBe(1000);
    expect(normalizeSettings({ auto_advance_job_status: 'yes' }).auto_advance_job_status).toBe(false);
  });
  it('throttles breadcrumbs but keeps heartbeats and big moves', () => {
    const a = fix(0, HOME);
    expect(shouldLogBreadcrumb(null, a)).toBe(true);
    expect(shouldLogBreadcrumb(a, fix(10_000, at(0.0001)))).toBe(false);
    expect(shouldLogBreadcrumb(a, fix(40_000, at(0.001)))).toBe(true);
    expect(shouldLogBreadcrumb(a, fix(130_000, HOME))).toBe(true);
    expect(shouldLogBreadcrumb(a, fix(5_000, at(0.004)))).toBe(true);
  });
});

describe('stepGeofence', () => {
  const site = [{ jobId: 'j1', point: HOME }];
  const cfg = DEFAULT_SETTINGS;

  it('does not arrive on a drive-by shorter than the dwell', () => {
    let pending = {};
    const s1 = stepGeofence(fix(0, at(0.0005)), site, pending, [], cfg);
    pending = s1.pending;
    expect(s1.arrivals).toHaveLength(0);
    const s2 = stepGeofence(fix(30_000, at(0.01)), site, pending, [], cfg);
    expect(s2.pending).toEqual({});
    expect(s2.arrivals).toHaveLength(0);
  });

  it('arrives after dwell and stamps the FIRST inside fix', () => {
    const s1 = stepGeofence(fix(1_000, at(0.0005)), site, {}, [], cfg);
    const s2 = stepGeofence(fix(125_000, at(0.0004)), site, s1.pending, [], cfg);
    expect(s2.arrivals).toEqual([{ jobId: 'j1', arrivedAt: 1_000, distanceM: expect.any(Number) }]);
  });

  it('uses hysteresis: jitter just outside the fence does not depart, a real exit does', () => {
    const open = [{ jobId: 'j1', arrivedAt: 0 }];
    const jitter = stepGeofence(fix(1, at(0.0017)), site, {}, open, cfg); // ~189 m: outside 150 but within 150+75
    expect(jitter.departures).toHaveLength(0);
    const gone = stepGeofence(fix(2, at(0.003)), site, {}, open, cfg); // ~333 m
    expect(gone.departures).toEqual([{ jobId: 'j1', departedAt: 2 }]);
  });

  it('never re-arrives while a visit is open', () => {
    const open = [{ jobId: 'j1', arrivedAt: 0 }];
    const s = stepGeofence(fix(500_000, HOME), site, {}, open, cfg);
    expect(s.arrivals).toHaveLength(0);
  });
});

describe('deriveTrips', () => {
  // 0.001 deg lat per 10 s ≈ 25 mph
  const drive = (startT: number, n: number, engine: Fix['engine'] = 'on') =>
    Array.from({ length: n }, (_, i) => fix(startT + i * 10_000, at(i * 0.001), 25, engine));

  it('derives one trip with sane distance and closes after 5 min stationary', () => {
    const moving = drive(0, 31); // 300 s, ~3.4 km... 30 segments * ~111 m
    const last = moving[moving.length - 1];
    const parked = Array.from({ length: 40 }, (_, i) => fix(last.t + (i + 1) * 10_000, last, 0, 'on'));
    const trips = deriveTrips([...moving, ...parked]);
    expect(trips).toHaveLength(1);
    expect(trips[0].distanceMiles).toBeGreaterThan(1.9);
    expect(trips[0].distanceMiles).toBeLessThan(2.2);
    expect(trips[0].drivingSeconds).toBe(300);
    expect(trips[0].idleSeconds).toBe(0); // the closing wait is not trip idle
  });

  it('counts a short mid-trip stop as idle', () => {
    const a = drive(0, 6);
    const lastA = a[a.length - 1];
    const stop = Array.from({ length: 6 }, (_, i) => fix(lastA.t + (i + 1) * 10_000, lastA, 0, 'on'));
    const b = Array.from({ length: 6 }, (_, i) => fix(lastA.t + 70_000 + i * 10_000, at(5 * 0.001 + (i + 1) * 0.001), 25, 'on'));
    const trips = deriveTrips([...a, ...stop, ...b]);
    expect(trips).toHaveLength(1);
    expect(trips[0].idleSeconds).toBeGreaterThanOrEqual(60);
  });

  it('drops GPS teleports and never bridges a long data gap', () => {
    const a = drive(0, 6);
    const jump = fix(a[5].t + 10_000, at(2), 25); // ~220 km in 10 s
    expect(deriveTrips([...a, jump]).every((t) => t.distanceMiles < 1)).toBe(true);
    const gap = deriveTrips([...a, fix(a[5].t + 3_600_000, at(0.5), 25)]);
    expect(gap.reduce((s, t) => s + t.distanceMiles, 0)).toBeLessThan(1);
  });

  it('ignores sub-0.1 mile shuffles', () => {
    expect(deriveTrips(drive(0, 2))).toHaveLength(0);
  });
});

describe('safetyScore', () => {
  it('is 100 with no events and falls with weighted events per mileage', () => {
    expect(safetyScore({ miles: 80, harshBrake: 0, harshAccel: 0, harshTurn: 0, speeding: 0, other: 0 })).toBe(100);
    const s = safetyScore({ miles: 50, harshBrake: 2, harshAccel: 0, harshTurn: 0, speeding: 0, other: 0 });
    expect(s).toBeCloseTo(85.6, 1);
    expect(safetyTier(s)).toBe('good');
  });
  it('floors the mileage basis so a short day is not catastrophic', () => {
    expect(safetyScore({ miles: 2, harshBrake: 1, harshAccel: 0, harshTurn: 0, speeding: 0, other: 0 })).toBeGreaterThan(80);
  });
  it('never goes below 0', () => {
    expect(safetyScore({ miles: 1, harshBrake: 50, harshAccel: 50, harshTurn: 50, speeding: 50, other: 50 })).toBe(0);
  });
  it('maps tiers', () => {
    expect([95, 80, 65, 40].map(safetyTier)).toEqual(['excellent', 'good', 'watch', 'at_risk']);
  });
});

describe('maintenanceStatus', () => {
  const now = Date.parse('2027-02-15T00:00:00Z');
  it('flags overdue by miles', () => {
    expect(maintenanceStatus({ interval_miles: 5000, interval_days: null, last_service_miles: 10000, last_service_date: null }, 15100, now).status).toBe('overdue');
  });
  it('flags due_soon inside the buffer and ok outside it', () => {
    const base = { interval_miles: 5000, interval_days: null, last_service_miles: 10000, last_service_date: null };
    expect(maintenanceStatus(base, 14600, now).status).toBe('due_soon');
    expect(maintenanceStatus(base, 12000, now).status).toBe('ok');
  });
  it('uses days when only a date interval exists', () => {
    const s = maintenanceStatus({ interval_miles: null, interval_days: 90, last_service_miles: null, last_service_date: '2026-10-01' }, null, now);
    expect(s.status).toBe('overdue');
    expect(s.milesRemaining).toBeNull();
  });
});

describe('operationalTruth', () => {
  const base = {
    arrivalVerified: true, minutesLate: 3, onsiteMinutes: 90, driveMiles: 12, idleMinutes: 2,
    harshEvents: 0, speedingEvents: 0, revenue: 400, travelCost: 20, customerRating: 5,
    isRework: false, customerDisputed: false,
  };
  it('scores a clean job at 100 with no flags', () => {
    const r = operationalTruth(base);
    expect(r.score).toBe(100);
    expect(r.flags).toEqual([]);
    expect(r.valuePerOnsiteHour).toBeCloseTo(266.67, 1);
  });
  it('flags a billed job with no GPS arrival and a tiny visit', () => {
    const r = operationalTruth({ ...base, arrivalVerified: false, onsiteMinutes: 4 });
    expect(r.flags).toContain('no_gps_arrival');
    expect(r.flags).toContain('short_visit_billed');
    expect(r.score).toBeLessThan(80);
  });
  it('treats missing rating/schedule as neutral, not as failure', () => {
    const r = operationalTruth({ ...base, customerRating: null, minutesLate: null });
    expect(r.score).toBeGreaterThan(85);
  });
  it('flags rework, dispute, low rating, travel-heavy and unsafe driving', () => {
    const r = operationalTruth({ ...base, isRework: true, customerDisputed: true, customerRating: 2, travelCost: 200, harshEvents: 4 });
    expect(r.flags).toEqual(expect.arrayContaining(['rework', 'disputed', 'low_rating', 'travel_heavy', 'unsafe_driving']));
  });
});
