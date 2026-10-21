// Pure, dependency-free zone logic (no I/O) for the geofence editor: shape math, the
// per-vehicle enter/exit state machine, automation planning and the customer ETA message.
// Same idiom as engine.ts: every rule is deterministic and unit-testable. The I/O side lives
// in zoneRuntime.ts. Client-side twin for the editor UI: src/lib/geofences.ts (keep the
// geometry in sync; zones.test.ts and geofences.test.ts share the same expectations).

export interface GeoPoint { lat: number; lng: number }
/** GeoJSON order: [lng, lat]. Rings are stored OPEN (first point not repeated). */
export type LngLat = [number, number];

export type ZoneType = "depot" | "restricted" | "customer_site" | "job_site" | "shop" | "service_area";
export const ZONE_TYPES: readonly ZoneType[] = ["depot", "restricted", "customer_site", "job_site", "shop", "service_area"];

export interface ZoneAutomations {
  arrived?: { enabled: boolean };
  clock_in?: { enabled: boolean };
  eta_text?: { enabled: boolean; template?: string };
  exit_alert?: { enabled: boolean };
}

export interface Zone {
  id: string;
  name: string;
  type: ZoneType;
  shape: "circle" | "polygon";
  lat: number;
  lng: number;
  radiusM: number;
  polygon: LngLat[] | null;
  dwellSeconds: number;
  exitBufferM: number;
  jobId: string | null;
  automations: ZoneAutomations;
}

