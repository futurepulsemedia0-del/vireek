// Fleet Intelligence — pure, dependency-free core.
//
//   Vehicle → GPS → Technician → Job → Drive → Arrival → Work → Outcome
//
// Everything here is a deterministic function of its inputs (no I/O, no
// Deno APIs) so it is auditable and unit-testable under vitest, and so the
// edge functions (`compute-fleet-intelligence`, `fleet-telemetry-ingest`)
// stay thin. Fleet cost accounting must be explainable, never an LLM guess.
//
// Conventions: timestamps are epoch milliseconds, distances are miles,
// money is integer cents.

// ============================================================
// TUNABLE ASSUMPTIONS — every one is named, exported and only used when the
// real data point (odometer, expenses, rated mpg, tech rate) is missing.
// ============================================================

export const ROAD_FACTOR = 1.3; // straight-line → road distance multiplier
export const DEFAULT_ARRIVAL_RADIUS_METERS = 150;
export const MAX_PING_GAP_MS = 10 * 60 * 1000;
export const MAX_PLAUSIBLE_MPH = 120; // faster implied speed ⇒ GPS glitch, segment ignored
export const IDLE_SPEED_MPH = 2;
export const MAX_IDLE_INTERVAL_MS = 15 * 60 * 1000;
export const ON_TIME_GRACE_MINUTES = 10;

export const DEFAULT_FUEL_PRICE_CENTS_PER_GALLON = 385;
export const DEFAULT_WEAR_CENTS_PER_MILE = 18; // tires, brakes, oil, depreciation share
export const DEFAULT_ELECTRIC_CENTS_PER_MILE = 6;
export const IDLE_GALLONS_PER_HOUR = 0.6;
export const DEFAULT_HOURLY_COST_CENTS = 3_500; // keep in sync with src/lib/dispatchProfitability.ts

export const DEFAULT_MPG_BY_FUEL: Record<string, number> = {
  gasoline: 15,
  diesel: 17,
  hybrid: 30,
  propane: 12,
  other: 15,
};

export const HARSH_ACCEL_MPH_PER_SEC = 7; // ≈0.32 g
export const HARSH_BRAKE_MPH_PER_SEC = 7;
export const EXTREME_SPEED_MPH = 85;

// ============================================================
// GEOMETRY
// ============================================================

export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineMiles(lat1, lon1, lat2, lon2) * 1609.344;
}

// ============================================================
// TYPES
// ============================================================

export interface Ping {
  t: number;
  lat: number;
  lng: number;
  speedMph: number | null;
  ignitionOn: boolean | null;
  odometer: number | null;
}

export interface TripJobInput {
  latitude: number | null;
  longitude: number | null;
  scheduledAt: number | null;
  /** jobs.arrived_at — the technician mobile OS stamps it when status becomes `en_route`. */
  enRouteAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
}

export type DistanceSource = 'odometer' | 'gps_path' | 'estimated' | 'manual' | 'none';
export type Confidence = 'high' | 'medium' | 'low';

