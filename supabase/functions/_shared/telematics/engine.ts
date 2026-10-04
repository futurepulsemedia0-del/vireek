// Pure, dependency-free telematics logic (no I/O) so every rule is unit-testable and
// auditable. Same idiom as _shared/dispatch/assign.ts. Fleet cost/safety scoring must be
// deterministic rules, never an LLM guess.

export interface GeoPoint { lat: number; lng: number }

export interface Fix {
  t: number; // epoch ms
  lat: number;
  lng: number;
  speedMph: number | null;
  engine: "on" | "off" | "idle" | "unknown";
}

export interface TelematicsSettings {
  geofence_radius_m: number;
  dwell_arrival_seconds: number;
  departure_buffer_m: number;
  idle_threshold_seconds: number;
  auto_advance_job_status: boolean;
}

export const DEFAULT_SETTINGS: TelematicsSettings = {
  geofence_radius_m: 150,
  dwell_arrival_seconds: 120,
  departure_buffer_m: 75,
  idle_threshold_seconds: 300,
  auto_advance_job_status: false,
};

/** Merge stored settings over defaults and clamp to sane ranges. */
export function normalizeSettings(raw: unknown): TelematicsSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (k: keyof TelematicsSettings, min: number, max: number) => {
    const v = Number(r[k]);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : (DEFAULT_SETTINGS[k] as number);
  };
  return {
    geofence_radius_m: num("geofence_radius_m", 30, 1000),
    dwell_arrival_seconds: num("dwell_arrival_seconds", 15, 900),
    departure_buffer_m: num("departure_buffer_m", 10, 500),
    idle_threshold_seconds: num("idle_threshold_seconds", 60, 3600),
    auto_advance_job_status: r.auto_advance_job_status === true,
  };
}

const EARTH_RADIUS_M = 6_371_000;
const METERS_PER_MILE = 1609.344;

export function isValidPoint(p: Partial<GeoPoint> | null | undefined): p is GeoPoint {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
    Math.abs(p.lat as number) <= 90 && Math.abs(p.lng as number) <= 180 &&
    !((p.lat as number) === 0 && (p.lng as number) === 0); // null-island = bad fix
}

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const metersToMiles = (m: number) => m / METERS_PER_MILE;

/**
 * Throttle breadcrumb storage. Keep a fix when: it is the first one, OR >=30s AND >=50m
 * moved, OR >=150m moved at any pace, OR >=120s passed (heartbeat while parked).
 */
export function shouldLogBreadcrumb(prev: Fix | null, next: Fix, minSeconds = 30, minMeters = 50): boolean {
  if (!prev) return true;
  if (next.t <= prev.t) return false;
  const secs = (next.t - prev.t) / 1000;
  const meters = haversineMeters(prev, next);
  if (meters >= minMeters * 3) return true;
  if (secs >= minSeconds && meters >= minMeters) return true;
  return secs >= minSeconds * 4;
}

// ---------------------------------------------------------------------------
// Geofence arrival / departure state machine (per vehicle x job)
// ---------------------------------------------------------------------------

/** pending maps jobId -> epoch ms of first fix inside the fence (not yet dwelled). */
export type PendingMap = Record<string, number>;

export interface OpenVisit { jobId: string; arrivedAt: number }

export interface GeofenceStep {
  pending: PendingMap;
  arrivals: { jobId: string; arrivedAt: number; distanceM: number }[];
  departures: { jobId: string; departedAt: number }[];
}

/**
 * Advance the state machine with ONE fix. Rules:
 *  - Inside = within radius. Arrival is confirmed only after the vehicle has been
 *    inside for dwell_arrival_seconds (so drive-bys don't count). arrivedAt is the
 *    FIRST inside fix, not the confirmation time.
 *  - Leaving before the dwell elapses cancels the pending arrival.
 *  - An open visit closes only when the vehicle is beyond radius + departure_buffer
 *    (hysteresis stops GPS jitter at the fence edge from creating phantom visits).
 */
export function stepGeofence(
  fix: Fix,
  sites: { jobId: string; point: GeoPoint }[],
  pending: PendingMap,
  open: OpenVisit[],
  cfg: TelematicsSettings,
): GeofenceStep {
  const nextPending: PendingMap = {};
  const arrivals: GeofenceStep["arrivals"] = [];
  const departures: GeofenceStep["departures"] = [];
  const openIds = new Set(open.map((o) => o.jobId));

  for (const site of sites) {
    const d = haversineMeters(fix, site.point);
    const inside = d <= cfg.geofence_radius_m;

    if (openIds.has(site.jobId)) {
      if (d > cfg.geofence_radius_m + cfg.departure_buffer_m) {
        departures.push({ jobId: site.jobId, departedAt: fix.t });
      }
      continue;
    }
    if (!inside) continue;

    const since = pending[site.jobId] ?? fix.t;
    if (fix.t - since >= cfg.dwell_arrival_seconds * 1000) {
      arrivals.push({ jobId: site.jobId, arrivedAt: since, distanceM: Math.round(d) });
    } else {
      nextPending[site.jobId] = since;
    }
  }

  // Callers MUST include every job that has an open visit in `sites`, even if it is no
  // longer a scheduling candidate, otherwise its departure would never be detected.
  return { pending: nextPending, arrivals, departures };
}

