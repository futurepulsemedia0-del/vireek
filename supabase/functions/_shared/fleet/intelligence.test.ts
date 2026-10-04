import { describe, it, expect } from 'vitest';
import {
  allocateFixedCost,
  buildProfiles,
  computeTripCosts,
  deriveHarshEvents,
  estimateVehicleCostPerMile,
  haversineMiles,
  reconstructTrip,
  type Ping,
  type TripRowForProfile,
} from './intelligence';

const JOB = { lat: 30.0, lng: -97.0 };
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 1, 14, 0, 0);

/** One ping per minute driving north toward the job at ~30 mph (0.5 mi/min). */
function drivePings(minutes: number, opts: { odometerStart?: number } = {}): Ping[] {
  const degPerMile = 1 / 69.05;
  const startLat = JOB.lat - minutes * 0.5 * degPerMile;
  return Array.from({ length: minutes + 1 }, (_, i) => ({
    t: T0 + i * MIN,
    lat: startLat + i * 0.5 * degPerMile,
    lng: JOB.lng,
    speedMph: 30,
    ignitionOn: true,
    odometer: opts.odometerStart != null ? opts.odometerStart + i * 0.5 : null,
  }));
}

describe('reconstructTrip', () => {
  it('rebuilds a verified drive → arrival → work lifecycle from GPS', () => {
    const pings = drivePings(20);
    const t = reconstructTrip({
      job: {
        latitude: JOB.lat,
        longitude: JOB.lng,
        scheduledAt: T0 + 15 * MIN,
        enRouteAt: T0,
        startedAt: T0 + 22 * MIN,
        completedAt: T0 + 82 * MIN,
      },
      pings,
    });
    expect(t.arrivalVerified).toBe(true);
    expect(t.arrivedAt).toBe(T0 + 20 * MIN);
    expect(t.driveMinutes).toBe(20);
    expect(t.onSiteMinutes).toBe(60);
    expect(t.arrivalDelayMinutes).toBe(5);
    expect(t.distanceSource).toBe('gps_path');
    expect(t.distanceMiles).toBeGreaterThan(9.5);
    expect(t.distanceMiles).toBeLessThan(10.5);
    expect(t.avgSpeedMph).toBeGreaterThan(28);
    expect(t.avgSpeedMph).toBeLessThan(32);
    expect(t.confidence).toBe('high');
  });

  it('prefers the odometer over the GPS path when both exist', () => {
    const t = reconstructTrip({
      job: { latitude: JOB.lat, longitude: JOB.lng, scheduledAt: null, enRouteAt: T0, startedAt: T0 + 21 * MIN, completedAt: T0 + 60 * MIN },
      pings: drivePings(20, { odometerStart: 50_000 }),
    });
    expect(t.distanceSource).toBe('odometer');
    expect(t.distanceMiles).toBe(10);
  });

  it('counts stopped-with-ignition-on time as idle', () => {
    const pings = drivePings(20).map((p, i) => (i >= 5 && i < 10 ? { ...p, speedMph: 0 } : p));
    const t = reconstructTrip({
      job: { latitude: JOB.lat, longitude: JOB.lng, scheduledAt: null, enRouteAt: T0, startedAt: T0 + 21 * MIN, completedAt: null },
      pings,
    });
    expect(t.idleMinutes).toBe(5);
  });

  it('does not count ignition-off stops as idle', () => {
    const pings = drivePings(20).map((p, i) => (i >= 5 && i < 10 ? { ...p, speedMph: 0, ignitionOn: false } : p));
    const t = reconstructTrip({
      job: { latitude: JOB.lat, longitude: JOB.lng, scheduledAt: null, enRouteAt: T0, startedAt: T0 + 21 * MIN, completedAt: null },
      pings,
    });
    expect(t.idleMinutes).toBe(0);
  });

  it('falls back to work-start for arrival and straight-line distance when there is no GPS', () => {
    const t = reconstructTrip({
      job: { latitude: JOB.lat, longitude: JOB.lng, scheduledAt: null, enRouteAt: T0, startedAt: T0 + 25 * MIN, completedAt: T0 + 70 * MIN },
      pings: [],
      startFallback: { lat: JOB.lat - 0.1, lng: JOB.lng },
    });
    expect(t.arrivalVerified).toBe(false);
    expect(t.arrivedAt).toBe(T0 + 25 * MIN);
    expect(t.distanceSource).toBe('estimated');
    expect(t.flags).toContain('arrival_from_work_start');
    expect(t.confidence).toBe('low');
    expect(t.distanceMiles).toBeCloseTo(haversineMiles(JOB.lat - 0.1, JOB.lng, JOB.lat, JOB.lng) * 1.3, 1);
  });

  it('is low confidence without a departure timestamp', () => {
    const t = reconstructTrip({
      job: { latitude: JOB.lat, longitude: JOB.lng, scheduledAt: null, enRouteAt: null, startedAt: T0 + 30 * MIN, completedAt: null },
      pings: drivePings(20),
    });
    expect(t.driveMinutes).toBeNull();
    expect(t.confidence).toBe('low');
    expect(t.flags).toContain('no_departure_timestamp');
  });

  it('ignores impossible GPS jumps', () => {
    const pings = drivePings(20);
    pings[10] = { ...pings[10], lat: pings[10].lat + 5 }; // ~345 miles in one minute
    const t = reconstructTrip({
      job: { latitude: JOB.lat, longitude: JOB.lng, scheduledAt: null, enRouteAt: T0, startedAt: T0 + 21 * MIN, completedAt: null },
      pings,
    });
    expect(t.flags).toContain('gps_glitch_skipped');
    expect(t.distanceMiles as number).toBeLessThan(20);
  });
});

