import { haversineMiles, isValidPoint, liveEtaMinutes, type GeoPoint } from '@/lib/dispatchIntelligence';

export type EngineState = 'on' | 'off' | 'idle' | 'unknown';
export type MapVehicleState = 'moving' | 'idling' | 'stopped' | 'offline';
export type OpenJobStatus = 'scheduled' | 'en_route' | 'in_progress';

/** Matches telematics.ts OFFLINE_AFTER_MIN so both pages agree on what "offline" means. */
export const OFFLINE_AFTER_MIN = 15;
export const DEFAULT_GEOFENCE_M = 150;
export const TRAIL_WINDOW_MIN = 120;
export const MAX_TRAIL_POINTS = 240;
const METERS_PER_MILE = 1609.344;
const LATE_AFTER_MIN = 10;

export interface LiveRow {
  vehicle_id: string;
  latitude: number | null;
  longitude: number | null;
  speed_mph: number | null;
  heading_deg: number | null;
  engine_state: EngineState;
  fuel_pct: number | null;
  check_engine: boolean;
  last_fix_at: string | null;
  stationary_since: string | null;
  reverse_geo: string | null;
  current_job_id: string | null;
}

export interface MapVehicle {
  id: string;
  label: string;
  status: 'active' | 'in_shop' | 'retired';
  assigned_technician_id: string | null;
}

export interface MapTech {
  id: string;
  member_name: string | null;
  member_email: string;
}