export interface ReconstructedTrip {
  departedAt: number | null;
  arrivedAt: number | null;
  arrivalVerified: boolean;
  driveMinutes: number | null;
  idleMinutes: number | null;
  onSiteMinutes: number | null;
  arrivalDelayMinutes: number | null;
  distanceMiles: number | null;
  distanceSource: DistanceSource;
  avgSpeedMph: number | null;
  pingCount: number;
  gpsCoverage: number | null;
  confidence: Confidence;
  flags: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ============================================================
// TRIP RECONSTRUCTION  (Drive → Arrival → Work)
// ============================================================

export function reconstructTrip(input: {
  job: TripJobInput;
  pings: Ping[];
  radiusMeters?: number;
  /** Where the vehicle was before departing, used only when no GPS exists. */
  startFallback?: { lat: number; lng: number } | null;
}): ReconstructedTrip {
  const { job } = input;
  const radius = input.radiusMeters ?? DEFAULT_ARRIVAL_RADIUS_METERS;
  const pings = [...input.pings].sort((a, b) => a.t - b.t);
  const flags: string[] = [];
  const hasTarget = job.latitude != null && job.longitude != null;

  const departedAt = job.enRouteAt;
  if (departedAt == null) flags.push('no_departure_timestamp');

  // ---- Arrival: first GPS sample inside the job geofence after departure.
  let arrivedAt: number | null = null;
  let arrivalVerified = false;
  if (hasTarget && departedAt != null) {
    const hit = pings.find(
      (p) => p.t >= departedAt && haversineMeters(p.lat, p.lng, job.latitude as number, job.longitude as number) <= radius,
    );
    if (hit) {
      arrivedAt = job.startedAt != null ? Math.min(hit.t, job.startedAt) : hit.t;
      arrivalVerified = true;
    }
  }
  if (arrivedAt == null && job.startedAt != null) {
    arrivedAt = job.startedAt;
    flags.push('arrival_from_work_start');
  }
  if (departedAt != null && arrivedAt != null && arrivedAt < departedAt) {
    arrivedAt = null;
    arrivalVerified = false;
    flags.push('arrival_before_departure');
  }

  // ---- Drive segment.
  const seg =
    departedAt != null && arrivedAt != null ? pings.filter((p) => p.t >= departedAt && p.t <= arrivedAt) : [];
  const driveMinutes =
    departedAt != null && arrivedAt != null ? round1((arrivedAt - departedAt) / 60000) : null;

  // Odometer delta (best), GPS path (good), straight-line estimate (fallback).
  let distanceMiles: number | null = null;
  let distanceSource: DistanceSource = 'none';
  let gpsCoverage: number | null = null;

  const odo = seg.filter((p) => p.odometer != null);
  if (odo.length >= 2) {
    const delta = (odo[odo.length - 1].odometer as number) - (odo[0].odometer as number);
    if (delta >= 0 && delta <= 500) {
      distanceMiles = round2(delta);
      distanceSource = 'odometer';
    } else {
      flags.push('odometer_implausible');
    }
  }

  if (seg.length >= 2) {
    let path = 0;
    let coveredMs = 0;
    for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1];
      const b = seg[i];
      const dtMs = b.t - a.t;
      if (dtMs <= 0) continue;
      const d = haversineMiles(a.lat, a.lng, b.lat, b.lng);
      if (d / (dtMs / 3_600_000) > MAX_PLAUSIBLE_MPH) {
        flags.push('gps_glitch_skipped');
        continue;
      }
      if (dtMs <= MAX_PING_GAP_MS) {
        path += d;
        coveredMs += dtMs;
      } else {
        path += d * ROAD_FACTOR; // sparse data: straight-line gap filled with the road factor
      }
    }
    const totalMs = (arrivedAt as number) - (departedAt as number);
    gpsCoverage = totalMs > 0 ? Math.min(1, round2(coveredMs / totalMs)) : null;
    if (distanceSource === 'none') {
      distanceMiles = round2(path);
      distanceSource = 'gps_path';
    }
  }

  if (distanceSource === 'none' && hasTarget && input.startFallback) {
    distanceMiles = round2(
      haversineMiles(input.startFallback.lat, input.startFallback.lng, job.latitude as number, job.longitude as number) *
        ROAD_FACTOR,
    );
    distanceSource = 'estimated';
    flags.push('distance_estimated');
  }

  // ---- Idle while driving (ignition on, wheels not turning).
  let idleMinutes: number | null = null;
  if (seg.length >= 2 && driveMinutes != null) {
    let idleMs = 0;
    for (let i = 0; i < seg.length - 1; i++) {
      const p = seg[i];
      if (p.ignitionOn !== false && p.speedMph != null && p.speedMph < IDLE_SPEED_MPH) {
        idleMs += Math.min(seg[i + 1].t - p.t, MAX_IDLE_INTERVAL_MS);
      }
    }
    idleMinutes = round1(Math.min(idleMs / 60000, driveMinutes));
  }

  // ---- Work.
  const onSiteMinutes =
    job.startedAt != null && job.completedAt != null && job.completedAt > job.startedAt
      ? round1((job.completedAt - job.startedAt) / 60000)
      : null;

  const arrivalDelayMinutes =
    job.scheduledAt != null && arrivedAt != null ? round1((arrivedAt - job.scheduledAt) / 60000) : null;

  let avgSpeedMph: number | null = null;
  if (distanceMiles != null && distanceMiles > 0 && driveMinutes != null) {
    const movingMinutes = driveMinutes - (idleMinutes ?? 0);
    if (movingMinutes >= 1) {
      const mph = distanceMiles / (movingMinutes / 60);
      if (mph <= 90) avgSpeedMph = round1(mph);
      else flags.push('avg_speed_implausible');
    }
  }

  let confidence: Confidence = 'low';
  if (departedAt != null && arrivedAt != null && distanceSource !== 'none' && distanceSource !== 'estimated') {
    confidence = 'medium'; // an estimated straight-line distance from an unknown origin is never better than 'low'
  }
  if (
    confidence === 'medium' &&
    arrivalVerified &&
    (distanceSource === 'odometer' || distanceSource === 'gps_path') &&
    (gpsCoverage ?? 0) >= 0.7 &&
    onSiteMinutes != null
  ) {
    confidence = 'high';
  }

  return {
    departedAt,
    arrivedAt,
    arrivalVerified,
    driveMinutes,
    idleMinutes,
    onSiteMinutes,
    arrivalDelayMinutes,
    distanceMiles,
    distanceSource,
    avgSpeedMph,
    pingCount: seg.length,
    gpsCoverage,
    confidence,
    flags: Array.from(new Set(flags)),
  };
}