// ---------------------------------------------------------------------------
// Trip derivation from breadcrumbs
// ---------------------------------------------------------------------------

export interface DerivedTrip {
  startedAt: number;
  endedAt: number;
  distanceMiles: number;
  drivingSeconds: number;
  idleSeconds: number;
  maxSpeedMph: number;
  start: GeoPoint;
  end: GeoPoint;
}

const MOVING_MPH = 3;
const MAX_SEGMENT_GAP_S = 600; // beyond this, don't bridge distance across a data gap
const MAX_PLAUSIBLE_MPH = 130; // implied speed above this = GPS glitch, drop segment
const TRIP_END_STATIONARY_S = 300;
const MIN_TRIP_MILES = 0.1;

/**
 * Fixes MUST be sorted ascending by time. A trip = movement, closed by >=5 min stationary
 * or by a data gap > 10 min (we never invent distance across missing data). Idle seconds
 * only count stops INSIDE a trip (traffic, short stops); the closing wait is discarded.
 */
export function deriveTrips(fixes: Fix[]): DerivedTrip[] {
  type Open = DerivedTrip & { stationaryFor: number; pendingIdle: number };
  const trips: DerivedTrip[] = [];
  let cur: Open | null = null;
  let prev: Fix | null = null;

  const close = () => {
    if (cur && cur.distanceMiles >= MIN_TRIP_MILES) {
      trips.push({
        startedAt: cur.startedAt,
        endedAt: cur.endedAt,
        distanceMiles: round(cur.distanceMiles, 2),
        drivingSeconds: Math.round(cur.drivingSeconds),
        idleSeconds: Math.round(cur.idleSeconds),
        maxSpeedMph: round(cur.maxSpeedMph, 1),
        start: cur.start,
        end: cur.end,
      });
    }
    cur = null;
  };

  for (const fix of fixes) {
    if (!isValidPoint(fix)) continue;
    if (!prev) { prev = fix; continue; }

    const dt = (fix.t - prev.t) / 1000;
    if (dt <= 0) continue;
    if (dt > MAX_SEGMENT_GAP_S) { close(); prev = fix; continue; }

    const distM = haversineMeters(prev, fix);
    const impliedMph = (metersToMiles(distM) / dt) * 3600;
    if (impliedMph > MAX_PLAUSIBLE_MPH) { prev = fix; continue; } // GPS glitch: skip segment
    const moving = impliedMph >= MOVING_MPH || (fix.speedMph ?? 0) >= MOVING_MPH;

    if (moving) {
      if (!cur) {
        cur = {
          startedAt: prev.t, endedAt: fix.t, distanceMiles: 0, drivingSeconds: 0, idleSeconds: 0,
          maxSpeedMph: 0, start: { lat: prev.lat, lng: prev.lng }, end: { lat: fix.lat, lng: fix.lng },
          stationaryFor: 0, pendingIdle: 0,
        };
      }
      cur.idleSeconds += cur.pendingIdle;
      cur.pendingIdle = 0;
      cur.distanceMiles += metersToMiles(distM);
      cur.drivingSeconds += dt;
      cur.maxSpeedMph = Math.max(cur.maxSpeedMph, fix.speedMph ?? impliedMph);
      cur.endedAt = fix.t;
      cur.end = { lat: fix.lat, lng: fix.lng };
      cur.stationaryFor = 0;
    } else if (cur) {
      cur.stationaryFor += dt;
      if (fix.engine === "on" || fix.engine === "idle") cur.pendingIdle += dt;
      if (cur.stationaryFor >= TRIP_END_STATIONARY_S) close();
    }
    prev = fix;
  }
  close();
  return trips;
}

// ---------------------------------------------------------------------------
// Driver safety score
// ---------------------------------------------------------------------------

export interface SafetyInputs {
  miles: number;
  harshBrake: number;
  harshAccel: number;
  harshTurn: number;
  speeding: number;
  other: number; // collision / distracted / seatbelt etc.
}

const WEIGHTS = { harshBrake: 3, harshAccel: 2, harshTurn: 2, speeding: 4, other: 6 };
const SCORE_K = 1.2;
const MIN_MILES_BASIS = 20; // a 3-mile day with 1 event must not read as catastrophic

/** 100 = spotless. Events are normalized per 100 miles with a floor on the mileage basis. */
export function safetyScore(i: SafetyInputs): number {
  const weighted = i.harshBrake * WEIGHTS.harshBrake + i.harshAccel * WEIGHTS.harshAccel +
    i.harshTurn * WEIGHTS.harshTurn + i.speeding * WEIGHTS.speeding + i.other * WEIGHTS.other;
  if (weighted === 0) return 100;
  const per100 = (weighted / Math.max(i.miles, MIN_MILES_BASIS)) * 100;
  return Math.max(0, Math.min(100, round(100 - per100 * SCORE_K, 1)));
}