export interface MapJob {
  id: string;
  customer_name: string;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
  job_status: OpenJobStatus;
  assigned_technician_id: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface TrailPoint {
  lat: number;
  lng: number;
  t: number;
}

export interface VehicleView {
  id: string;
  label: string;
  techName: string | null;
  point: GeoPoint;
  speedMph: number;
  headingDeg: number | null;
  state: MapVehicleState;
  lastFixAt: string | null;
  ageMin: number | null;
  reverseGeo: string | null;
  fuelPct: number | null;
  checkEngine: boolean;
  job: MapJob | null;
  etaMinutes: number | null;
  distanceMiles: number | null;
  onSite: boolean;
}

export interface UnlocatedVehicle {
  id: string;
  label: string;
  techName: string | null;
  lastFixAt: string | null;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function metersBetween(a: GeoPoint, b: GeoPoint): number {
  return haversineMiles(a, b) * METERS_PER_MILE;
}

/** Closed GeoJSON ring ([lng, lat]) approximating a circle of `radiusM` around `center`. */
export function circleRing(center: GeoPoint, radiusM: number, steps = 48): [number, number][] {
  const ring: [number, number][] = [];
  const latRad = (center.lat * Math.PI) / 180;
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.max(0.01, Math.cos(latRad)));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([center.lng + dLng * Math.cos(a), center.lat + dLat * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return ring;
}

export function clampRadius(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GEOFENCE_M;
  return Math.min(1000, Math.max(30, Math.round(n)));
}

export function computeBounds(points: GeoPoint[]): [[number, number], [number, number]] | null {
  const valid = points.filter(isValidPoint);
  if (valid.length === 0) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of valid) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  return [[minLng, minLat], [maxLng, maxLat]];
}

// ---------------------------------------------------------------------------
// Vehicle state
// ---------------------------------------------------------------------------

export function ageMinutes(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, (nowMs - t) / 60_000);
}

export function vehicleState(row: Pick<LiveRow, 'speed_mph' | 'engine_state' | 'last_fix_at'>, nowMs: number): MapVehicleState {
  const age = ageMinutes(row.last_fix_at, nowMs);
  if (age === null || age > OFFLINE_AFTER_MIN) return 'offline';
  if ((row.speed_mph ?? 0) >= 3) return 'moving';
  if (row.engine_state === 'on' || row.engine_state === 'idle') return 'idling';
  return 'stopped';
}

export function isOpenJob(status: string): status is OpenJobStatus {
  return status === 'scheduled' || status === 'en_route' || status === 'in_progress';
}

export function jobPoint(job: Pick<MapJob, 'latitude' | 'longitude'>): GeoPoint | null {
  if (job.latitude === null || job.longitude === null) return null;
  const p = { lat: Number(job.latitude), lng: Number(job.longitude) };
  return isValidPoint(p) ? p : null;
}

export function isLateJob(job: MapJob, nowMs: number): boolean {
  if (job.job_status !== 'scheduled' || !job.scheduled_datetime) return false;
  const t = Date.parse(job.scheduled_datetime);
  return !Number.isNaN(t) && nowMs - t > LATE_AFTER_MIN * 60_000;
}

/**
 * Which job a vehicle is heading to: its live `current_job_id` if that job is
 * open and on the map; otherwise the assigned technician's active job, then
 * their earliest upcoming one. Only jobs with coordinates qualify.
 */
export function pickTargetJob(vehicle: MapVehicle, row: LiveRow | undefined, jobs: MapJob[]): MapJob | null {
  const located = jobs.filter((j) => jobPoint(j) !== null);
  if (row?.current_job_id) {
    const current = located.find((j) => j.id === row.current_job_id);
    if (current) return current;
  }
  const techId = vehicle.assigned_technician_id;
  if (!techId) return null;
  const mine = located.filter((j) => j.assigned_technician_id === techId);
  const rank = (j: MapJob) => (j.job_status === 'en_route' ? 0 : j.job_status === 'in_progress' ? 1 : 2);
  mine.sort((a, b) => rank(a) - rank(b) || (Date.parse(a.scheduled_datetime ?? '') || Infinity) - (Date.parse(b.scheduled_datetime ?? '') || Infinity));
  return mine[0] ?? null;
}

export function techDisplayName(tech: MapTech | undefined): string | null {
  if (!tech) return null;
  return tech.member_name?.trim() || tech.member_email;
}

export function buildVehicleViews(
  vehicles: MapVehicle[],
  live: Map<string, LiveRow>,
  techs: MapTech[],
  jobs: MapJob[],
  nowMs: number,
  geofenceM: number,
): { views: VehicleView[]; unlocated: UnlocatedVehicle[] } {
  const techById = new Map(techs.map((t) => [t.id, t]));
  const views: VehicleView[] = [];
  const unlocated: UnlocatedVehicle[] = [];

  for (const v of vehicles) {
    if (v.status === 'retired') continue;
    const row = live.get(v.id);
    const techName = techDisplayName(v.assigned_technician_id ? techById.get(v.assigned_technician_id) : undefined);
    const point = row && row.latitude !== null && row.longitude !== null ? { lat: Number(row.latitude), lng: Number(row.longitude) } : null;
    if (!row || !point || !isValidPoint(point)) {
      unlocated.push({ id: v.id, label: v.label, techName, lastFixAt: row?.last_fix_at ?? null });
      continue;
    }

    const job = pickTargetJob(v, row, jobs);
    const target = job ? jobPoint(job) : null;
    const distanceM = target ? metersBetween(point, target) : null;
    const onSite = distanceM !== null && distanceM <= geofenceM;
    const eta = target && !onSite ? liveEtaMinutes(point, target, row.last_fix_at, nowMs, OFFLINE_AFTER_MIN) : null;

    views.push({
      id: v.id,
      label: v.label,
      techName,
      point,
      speedMph: Math.round(Number(row.speed_mph ?? 0)),
      headingDeg: row.heading_deg === null || row.heading_deg === undefined ? null : Number(row.heading_deg),
      state: vehicleState(row, nowMs),
      lastFixAt: row.last_fix_at,
      ageMin: ageMinutes(row.last_fix_at, nowMs),
      reverseGeo: row.reverse_geo,
      fuelPct: row.fuel_pct === null ? null : Number(row.fuel_pct),
      checkEngine: row.check_engine,
      job,
      etaMinutes: eta ? eta.minutes : null,
      distanceMiles: distanceM === null ? null : Math.round((distanceM / METERS_PER_MILE) * 10) / 10,
      onSite,
    });
  }
  views.sort((a, b) => a.label.localeCompare(b.label));
  return { views, unlocated };
}

export type StateFilter = 'all' | 'moving' | 'idling' | 'offline';

export function filterViews(views: VehicleView[], filter: StateFilter): VehicleView[] {
  if (filter === 'all') return views;
  if (filter === 'idling') return views.filter((v) => v.state === 'idling' || v.state === 'stopped');
  return views.filter((v) => v.state === filter);
}

export interface LiveMapSummary {
  located: number;
  moving: number;
  idle: number;
  offline: number;
  openJobs: number;
  lateJobs: number;
  jobsNotOnMap: number;
}

export function summarizeLiveMap(views: VehicleView[], jobs: MapJob[], nowMs: number): LiveMapSummary {
  return {
    located: views.length,
    moving: views.filter((v) => v.state === 'moving').length,
    idle: views.filter((v) => v.state === 'idling' || v.state === 'stopped').length,
    offline: views.filter((v) => v.state === 'offline').length,
    openJobs: jobs.length,
    lateJobs: jobs.filter((j) => isLateJob(j, nowMs)).length,
    jobsNotOnMap: jobs.filter((j) => jobPoint(j) === null).length,
  };
}

// ---------------------------------------------------------------------------
// Trails (vehicle_position_log breadcrumbs)
// ---------------------------------------------------------------------------

export interface PositionLogRow {
  vehicle_id: string;
  recorded_at: string;
  latitude: number;
  longitude: number;
}

function downsample(points: TrailPoint[], max: number): TrailPoint[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: TrailPoint[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/** Groups raw log rows per vehicle: ascending in time, de-duplicated, invalid coordinates dropped, capped. */
export function groupTrails(rows: PositionLogRow[]): Map<string, TrailPoint[]> {
  const byVehicle = new Map<string, TrailPoint[]>();
  for (const r of rows) {
    const t = Date.parse(r.recorded_at);
    const p = { lat: Number(r.latitude), lng: Number(r.longitude) };
    if (Number.isNaN(t) || !isValidPoint(p)) continue;
    const list = byVehicle.get(r.vehicle_id) ?? [];
    list.push({ ...p, t });
    byVehicle.set(r.vehicle_id, list);
  }
  for (const [id, list] of byVehicle) {
    list.sort((a, b) => a.t - b.t);
    const unique = list.filter((p, i) => i === 0 || p.t !== list[i - 1].t);
    byVehicle.set(id, downsample(unique, MAX_TRAIL_POINTS));
  }
  return byVehicle;
}

/** Appends a realtime fix to a trail, skipping GPS jitter and out-of-order points, and trimming old data. */
export function appendTrailPoint(trail: TrailPoint[], next: TrailPoint, nowMs: number, minMoveM = 15): TrailPoint[] {
  if (!isValidPoint(next)) return trail;
  const last = trail[trail.length - 1];
  if (last && (next.t <= last.t || metersBetween(last, next) < minMoveM)) return trail;
  const cutoff = nowMs - TRAIL_WINDOW_MIN * 60_000;
  const merged = [...trail, next].filter((p) => p.t >= cutoff);
  return merged.length > MAX_TRAIL_POINTS ? merged.slice(merged.length - MAX_TRAIL_POINTS) : merged;
}

// ---------------------------------------------------------------------------
// GeoJSON for map layers
// ---------------------------------------------------------------------------

export interface GeoFeature {
  type: 'Feature';
  properties: Record<string, string | number | boolean>;
  geometry:
    | { type: 'Polygon'; coordinates: [number, number][][] }
    | { type: 'LineString'; coordinates: [number, number][] };
}

export interface GeoCollection {
  type: 'FeatureCollection';
  features: GeoFeature[];
}

export function geofenceCollection(jobs: MapJob[], radiusM: number): GeoCollection {
  const features: GeoFeature[] = [];
  for (const job of jobs) {
    const p = jobPoint(job);
    if (!p) continue;
    features.push({
      type: 'Feature',
      properties: { jobId: job.id },
      geometry: { type: 'Polygon', coordinates: [circleRing(p, radiusM)] },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Straight-line legs from each vehicle to its target job. Drawn dashed: it shows intent, not the road route. */
export function routeCollection(views: VehicleView[]): GeoCollection {
  const features: GeoFeature[] = [];
  for (const v of views) {
    const target = v.job ? jobPoint(v.job) : null;
    if (!target || v.onSite || v.state === 'offline') continue;
    features.push({
      type: 'Feature',
      properties: { vehicleId: v.id },
      geometry: { type: 'LineString', coordinates: [[v.point.lng, v.point.lat], [target.lng, target.lat]] },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function trailCollection(trails: Map<string, TrailPoint[]>, visibleIds: Set<string>, selectedId: string | null): GeoCollection {
  const features: GeoFeature[] = [];
  for (const [id, points] of trails) {
    if (!visibleIds.has(id) || points.length < 2) continue;
    features.push({
      type: 'Feature',
      properties: { vehicleId: id, selected: id === selectedId },
      geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat] as [number, number]) },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function formatEta(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