// ============================================================
// HARSH-EVENT DERIVATION (only from high-frequency pings)
// ============================================================

export interface DerivedEvent {
  t: number;
  type: 'harsh_braking' | 'harsh_acceleration' | 'speeding';
  severity: 1 | 2 | 3;
  value: number;
  unit: 'mph_per_s' | 'mph';
  lat: number;
  lng: number;
}

/**
 * Derives harsh braking / acceleration from consecutive pings ≤ 6 s apart and
 * extreme-speed rising edges. Providers that emit native harsh events should
 * send those directly instead (they use the accelerometer, which is better).
 */
export function deriveHarshEvents(input: Ping[]): DerivedEvent[] {
  const pings = [...input].sort((a, b) => a.t - b.t);
  const events: DerivedEvent[] = [];
  for (let i = 1; i < pings.length; i++) {
    const a = pings[i - 1];
    const b = pings[i];
    const dt = (b.t - a.t) / 1000;
    if (b.speedMph != null && b.speedMph >= EXTREME_SPEED_MPH && !(a.speedMph != null && a.speedMph >= EXTREME_SPEED_MPH)) {
      events.push({ t: b.t, type: 'speeding', severity: b.speedMph >= 100 ? 3 : 2, value: round1(b.speedMph), unit: 'mph', lat: b.lat, lng: b.lng });
    }
    if (dt < 0.5 || dt > 6 || a.speedMph == null || b.speedMph == null) continue;
    const accel = (b.speedMph - a.speedMph) / dt;
    if (accel <= -HARSH_BRAKE_MPH_PER_SEC) {
      const sev = accel <= -12 ? 3 : accel <= -9 ? 2 : 1;
      events.push({ t: b.t, type: 'harsh_braking', severity: sev, value: round1(Math.abs(accel)), unit: 'mph_per_s', lat: b.lat, lng: b.lng });
    } else if (accel >= HARSH_ACCEL_MPH_PER_SEC) {
      const sev = accel >= 12 ? 3 : accel >= 9 ? 2 : 1;
      events.push({ t: b.t, type: 'harsh_acceleration', severity: sev, value: round1(accel), unit: 'mph_per_s', lat: b.lat, lng: b.lng });
    }
  }
  return events;
}

// ============================================================
// VEHICLE COST MODEL
// ============================================================

export interface VehicleCostPerMile {
  fuelCentsPerMile: number;
  wearCentsPerMile: number;
  basis: 'actual' | 'modeled';
}