export type SafetyTier = "excellent" | "good" | "watch" | "at_risk";
export function safetyTier(score: number): SafetyTier {
  return score >= 90 ? "excellent" : score >= 75 ? "good" : score >= 60 ? "watch" : "at_risk";
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export interface MaintenanceSchedule {
  interval_miles: number | null;
  interval_days: number | null;
  last_service_miles: number | null;
  last_service_date: string | null; // YYYY-MM-DD
}

export interface MaintenanceStatus {
  status: "ok" | "due_soon" | "overdue";
  milesRemaining: number | null;
  daysRemaining: number | null;
}

export function maintenanceStatus(s: MaintenanceSchedule, odometer: number | null, now: number): MaintenanceStatus {
  let milesRemaining: number | null = null;
  let daysRemaining: number | null = null;

  if (s.interval_miles && s.last_service_miles != null && odometer != null) {
    milesRemaining = round(s.last_service_miles + s.interval_miles - odometer, 0);
  }
  if (s.interval_days && s.last_service_date) {
    const due = Date.parse(`${s.last_service_date}T00:00:00Z`) + s.interval_days * 86_400_000;
    if (!Number.isNaN(due)) daysRemaining = Math.ceil((due - now) / 86_400_000);
  }

  const overdue = (milesRemaining != null && milesRemaining < 0) || (daysRemaining != null && daysRemaining < 0);
  const soonMiles = milesRemaining != null && s.interval_miles
    ? milesRemaining <= Math.max(300, s.interval_miles * 0.1) : false;
  const soonDays = daysRemaining != null && s.interval_days
    ? daysRemaining <= Math.max(7, Math.round(s.interval_days * 0.1)) : false;

  return { status: overdue ? "overdue" : soonMiles || soonDays ? "due_soon" : "ok", milesRemaining, daysRemaining };
}

// ---------------------------------------------------------------------------
// Job operational truth: vehicle -> technician -> job -> value -> customer outcome
// ---------------------------------------------------------------------------

export interface TruthInputs {
  arrivalVerified: boolean;
  minutesLate: number | null;
  onsiteMinutes: number | null;
  driveMiles: number;
  idleMinutes: number;
  harshEvents: number;
  speedingEvents: number;
  revenue: number;
  travelCost: number;
  customerRating: number | null;
  isRework: boolean;
  customerDisputed: boolean;
}

export interface TruthResult {
  score: number;
  flags: string[];
  valuePerOnsiteHour: number | null;
}

/**
 * 0-100 "operational integrity" of a completed job. Weights (sum 100):
 *  GPS-verified arrival 25 | punctuality 15 | safe driving 15 | no rework 15 |
 *  no dispute 10 | customer rating 10 | travel efficiency 10.
 * Unknown inputs (no rating yet, no schedule) score neutral-half, never zero, so
 * missing data is not mistaken for bad behaviour.
 */
export function operationalTruth(i: TruthInputs): TruthResult {
  const flags: string[] = [];
  let score = 0;

  score += i.arrivalVerified ? 25 : 0;
  if (!i.arrivalVerified) flags.push("no_gps_arrival");

  if (i.minutesLate == null) score += 7.5;
  else if (i.minutesLate <= 10) score += 15;
  else if (i.minutesLate <= 30) { score += 8; flags.push("late_arrival"); }
  else { score += 0; flags.push("very_late_arrival"); }

  const unsafe = i.harshEvents + i.speedingEvents * 2;
  score += unsafe === 0 ? 15 : unsafe <= 2 ? 9 : unsafe <= 5 ? 4 : 0;
  if (unsafe > 2) flags.push("unsafe_driving");

  score += i.isRework ? 0 : 15;
  if (i.isRework) flags.push("rework");

  score += i.customerDisputed ? 0 : 10;
  if (i.customerDisputed) flags.push("disputed");

  if (i.customerRating == null) score += 5;
  else if (i.customerRating >= 4) score += 10;
  else if (i.customerRating === 3) score += 5;
  else { score += 0; flags.push("low_rating"); }

  const travelShare = i.revenue > 0 ? i.travelCost / i.revenue : null;
  if (travelShare == null) score += 5;
  else if (travelShare <= 0.1) score += 10;
  else if (travelShare <= 0.25) score += 6;
  else { score += 0; flags.push("travel_heavy"); }

  if (i.onsiteMinutes != null && i.onsiteMinutes < 10 && i.revenue > 0) flags.push("short_visit_billed");
  if (i.idleMinutes >= 20) flags.push("excess_idle");

  const valuePerOnsiteHour = i.onsiteMinutes && i.onsiteMinutes > 0 ? round((i.revenue / i.onsiteMinutes) * 60, 2) : null;
  return { score: Math.max(0, Math.min(100, round(score, 1))), flags, valuePerOnsiteHour };
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
