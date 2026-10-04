import { describe, it, expect } from 'vitest';
import type { Job, TeamMember } from '@/lib/supabase';
import {
  rankTechniciansByProfitability,
  estimateTechnicianProfitability,
  AVG_TRAVEL_SPEED_MPH,
  MILEAGE_COST_CENTS_PER_MILE,
  type FleetDispatchSignal,
} from './dispatchProfitability';
import {
  buildFleetDispatchSignals,
  buildFleetInsights,
  formatMinutes,
  generateIngestToken,
  isVehicleLive,
  sha256Hex,
  summarizeFleet,
  type FleetProfile,
  type FleetVehicle,
} from './fleetIntelligence';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

const job = {
  id: 'j1', service_type: 'hvac', scheduled_datetime: '2026-10-03T15:00:00.000Z', duration_minutes: null,
  invoice_amount: 600, latitude: 30.0, longitude: -97.0,
} as unknown as Job;

const tech = (id: string, over: Partial<TeamMember> = {}): TeamMember =>
  ({
    id, role: 'technician', dispatch_enabled: true, skills: ['hvac'], max_jobs_per_day: 6, member_name: id, member_email: `${id}@x.io`,
    hourly_cost_rate_cents: 4_000, home_latitude: 30.5, home_longitude: -97.0, current_latitude: null, current_longitude: null, ...over,
  }) as unknown as TeamMember;

const signal = (over: Partial<FleetDispatchSignal> = {}): FleetDispatchSignal => ({
  technicianId: 't1', vehicleLocation: null, avgSpeedMph: null, costPerMileCents: null, idleCostPerTripCents: null,
  onSiteMinutesByService: {}, onTimePct: null, sampleSize: 10, confidence: 'medium', ...over,
});

describe('dispatch profitability with fleet signals', () => {
  it('is unchanged when there is no fleet data', () => {
    const base = estimateTechnicianProfitability(job, tech('t1'), {}, undefined, null);
    const withNull = estimateTechnicianProfitability(job, tech('t1'), {}, undefined, null, null);
    expect(withNull.expectedGrossProfitCents).toBe(base.expectedGrossProfitCents);
    expect(base.usedFleetData).toBe(false);
  });

  it('uses the live truck position instead of the home address', () => {
    const atHome = estimateTechnicianProfitability(job, tech('t1'), {}, undefined, null);
    const nearTruck = estimateTechnicianProfitability(
      job, tech('t1'), {}, undefined, null,
      signal({ vehicleLocation: { lat: 30.01, lng: -97.0, ageMinutes: 3 } }),
    );
    expect(nearTruck.distanceMiles as number).toBeLessThan(atHome.distanceMiles as number);
    expect(nearTruck.usedFleetData).toBe(true);
    expect(nearTruck.reasons.join(' ')).toContain('live truck GPS');
  });

  it('ignores a stale truck position', () => {
    const e = estimateTechnicianProfitability(
      job, tech('t1'), {}, undefined, null,
      signal({ vehicleLocation: { lat: 30.01, lng: -97.0, ageMinutes: 90 } }),
    );
    expect(e.reasons.join(' ')).not.toContain('live truck GPS');
  });

  it('uses real speed, cost/mile, idle cost and typical on-site time (clamped)', () => {
    const slow = estimateTechnicianProfitability(job, tech('t1'), {}, undefined, null, signal({ avgSpeedMph: 14, costPerMileCents: 120, idleCostPerTripCents: 300, onSiteMinutesByService: { hvac: 150 } }));
    const base = estimateTechnicianProfitability(job, tech('t1'), {}, undefined, null);
    expect(slow.expectedTravelCents).toBeGreaterThan(base.expectedTravelCents);
    expect(slow.expectedLaborCents).toBeGreaterThan(base.expectedLaborCents); // 150 min vs the 90 min default
    expect(slow.reasons.join(' ')).toContain('fleet history');

    const absurd = estimateTechnicianProfitability(job, tech('t1'), {}, undefined, null, signal({ avgSpeedMph: 0.5, costPerMileCents: 99_999 }));
    expect(Number.isFinite(absurd.expectedTravelCents)).toBe(true);
    expect(absurd.expectedTravelCents).toBeLessThan(100_000);
  });

  it('does not override an explicit job duration', () => {
    const explicit = { ...job, duration_minutes: 45 } as Job;
    const e = estimateTechnicianProfitability(explicit, tech('t1'), {}, undefined, null, signal({ onSiteMinutesByService: { hvac: 300 } }));
    expect(e.expectedLaborCents).toBe(Math.round((4_000 * 45) / 60));
  });

  it('can change which technician is recommended', () => {
    const techs = [tech('t1'), tech('t2', { home_latitude: 30.6 })];
    const without = rankTechniciansByProfitability(job, techs, {}, {}, {});
    const withFleet = rankTechniciansByProfitability(job, techs, {}, {}, {}, {
      t2: signal({ technicianId: 't2', vehicleLocation: { lat: 30.002, lng: -97.0, ageMinutes: 1 }, avgSpeedMph: 40, costPerMileCents: 30 }),
    });
    expect(without[0].technician.id).toBe('t1');
    expect(withFleet[0].technician.id).toBe('t2');
  });

  it('keeps the documented defaults', () => {
    expect(AVG_TRAVEL_SPEED_MPH).toBe(28);
    expect(MILEAGE_COST_CENTS_PER_MILE).toBe(67);
  });
});