export function estimateVehicleCostPerMile(input: {
  fuelExpenseCents: number;
  maintenanceExpenseCents: number; // maintenance + repair
  windowMiles: number;
  ratedMpg: number | null;
  fuelType: string | null;
  fuelPriceCentsPerGallon?: number;
}): VehicleCostPerMile {
  const price = input.fuelPriceCentsPerGallon ?? DEFAULT_FUEL_PRICE_CENTS_PER_GALLON;
  const fuelType = input.fuelType ?? 'gasoline';
  const modeledFuel =
    fuelType === 'electric'
      ? DEFAULT_ELECTRIC_CENTS_PER_MILE
      : price / (input.ratedMpg && input.ratedMpg > 0 ? input.ratedMpg : (DEFAULT_MPG_BY_FUEL[fuelType] ?? 15));

  const hasActuals = input.windowMiles >= 100 && input.fuelExpenseCents >= 5_000;
  if (hasActuals) {
    const wear =
      input.maintenanceExpenseCents > 0
        ? input.maintenanceExpenseCents / input.windowMiles
        : DEFAULT_WEAR_CENTS_PER_MILE;
    return {
      fuelCentsPerMile: round2(input.fuelExpenseCents / input.windowMiles),
      wearCentsPerMile: round2(wear),
      basis: 'actual',
    };
  }
  return { fuelCentsPerMile: round2(modeledFuel), wearCentsPerMile: DEFAULT_WEAR_CENTS_PER_MILE, basis: 'modeled' };
}

/**
 * Splits one vehicle-day of fixed cost (payment + insurance + logged
 * downtime) across the jobs it rolled to, weighted by time, instead of
 * charging the whole day to each job.
 */
export function allocateFixedCost(
  trips: { id: string; weightMinutes: number }[],
  dailyFixedCents: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (trips.length === 0) return out;
  const total = trips.reduce((s, t) => s + Math.max(0, t.weightMinutes), 0);
  for (const t of trips) {
    const share = total > 0 ? Math.max(0, t.weightMinutes) / total : 1 / trips.length;
    out.set(t.id, Math.round(dailyFixedCents * share));
  }
  return out;
}

// ============================================================
// TRIP COST + CONTRIBUTION
// ============================================================

export interface TripCosts {
  fuelCostCents: number;
  wearCostCents: number;
  idleCostCents: number;
  fixedCostCents: number;
  vehicleCostCents: number;
  driveLaborCostCents: number;
  onSiteLaborCostCents: number;
  fullyLoadedCostCents: number;
  revenueCents: number;
  contributionCents: number;
  marginPct: number | null;
}

export function computeTripCosts(input: {
  distanceMiles: number | null;
  driveMinutes: number | null;
  idleMinutes: number | null;
  onSiteMinutes: number | null;
  hourlyCostCents: number | null;
  cost: VehicleCostPerMile;
  fixedCostCents: number;
  fuelType?: string | null;
  fuelPriceCentsPerGallon?: number;
  revenueCents: number;
}): TripCosts {
  const hourly = input.hourlyCostCents ?? DEFAULT_HOURLY_COST_CENTS;
  const price = input.fuelPriceCentsPerGallon ?? DEFAULT_FUEL_PRICE_CENTS_PER_GALLON;
  const miles = Math.max(0, input.distanceMiles ?? 0);

  const fuelCostCents = Math.round(miles * input.cost.fuelCentsPerMile);
  const wearCostCents = Math.round(miles * input.cost.wearCentsPerMile);
  const idleCostCents =
    input.fuelType === 'electric' ? 0 : Math.round(((input.idleMinutes ?? 0) / 60) * IDLE_GALLONS_PER_HOUR * price);
  const fixedCostCents = Math.max(0, Math.round(input.fixedCostCents));
  const vehicleCostCents = fuelCostCents + wearCostCents + idleCostCents + fixedCostCents;

  const driveLaborCostCents = Math.round((hourly * (input.driveMinutes ?? 0)) / 60);
  const onSiteLaborCostCents = Math.round((hourly * (input.onSiteMinutes ?? 0)) / 60);
  const fullyLoadedCostCents = vehicleCostCents + driveLaborCostCents + onSiteLaborCostCents;

  const revenueCents = Math.max(0, Math.round(input.revenueCents));
  const contributionCents = revenueCents - fullyLoadedCostCents;
  const marginPct = revenueCents > 0 ? round1((contributionCents / revenueCents) * 100) : null;

  return {
    fuelCostCents,
    wearCostCents,
    idleCostCents,
    fixedCostCents,
    vehicleCostCents,
    driveLaborCostCents,
    onSiteLaborCostCents,
    fullyLoadedCostCents,
    revenueCents,
    contributionCents,
    marginPct,
  };
}

// ============================================================
// PROFILES (rollups read by Dispatch + Workforce + the Fleet page)
// ============================================================