describe('deriveHarshEvents', () => {
  const p = (t: number, speed: number): Ping => ({ t, lat: 30, lng: -97, speedMph: speed, ignitionOn: true, odometer: null });

  it('flags harsh braking only on closely spaced samples', () => {
    expect(deriveHarshEvents([p(0, 50), p(3000, 20)]).map((e) => e.type)).toEqual(['harsh_braking']);
    expect(deriveHarshEvents([p(0, 50), p(60_000, 20)])).toEqual([]);
  });

  it('flags harsh acceleration and extreme speed rising edge once', () => {
    const ev = deriveHarshEvents([p(0, 10), p(3000, 40), p(6000, 88), p(9000, 90)]);
    expect(ev.filter((e) => e.type === 'harsh_acceleration')).toHaveLength(2);
    expect(ev.filter((e) => e.type === 'speeding')).toHaveLength(1);
  });
});

describe('cost model', () => {
  it('uses actuals when there is enough history, otherwise models from mpg', () => {
    const actual = estimateVehicleCostPerMile({ fuelExpenseCents: 30_000, maintenanceExpenseCents: 15_000, windowMiles: 1_000, ratedMpg: 18, fuelType: 'gasoline' });
    expect(actual.basis).toBe('actual');
    expect(actual.fuelCentsPerMile).toBe(30);
    expect(actual.wearCentsPerMile).toBe(15);

    const modeled = estimateVehicleCostPerMile({ fuelExpenseCents: 0, maintenanceExpenseCents: 0, windowMiles: 20, ratedMpg: 20, fuelType: 'gasoline', fuelPriceCentsPerGallon: 400 });
    expect(modeled.basis).toBe('modeled');
    expect(modeled.fuelCentsPerMile).toBe(20);
  });

  it('allocates a vehicle-day of fixed cost by time, not per job', () => {
    const m = allocateFixedCost([{ id: 'a', weightMinutes: 30 }, { id: 'b', weightMinutes: 90 }], 4_000);
    expect(m.get('a')).toBe(1000);
    expect(m.get('b')).toBe(3000);
    expect(allocateFixedCost([{ id: 'x', weightMinutes: 0 }, { id: 'y', weightMinutes: 0 }], 1000).get('x')).toBe(500);
  });

  it('computes fully loaded cost, contribution and margin', () => {
    const c = computeTripCosts({
      distanceMiles: 10,
      driveMinutes: 30,
      idleMinutes: 6,
      onSiteMinutes: 60,
      hourlyCostCents: 4_000,
      cost: { fuelCentsPerMile: 25, wearCentsPerMile: 15, basis: 'modeled' },
      fixedCostCents: 1_000,
      fuelPriceCentsPerGallon: 400,
      revenueCents: 30_000,
    });
    expect(c.fuelCostCents).toBe(250);
    expect(c.wearCostCents).toBe(150);
    expect(c.idleCostCents).toBe(24); // 0.1 h × 0.6 gal/h × $4.00
    expect(c.vehicleCostCents).toBe(250 + 150 + 24 + 1_000);
    expect(c.driveLaborCostCents).toBe(2_000);
    expect(c.onSiteLaborCostCents).toBe(4_000);
    expect(c.fullyLoadedCostCents).toBe(1_424 + 6_000);
    expect(c.contributionCents).toBe(30_000 - 7_424);
    expect(c.marginPct).toBe(75.3);
  });

  it('reports no margin when the job has not been invoiced', () => {
    const c = computeTripCosts({
      distanceMiles: 5, driveMinutes: 10, idleMinutes: 0, onSiteMinutes: 30, hourlyCostCents: null,
      cost: { fuelCentsPerMile: 20, wearCentsPerMile: 18, basis: 'modeled' }, fixedCostCents: 0, revenueCents: 0,
    });
    expect(c.marginPct).toBeNull();
    expect(c.contributionCents).toBeLessThan(0);
  });
});