const EARTH_RADIUS_M = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Ray-casting point-in-polygon on [lng, lat] (planar is exact enough at zone scale). */
export function pointInPolygon(p: GeoPoint, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance in meters from p to the segment a-b, using a local equirectangular projection around p. */
export function distanceToSegmentM(p: GeoPoint, a: LngLat, b: LngLat): number {
  const kx = (Math.PI / 180) * EARTH_RADIUS_M * Math.cos(toRad(p.lat));
  const ky = (Math.PI / 180) * EARTH_RADIUS_M;
  const ax = (a[0] - p.lng) * kx, ay = (a[1] - p.lat) * ky;
  const bx = (b[0] - p.lng) * kx, by = (b[1] - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function distanceToRingM(p: GeoPoint, ring: LngLat[]): number {
  let min = Infinity;
  for (let i = 0; i < ring.length; i++) min = Math.min(min, distanceToSegmentM(p, ring[i], ring[(i + 1) % ring.length]));
  return min;
}

/**
 * Signed distance to the zone boundary in meters: <= 0 means inside (magnitude = depth),
 * > 0 means outside (magnitude = distance to the edge). One number drives both the
 * enter test (<= 0) and the exit hysteresis (> exitBufferM) for circles and polygons alike.
 */
export function signedDistanceM(p: GeoPoint, zone: Zone): number {
  if (zone.shape === "polygon" && zone.polygon && zone.polygon.length >= 3) {
    const d = distanceToRingM(p, zone.polygon);
    return pointInPolygon(p, zone.polygon) ? -d : d;
  }
  return haversineMeters(p, { lat: zone.lat, lng: zone.lng }) - zone.radiusM;
}

export const insideZone = (p: GeoPoint, zone: Zone) => signedDistanceM(p, zone) <= 0;

// ---------------------------------------------------------------------------
// Parsing DB rows defensively (a malformed row must never break ingestion)
// ---------------------------------------------------------------------------

export function normalizeAutomations(raw: unknown): ZoneAutomations {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const on = (k: string) => !!r[k] && typeof r[k] === "object" && (r[k] as { enabled?: unknown }).enabled === true;
  const out: ZoneAutomations = {};
  if (on("arrived")) out.arrived = { enabled: true };
  if (on("clock_in")) out.clock_in = { enabled: true };
  if (on("exit_alert")) out.exit_alert = { enabled: true };
  if (on("eta_text")) {
    const t = (r.eta_text as { template?: unknown }).template;
    out.eta_text = { enabled: true, ...(typeof t === "string" && t.trim() ? { template: t.slice(0, 320) } : {}) };
  }
  return out;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseZone(row: Record<string, unknown>): Zone | null {
  const lat = Number(row.latitude), lng = Number(row.longitude), radius = Number(row.radius_meters);
  if (typeof row.id !== "string" || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const type = ZONE_TYPES.includes(row.geofence_type as ZoneType) ? (row.geofence_type as ZoneType) : "customer_site";
  let polygon: LngLat[] | null = null;
  if (row.shape === "polygon") {
    const raw = row.polygon;
    if (!Array.isArray(raw) || raw.length < 3 || raw.length > 200) return null;
    const ring: LngLat[] = [];
    for (const pt of raw) {
      if (!Array.isArray(pt) || !finite(pt[0]) || !finite(pt[1]) || Math.abs(pt[0]) > 180 || Math.abs(pt[1]) > 90) return null;
      ring.push([pt[0], pt[1]]);
    }
    polygon = ring;
  } else if (!Number.isFinite(radius) || radius <= 0) {
    return null;
  }
  const clamp = (v: unknown, min: number, max: number, dflt: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : "Zone",
    type,
    shape: polygon ? "polygon" : "circle",
    lat, lng,
    radiusM: Number.isFinite(radius) && radius > 0 ? radius : 0,
    polygon,
    dwellSeconds: clamp(row.dwell_seconds, 0, 900, 60),
    exitBufferM: clamp(row.exit_buffer_m, 0, 500, 30),
    jobId: typeof row.job_id === "string" ? row.job_id : null,
    automations: normalizeAutomations(row.automations),
  };
}

// ---------------------------------------------------------------------------
// Enter / exit state machine (per vehicle x zone)
// ---------------------------------------------------------------------------

/** Compact on purpose: this is persisted in vehicle_live_state.zone_state on every flush. */
export interface ZoneState { in: boolean; pe?: number; px?: number; /** first sighting of this zone was already inside it */ cold?: boolean }
export type ZoneStateMap = Record<string, ZoneState>;

export interface ZoneFix { t: number; lat: number; lng: number }

export interface ZoneTransition {
  zoneId: string;
  kind: "enter" | "exit";
  /** Time of the FIRST fix that qualified (not the confirmation time). */
  at: number;
  distanceM: number;
  /** True when the vehicle was already inside the first time we saw this zone (no prior state). */
  coldStart: boolean;
}

/** An exit is confirmed only after the vehicle stays beyond the buffer this long (kills single-fix GPS outliers). */
export const EXIT_CONFIRM_MS = 20_000;

/**
 * Advance every zone with ONE fix.
 *  - Enter: inside (signed distance <= 0) continuously for dwellSeconds. A drive-by cancels.
 *  - Exit: beyond exitBufferM for EXIT_CONFIRM_MS. Hovering at the edge never flaps.
 *  - Zones that no longer exist are dropped from the state, so deleted zones never leak.
 */
export function stepZones(fix: ZoneFix, zones: Zone[], prev: ZoneStateMap): { state: ZoneStateMap; transitions: ZoneTransition[] } {
  const state: ZoneStateMap = {};
  const transitions: ZoneTransition[] = [];

  for (const zone of zones) {
    const known = prev[zone.id];
    const s: ZoneState = known ? { ...known } : { in: false };
    const d = signedDistanceM(fix, zone);

    if (!s.in) {
      if (d <= 0) {
        // No saved state + already inside = the truck was here before we ever tracked this zone.
        if (!known) s.cold = true;
        const since = s.pe ?? fix.t;
        if (fix.t - since >= zone.dwellSeconds * 1000) {
          transitions.push({ zoneId: zone.id, kind: "enter", at: since, distanceM: Math.round(Math.max(0, -d)), coldStart: s.cold === true });
          s.in = true;
          delete s.pe;
          delete s.cold;
        } else {
          s.pe = since;
        }
      } else {
        delete s.pe;
        delete s.cold;
      }
    } else if (d > zone.exitBufferM) {
      const since = s.px ?? fix.t;
      if (fix.t - since >= EXIT_CONFIRM_MS) {
        transitions.push({ zoneId: zone.id, kind: "exit", at: since, distanceM: Math.round(d), coldStart: false });
        s.in = false;
        delete s.px;
      } else {
        s.px = since;
      }
    } else {
      delete s.px;
    }
    state[zone.id] = s;
  }
  return { state, transitions };
}

// ---------------------------------------------------------------------------
// Automation planning
// ---------------------------------------------------------------------------

/** Transitions older than this are recorded but never acted on (batch replays must not text customers). */
export const STALE_ACTION_MS = 15 * 60_000;

export type ActionKind = "arrived" | "clock_in" | "eta_text" | "exit_alert";

export interface PlannedAction {
  kind: ActionKind;
  /** When set, the action is recorded as skipped with this reason instead of executed. */
  skip?: string;
}

export function planActions(zone: Zone, t: ZoneTransition, nowMs: number): PlannedAction[] {
  const a = zone.automations;
  const stale = nowMs - t.at > STALE_ACTION_MS;
  const plan: PlannedAction[] = [];
  const add = (kind: ActionKind, skipWhen?: [boolean, string][]) => {
    const skip = (skipWhen ?? []).find(([cond]) => cond)?.[1] ?? (stale ? "stale_event" : undefined);
    plan.push(skip ? { kind, skip } : { kind });
  };
  if (t.kind === "enter") {
    if (a.arrived?.enabled) add("arrived");
    if (a.clock_in?.enabled) add("clock_in");
    // "on my way" text is meaningless if the truck was already inside when we first saw the zone.
    if (a.eta_text?.enabled) add("eta_text", [[t.coldStart, "already_inside"]]);
  } else if (a.exit_alert?.enabled) {
    add("exit_alert");
  }
  return plan;
}

export interface ZoneJobCandidate {
  id: string;
  lat: number;
  lng: number;
  scheduledMs: number | null;
  status: string;
}

/** The job a zone event is about: the zone's own job if linked, else the nearest-in-time open job inside the zone. */
export function pickZoneJob(zone: Zone, jobs: ZoneJobCandidate[], nowMs: number): ZoneJobCandidate | null {
  if (zone.jobId) return jobs.find((j) => j.id === zone.jobId) ?? null;
  const inside = jobs.filter((j) => insideZone({ lat: j.lat, lng: j.lng }, zone));
  if (inside.length === 0) return null;
  const gap = (j: ZoneJobCandidate) => (j.scheduledMs === null ? Number.MAX_SAFE_INTEGER : Math.abs(j.scheduledMs - nowMs));
  return [...inside].sort((a, b) => gap(a) - gap(b))[0];
}

// ---------------------------------------------------------------------------
// Customer ETA text
// ---------------------------------------------------------------------------

const ROAD_FACTOR = 1.3;     // straight line -> typical road distance
const MIN_SPEED_MPH = 18;    // never promise faster than a slow urban average
const MAX_SPEED_MPH = 45;
const MPH_TO_MPM = 26.8224;  // miles per hour -> meters per minute

/** Honest, conservative ETA from straight-line distance. Always at least 1 minute, capped at 3 hours. */
export function estimateEtaMinutes(distanceM: number, speedMph: number | null): number {
  const mph = speedMph !== null && Number.isFinite(speedMph) ? Math.min(MAX_SPEED_MPH, Math.max(MIN_SPEED_MPH, speedMph)) : 28;
  return Math.min(180, Math.max(1, Math.round((distanceM * ROAD_FACTOR) / (mph * MPH_TO_MPM))));
}

export const DEFAULT_ETA_TEMPLATE = "Hi {customer}, {tech} from {company} is about {eta} away. {link}";

export interface EtaVars { customer: string; tech: string; company: string; eta: string; link: string }

/** Fills {placeholders}; unknown placeholders are removed, whitespace is tidied, length capped at 320. */
export function renderEtaMessage(template: string | undefined, vars: EtaVars): string {
  const source = template && template.trim() ? template : DEFAULT_ETA_TEMPLATE;
  const filled = source.replace(/\{(\w+)\}/g, (_m, key: string) => (key in vars ? vars[key as keyof EtaVars] : ""));
  return filled.replace(/\s+/g, " ").replace(/\s+([.,!?])/g, "$1").trim().slice(0, 320);
}

export const formatEtaMinutes = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`);