const profile = (over: Partial<FleetProfile>): FleetProfile => ({
  id: 'p', profile_key: 'k', scope: 'technician', technician_id: 't1', vehicle_id: null, territory_id: null, service_type: null,
  sample_size: 12, avg_drive_minutes: 30, avg_on_site_minutes: 60, avg_distance_miles: 12, avg_speed_mph: 33, windshield_share_pct: 33,
  idle_share_pct: 10, cost_per_mile_cents: 80, variable_cost_per_mile_cents: 42, avg_idle_cost_cents: 90, avg_vehicle_cost_cents: 1_000,
  avg_fully_loaded_cost_cents: 7_000, avg_revenue_cents: 20_000, avg_contribution_cents: 13_000, avg_margin_pct: 65, on_time_pct: 88,
  harsh_per_100mi: 0.5, total_vehicle_cost_cents: 12_000, total_contribution_cents: 156_000, confidence: 'medium', computed_at: '2026-10-03T00:00:00Z', ...over,
});

const vehicle = (over: Partial<FleetVehicle> = {}): FleetVehicle => ({
  id: 'v1', label: 'Truck 1', make: null, model: null, status: 'active', assigned_technician_id: 't1', fuel_type: 'gasoline', rated_mpg: null,
  odometer_miles: 1000, telematics_provider: 'samsara', telematics_device_id: 'd1', last_latitude: 30.1, last_longitude: -97.1,
  last_speed_mph: 20, last_ignition_on: true, last_seen_at: new Date(NOW - 2 * 60_000).toISOString(), ...over,
});

describe('buildFleetDispatchSignals', () => {
  it('combines technician, service and vehicle profiles into one signal', () => {
    const signals = buildFleetDispatchSignals(
      [
        profile({}),
        profile({ scope: 'technician_service', service_type: 'hvac', avg_on_site_minutes: 75, profile_key: 'ts' }),
        profile({ scope: 'vehicle', technician_id: null, vehicle_id: 'v1', variable_cost_per_mile_cents: 38, profile_key: 'v' }),
      ],
      [vehicle()],
      NOW,
    );
    expect(signals.t1.avgSpeedMph).toBe(33);
    expect(signals.t1.costPerMileCents).toBe(38); // vehicle-level wins over technician-level
    expect(signals.t1.onSiteMinutesByService).toEqual({ hvac: 75 });
    expect(signals.t1.vehicleLocation?.lat).toBe(30.1);
    expect(signals.t1.vehicleLocation?.ageMinutes).toBeCloseTo(2, 0);
  });

  it('gives thin-data technicians no signal at all', () => {
    expect(buildFleetDispatchSignals([profile({ sample_size: 2 })], [vehicle()], NOW)).toEqual({});
  });

  it('works for a technician with no assigned truck', () => {
    const s = buildFleetDispatchSignals([profile({})], [vehicle({ assigned_technician_id: 'someone-else' })], NOW);
    expect(s.t1.vehicleLocation).toBeNull();
    expect(s.t1.costPerMileCents).toBe(42);
  });
});

describe('helpers', () => {
  it('summarizes the fleet with trip-weighted averages', () => {
    const s = summarizeFleet([
      profile({ sample_size: 10, avg_drive_minutes: 20, total_contribution_cents: 100 }),
      profile({ technician_id: 't2', sample_size: 30, avg_drive_minutes: 40, total_contribution_cents: 50 }),
      profile({ scope: 'vehicle', sample_size: 99, avg_drive_minutes: 999 }), // ignored: not a technician profile
    ]);
    expect(s.trips).toBe(40);
    expect(s.avgDriveMinutes).toBe(35);
    expect(s.contributionCents).toBe(150);
  });

  it('formats minutes and detects live vehicles', () => {
    expect(formatMinutes(null)).toBe('—');
    expect(formatMinutes(42)).toBe('42m');
    expect(formatMinutes(125)).toBe('2h 05m');
    expect(isVehicleLive(vehicle(), NOW)).toBe(true);
    expect(isVehicleLive(vehicle({ last_seen_at: new Date(NOW - 60 * 60_000).toISOString() }), NOW)).toBe(false);
    expect(isVehicleLive(vehicle({ last_seen_at: null }), NOW)).toBe(false);
  });

  it('generates unguessable ingest tokens and hashes them deterministically', async () => {
    const a = generateIngestToken();
    expect(a).toMatch(/^flt_[0-9a-f]{64}$/);
    expect(generateIngestToken()).not.toBe(a);
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('buildFleetInsights', () => {
  const names = { technician: (id: string | null) => id ?? '?', vehicle: (id: string | null) => id ?? '?' };

  it('flags windshield time, idle, lateness and harsh driving, most severe first', () => {
    const out = buildFleetInsights(
      [profile({ windshield_share_pct: 55, idle_share_pct: 20, on_time_pct: 60, harsh_per_100mi: 3 })],
      names,
    );
    expect(out.map((i) => i.id.split(':')[0])).toEqual(['harsh', 'wind', 'idle', 'ontime']);
    expect(out[0].severity).toBe('critical');
  });

  it('flags loss-making technician × vehicle × service combos and ignores thin data', () => {
    const combo = profile({ scope: 'combo', vehicle_id: 'v1', service_type: 'hvac', avg_margin_pct: -12, profile_key: 'c' });
    expect(buildFleetInsights([combo], names)).toHaveLength(1);
    expect(buildFleetInsights([{ ...combo, sample_size: 2 }], names)).toHaveLength(0);
  });
});