export interface TripRowForProfile {
  technician_id: string | null;
  vehicle_id: string;
  territory_id: string | null;
  service_type: string | null;
  drive_minutes: number | null;
  idle_minutes: number | null;
  on_site_minutes: number | null;
  arrival_delay_minutes: number | null;
  distance_miles: number | null;
  harsh_event_count: number;
  fuel_cost_cents: number;
  wear_cost_cents: number;
  idle_cost_cents: number;
  vehicle_cost_cents: number;
  fully_loaded_cost_cents: number;
  revenue_cents: number;
  contribution_cents: number;
  margin_pct: number | null;
  confidence: Confidence;
}

export type ProfileScope = 'technician' | 'technician_service' | 'vehicle' | 'territory_service' | 'combo';

export interface FleetProfile {
  profile_key: string;
  scope: ProfileScope;
  technician_id: string | null;
  vehicle_id: string | null;
  territory_id: string | null;
  service_type: string | null;
  sample_size: number;
  avg_drive_minutes: number | null;
  avg_on_site_minutes: number | null;
  avg_distance_miles: number | null;
  avg_speed_mph: number | null;
  windshield_share_pct: number | null;
  idle_share_pct: number | null;
  /** Fully loaded vehicle cost (fuel + wear + idle + fixed) per mile. */
  cost_per_mile_cents: number | null;
  /** Marginal cost of one more mile (fuel + wear only) — what Dispatch should use. */
  variable_cost_per_mile_cents: number | null;
  avg_idle_cost_cents: number | null;
  avg_vehicle_cost_cents: number | null;
  avg_fully_loaded_cost_cents: number | null;
  avg_revenue_cents: number | null;
  avg_contribution_cents: number | null;
  avg_margin_pct: number | null;
  on_time_pct: number | null;
  harsh_per_100mi: number | null;
  total_vehicle_cost_cents: number;
  total_contribution_cents: number;
  confidence: Confidence;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

function aggregate(rows: TripRowForProfile[]): Omit<FleetProfile, 'profile_key' | 'scope' | 'technician_id' | 'vehicle_id' | 'territory_id' | 'service_type'> {
  const nz = <T>(v: T | null | undefined): v is T => v != null;
  const drive = rows.map((r) => r.drive_minutes).filter(nz);
  const onSite = rows.map((r) => r.on_site_minutes).filter(nz);
  const dist = rows.map((r) => r.distance_miles).filter(nz);

  const both = rows.filter((r) => r.drive_minutes != null && r.on_site_minutes != null);
  const sumDriveBoth = both.reduce((s, r) => s + (r.drive_minutes as number), 0);
  const sumOnSiteBoth = both.reduce((s, r) => s + (r.on_site_minutes as number), 0);

  const idleRows = rows.filter((r) => r.drive_minutes != null && r.idle_minutes != null && (r.drive_minutes as number) > 0);
  const sumDriveIdle = idleRows.reduce((s, r) => s + (r.drive_minutes as number), 0);
  const sumIdle = idleRows.reduce((s, r) => s + (r.idle_minutes as number), 0);

  const speedRows = rows.filter((r) => (r.distance_miles ?? 0) > 0 && r.drive_minutes != null);
  const speedMilesTotal = speedRows.reduce((s, r) => s + (r.distance_miles as number), 0);
  const movingHours = speedRows.reduce((s, r) => s + ((r.drive_minutes as number) - (r.idle_minutes ?? 0)) / 60, 0);

  const costRows = rows.filter((r) => (r.distance_miles ?? 0) > 0);
  const costMiles = costRows.reduce((s, r) => s + (r.distance_miles as number), 0);
  const costTotal = costRows.reduce((s, r) => s + r.vehicle_cost_cents, 0);

  const delayRows = rows.filter((r) => r.arrival_delay_minutes != null);
  const onTime = delayRows.filter((r) => (r.arrival_delay_minutes as number) <= ON_TIME_GRACE_MINUTES).length;

  const harshMiles = costMiles;
  const harshCount = costRows.reduce((s, r) => s + r.harsh_event_count, 0);

  const invoiced = rows.filter((r) => r.revenue_cents > 0);
  const margins = invoiced.map((r) => r.margin_pct).filter(nz);

  const highShare = rows.length > 0 ? rows.filter((r) => r.confidence === 'high').length / rows.length : 0;
  const confidence: Confidence = rows.length >= 15 && highShare >= 0.5 ? 'high' : rows.length >= 5 ? 'medium' : 'low';

  const m = (n: number | null, digits = 1) => (n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

  return {
    sample_size: rows.length,
    avg_drive_minutes: m(mean(drive)),
    avg_on_site_minutes: m(mean(onSite)),
    avg_distance_miles: m(mean(dist), 2),
    avg_speed_mph: movingHours > 0.05 ? m(speedMilesTotal / movingHours) : null,
    windshield_share_pct: sumDriveBoth + sumOnSiteBoth > 0 ? m((sumDriveBoth / (sumDriveBoth + sumOnSiteBoth)) * 100) : null,
    idle_share_pct: sumDriveIdle > 0 ? m((sumIdle / sumDriveIdle) * 100) : null,
    cost_per_mile_cents: costMiles > 0 ? m(costTotal / costMiles, 2) : null,
    variable_cost_per_mile_cents:
      costMiles > 0 ? m(costRows.reduce((s, r) => s + r.fuel_cost_cents + r.wear_cost_cents, 0) / costMiles, 2) : null,
    avg_idle_cost_cents: m(mean(rows.map((r) => r.idle_cost_cents)), 0),
    avg_vehicle_cost_cents: m(mean(rows.map((r) => r.vehicle_cost_cents)), 0),
    avg_fully_loaded_cost_cents: m(mean(rows.map((r) => r.fully_loaded_cost_cents)), 0),
    avg_revenue_cents: m(mean(invoiced.map((r) => r.revenue_cents)), 0),
    avg_contribution_cents: m(mean(invoiced.map((r) => r.contribution_cents)), 0),
    avg_margin_pct: m(mean(margins)),
    on_time_pct: delayRows.length > 0 ? m((onTime / delayRows.length) * 100) : null,
    harsh_per_100mi: harshMiles >= 10 ? m((harshCount / harshMiles) * 100) : null,
    total_vehicle_cost_cents: rows.reduce((s, r) => s + r.vehicle_cost_cents, 0),
    total_contribution_cents: invoiced.reduce((s, r) => s + r.contribution_cents, 0),
    confidence,
  };
}

export function buildProfiles(rows: TripRowForProfile[]): FleetProfile[] {
  const groups = new Map<string, { meta: Pick<FleetProfile, 'scope' | 'technician_id' | 'vehicle_id' | 'territory_id' | 'service_type'>; rows: TripRowForProfile[] }>();

  const add = (
    key: string,
    meta: Pick<FleetProfile, 'scope' | 'technician_id' | 'vehicle_id' | 'territory_id' | 'service_type'>,
    row: TripRowForProfile,
  ) => {
    const g = groups.get(key);
    if (g) g.rows.push(row);
    else groups.set(key, { meta, rows: [row] });
  };

  for (const r of rows) {
    const svc = r.service_type ?? 'general';
    if (r.technician_id) {
      add(`t:${r.technician_id}`, { scope: 'technician', technician_id: r.technician_id, vehicle_id: null, territory_id: null, service_type: null }, r);
      add(`ts:${r.technician_id}:${svc}`, { scope: 'technician_service', technician_id: r.technician_id, vehicle_id: null, territory_id: null, service_type: svc }, r);
      add(
        `c:${r.technician_id}:${r.vehicle_id}:${svc}`,
        { scope: 'combo', technician_id: r.technician_id, vehicle_id: r.vehicle_id, territory_id: r.territory_id, service_type: svc },
        r,
      );
    }
    add(`v:${r.vehicle_id}`, { scope: 'vehicle', technician_id: null, vehicle_id: r.vehicle_id, territory_id: null, service_type: null }, r);
    if (r.territory_id) {
      add(`tr:${r.territory_id}:${svc}`, { scope: 'territory_service', technician_id: null, vehicle_id: null, territory_id: r.territory_id, service_type: svc }, r);
    }
  }

  return Array.from(groups.entries()).map(([profile_key, g]) => ({
    profile_key,
    ...g.meta,
    ...aggregate(g.rows),
  }));
}