describe('buildProfiles', () => {
  const row = (over: Partial<TripRowForProfile>): TripRowForProfile => ({
    technician_id: 't1', vehicle_id: 'v1', territory_id: 'z1', service_type: 'hvac',
    drive_minutes: 30, idle_minutes: 3, on_site_minutes: 60, arrival_delay_minutes: 0, distance_miles: 15,
    harsh_event_count: 0, fuel_cost_cents: 300, wear_cost_cents: 200, idle_cost_cents: 50, vehicle_cost_cents: 1_000, fully_loaded_cost_cents: 8_000,
    revenue_cents: 20_000, contribution_cents: 12_000, margin_pct: 60, confidence: 'high', ...over,
  });

  it('rolls trips up into technician, service, vehicle, territory and combo profiles', () => {
    const profiles = buildProfiles([row({}), row({ drive_minutes: 50, arrival_delay_minutes: 30 }), row({ technician_id: 't2', vehicle_id: 'v2' })]);
    const keys = profiles.map((p) => p.profile_key).sort();
    expect(keys).toEqual(['c:t1:v1:hvac', 'c:t2:v2:hvac', 't:t1', 't:t2', 'tr:z1:hvac', 'ts:t1:hvac', 'ts:t2:hvac', 'v:v1', 'v:v2']);

    const t1 = profiles.find((p) => p.profile_key === 't:t1')!;
    expect(t1.sample_size).toBe(2);
    expect(t1.avg_drive_minutes).toBe(40);
    expect(t1.windshield_share_pct).toBe(40); // 80 drive / (80 + 120 on-site)
    expect(t1.on_time_pct).toBe(50);
    expect(t1.cost_per_mile_cents).toBeCloseTo(66.67, 1);
    expect(t1.variable_cost_per_mile_cents).toBeCloseTo(33.33, 1); // (300+200)*2 / 30 mi
    expect(t1.avg_idle_cost_cents).toBe(50);
    expect(t1.total_contribution_cents).toBe(24_000);
    expect(t1.confidence).toBe('low');
  });

  it('excludes uninvoiced jobs from margin and contribution averages', () => {
    const [t] = buildProfiles([row({}), row({ revenue_cents: 0, contribution_cents: -8_000, margin_pct: null })]).filter((p) => p.profile_key === 't:t1');
    expect(t.avg_margin_pct).toBe(60);
    expect(t.avg_contribution_cents).toBe(12_000);
    expect(t.total_contribution_cents).toBe(12_000);
  });
});
