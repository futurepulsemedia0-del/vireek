/* ------------------------------------------------------------------ */
/*  geofences — pure logic for the zone editor on /dashboard/live-map  */
/*  (types, geometry, validation, row mapping, GeoJSON, summaries).    */
/*  Server twin: supabase/functions/_shared/telematics/zones.ts —      */
/*  keep the geometry and the ETA message renderer in sync with it.    */
/* ------------------------------------------------------------------ */

import type { GeoPoint } from '@/lib/dispatchIntelligence';
import { circleRing, metersBetween } from '@/lib/liveMap';

export type LngLat = [number, number];
export type ZoneType = 'job_site' | 'customer_site' | 'shop' | 'depot' | 'service_area' | 'restricted';
export type ZoneShape = 'circle' | 'polygon';

export const MIN_RADIUS_M = 25;
export const MAX_RADIUS_M = 100_000;
export const MIN_VERTICES = 3;
export const MAX_VERTICES = 200;
export const MIN_AREA_M2 = 400;
export const MAX_NAME_LENGTH = 80;
export const MAX_TEMPLATE_LENGTH = 320;
export const DEFAULT_COLOR = '#2563eb';
export const ZONE_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'] as const;
export const ETA_PLACEHOLDERS = ['customer', 'tech', 'company', 'eta', 'link'] as const;
export const DEFAULT_ETA_TEMPLATE = 'Hi {customer}, {tech} from {company} is about {eta} away. {link}';

export interface AutomationConfig {
  /** Enter: mark the technician's job arrived / in progress. */
  arrived: boolean;
  /** Enter: start the assigned technician's shift on the time clock. */
  clock_in: boolean;
  /** Enter: text the customer an ETA (+ tracking link when live tracking is on). */
  eta_text: boolean;
  /** Exit: notify the account that the vehicle left. */
  exit_alert: boolean;
  /** Custom ETA text; empty means the default template. */
  eta_template: string;
}

export interface Geofence {
  id: string;
  name: string;
  type: ZoneType;
  shape: ZoneShape;
  lat: number;
  lng: number;
  radiusM: number;
  polygon: LngLat[] | null;
  color: string;
  notes: string;
  dwellSeconds: number;
  exitBufferM: number;
  jobId: string | null;
  active: boolean;
  automations: AutomationConfig;
}

export interface GeofenceDraft {
  id: string | null;
  name: string;
  type: ZoneType;
  shape: ZoneShape;
  center: GeoPoint | null;
  radiusM: number;
  polygon: LngLat[];
  color: string;
  notes: string;
  dwellSeconds: number;
  exitBufferM: number;
  jobId: string | null;
  active: boolean;
  automations: AutomationConfig;
}

export interface ZoneTypeMeta {
  label: string;
  hint: string;
  color: string;
  /** Sensible automations pre-selected when the type is chosen. */
  preset: Omit<AutomationConfig, 'eta_template'>;
}

export const ZONE_TYPE_META: Record<ZoneType, ZoneTypeMeta> = {
  job_site: { label: 'Job site', hint: 'The property a job happens at.', color: '#2563eb', preset: { arrived: true, clock_in: false, eta_text: false, exit_alert: false } },
  customer_site: { label: 'Customer approach', hint: 'A ring around a customer address, to text them an ETA as the truck gets close.', color: '#7c3aed', preset: { arrived: false, clock_in: false, eta_text: true, exit_alert: false } },
  shop: { label: 'Shop / yard', hint: 'Your shop or warehouse. Entering can start the technician’s shift.', color: '#16a34a', preset: { arrived: false, clock_in: true, eta_text: false, exit_alert: false } },
  depot: { label: 'Depot', hint: 'A staging or parking location.', color: '#0891b2', preset: { arrived: false, clock_in: false, eta_text: false, exit_alert: false } },
  service_area: { label: 'Service area', hint: 'Where you work. Leaving it can alert you.', color: '#d97706', preset: { arrived: false, clock_in: false, eta_text: false, exit_alert: true } },
  restricted: { label: 'Restricted area', hint: 'Somewhere vehicles should not be.', color: '#dc2626', preset: { arrived: false, clock_in: false, eta_text: false, exit_alert: false } },
};
export const ZONE_TYPES = Object.keys(ZONE_TYPE_META) as ZoneType[];

export const defaultAutomations = (type: ZoneType): AutomationConfig => ({ ...ZONE_TYPE_META[type].preset, eta_template: '' });

export function newDraft(shape: ZoneShape, type: ZoneType = 'customer_site'): GeofenceDraft {
  return {
    id: null, name: '', type, shape, center: null, radiusM: shape === 'circle' ? 200 : 0, polygon: [],
    color: ZONE_TYPE_META[type].color, notes: '', dwellSeconds: 60, exitBufferM: 30, jobId: null, active: true,
    automations: defaultAutomations(type),
  };
}

export function draftFromGeofence(g: Geofence): GeofenceDraft {
  return {
    id: g.id, name: g.name, type: g.type, shape: g.shape,
    center: g.shape === 'circle' ? { lat: g.lat, lng: g.lng } : null,
    radiusM: g.shape === 'circle' ? g.radiusM : 0, polygon: g.polygon ? g.polygon.map((p) => [...p] as LngLat) : [],
    color: g.color, notes: g.notes, dwellSeconds: g.dwellSeconds, exitBufferM: g.exitBufferM, jobId: g.jobId, active: g.active,
    automations: { ...g.automations },
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const M_PER_DEG = 111_320;

/** Planar projection (meters) around a reference latitude: exact enough at zone scale. */
function project(ring: LngLat[]): Array<[number, number]> {
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  return ring.map((p) => [p[0] * kx, p[1] * M_PER_DEG]);
}

export function polygonAreaM2(ring: LngLat[]): number {
  if (ring.length < 3) return 0;
  const pts = project(ring);
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

export function polygonCentroid(ring: LngLat[]): GeoPoint {
  const pts = project(ring);
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (Math.abs(a) < 1e-9) return { lat: lat0, lng: ring.reduce((s, p) => s + p[0], 0) / ring.length };
  return { lng: cx / (3 * a) / kx, lat: cy / (3 * a) / M_PER_DEG };
}

export function boundingRadiusM(ring: LngLat[], center: GeoPoint): number {
  return ring.reduce((max, p) => Math.max(max, metersBetween(center, { lat: p[1], lng: p[0] })), 0);
}

export function pointInPolygon(p: GeoPoint, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const orient = (a: [number, number], b: [number, number], c: [number, number]) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));

function segmentsCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  return orient(a, b, c) !== orient(a, b, d) && orient(c, d, a) !== orient(c, d, b) && orient(a, b, c) !== 0 && orient(a, b, d) !== 0 && orient(c, d, a) !== 0 && orient(c, d, b) !== 0;
}

/** True when any two non-adjacent edges cross (a "bow-tie"). Such zones have ambiguous insides, so they are rejected. */
export function isSelfIntersecting(ring: LngLat[]): boolean {
  if (ring.length < 4) return false;
  const pts = project(ring);
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // adjacent edges share a vertex
      if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

export function pointInGeofence(p: GeoPoint, g: Pick<Geofence, 'shape' | 'lat' | 'lng' | 'radiusM' | 'polygon'>): boolean {
  if (g.shape === 'polygon' && g.polygon) return pointInPolygon(p, g.polygon);
  return metersBetween(p, { lat: g.lat, lng: g.lng }) <= g.radiusM;
}

export function insertVertex(ring: LngLat[], index: number, point: LngLat): LngLat[] {
  const next = ring.slice();
  next.splice(Math.max(0, Math.min(next.length, index)), 0, point);
  return next;
}

export function removeVertex(ring: LngLat[], index: number): LngLat[] {
  return ring.length <= MIN_VERTICES ? ring : ring.filter((_, i) => i !== index);
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km (${(m / 1609.344).toFixed(m < 16_093 ? 1 : 0)} mi)`;
}

export function formatArea(m2: number): string {
  if (m2 < 10_000) return `${Math.round(m2).toLocaleString('en-US')} m²`;
  return `${(m2 / 1_000_000).toFixed(m2 < 10_000_000 ? 2 : 1)} km²`;
}

// ---------------------------------------------------------------------------
// Automations <-> jsonb
// ---------------------------------------------------------------------------

export function automationsToJson(a: AutomationConfig): Record<string, { enabled: boolean; template?: string }> {
  const out: Record<string, { enabled: boolean; template?: string }> = {};
  if (a.arrived) out.arrived = { enabled: true };
  if (a.clock_in) out.clock_in = { enabled: true };
  if (a.exit_alert) out.exit_alert = { enabled: true };
  if (a.eta_text) {
    const template = a.eta_template.trim();
    out.eta_text = template ? { enabled: true, template } : { enabled: true };
  }
  return out;
}

export function automationsFromJson(raw: unknown): AutomationConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, { enabled?: unknown; template?: unknown } | undefined>;
  const on = (k: string) => r[k]?.enabled === true;
  return {
    arrived: on('arrived'), clock_in: on('clock_in'), eta_text: on('eta_text'), exit_alert: on('exit_alert'),
    eta_template: typeof r.eta_text?.template === 'string' ? r.eta_text.template : '',
  };
}

export function hasAnyAutomation(a: AutomationConfig): boolean {
  return a.arrived || a.clock_in || a.eta_text || a.exit_alert;
}

const AUTOMATION_LABELS: Array<[keyof Omit<AutomationConfig, 'eta_template'>, string]> = [
  ['arrived', 'Auto-arrived'], ['clock_in', 'Auto clock-in'], ['eta_text', 'ETA text'], ['exit_alert', 'Exit alert'],
];

export const describeAutomations = (a: AutomationConfig): string[] => AUTOMATION_LABELS.filter(([k]) => a[k]).map(([, label]) => label);

// ---------------------------------------------------------------------------
// ETA template
// ---------------------------------------------------------------------------

export function unknownPlaceholders(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(/\{(\w+)\}/g)) if (!(ETA_PLACEHOLDERS as readonly string[]).includes(m[1])) found.add(m[1]);
  return [...found];
}

export function previewEtaTemplate(template: string): string {
  const vars: Record<string, string> = { customer: 'Maria', tech: 'Alex', company: 'Your Company', eta: '12 min', link: 'Track live: https://app.vireek.com/track/…' };
  const source = template.trim() || DEFAULT_ETA_TEMPLATE;
  return source.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '').replace(/\s+/g, ' ').replace(/\s+([.,!?])/g, '$1').trim().slice(0, MAX_TEMPLATE_LENGTH);
}

// ---------------------------------------------------------------------------
// Validation + row mapping
// ---------------------------------------------------------------------------

export type DraftErrors = Partial<Record<'name' | 'shape' | 'radius' | 'template' | 'dwell' | 'buffer', string>>;

const validLngLat = (p: LngLat) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

export function validateDraft(d: GeofenceDraft): DraftErrors {
  const errors: DraftErrors = {};
  const name = d.name.trim();
  if (!name) errors.name = 'Give the zone a name.';
  else if (name.length > MAX_NAME_LENGTH) errors.name = `Keep the name under ${MAX_NAME_LENGTH} characters.`;

  if (d.shape === 'circle') {
    if (!d.center || !Number.isFinite(d.center.lat) || !Number.isFinite(d.center.lng)) errors.shape = 'Click the map to place the center.';
    else if (!Number.isFinite(d.radiusM) || d.radiusM < MIN_RADIUS_M || d.radiusM > MAX_RADIUS_M) {
      errors.radius = `Radius must be between ${MIN_RADIUS_M} m and ${formatDistance(MAX_RADIUS_M)}.`;
    }
  } else if (d.polygon.length < MIN_VERTICES) {
    errors.shape = `Add at least ${MIN_VERTICES} points on the map.`;
  } else if (d.polygon.length > MAX_VERTICES || !d.polygon.every(validLngLat)) {
    errors.shape = `A zone can have up to ${MAX_VERTICES} valid points.`;
  } else if (isSelfIntersecting(d.polygon)) {
    errors.shape = 'The edges cross each other. Drag a point so the outline does not overlap itself.';
  } else if (polygonAreaM2(d.polygon) < MIN_AREA_M2) {
    errors.shape = 'The zone is too small to track reliably (GPS is accurate to a few meters). Make it larger.';
  } else if (boundingRadiusM(d.polygon, polygonCentroid(d.polygon)) > MAX_RADIUS_M) {
    errors.shape = `The zone is too large (over ${formatDistance(MAX_RADIUS_M)} across).`;
  }

  if (!Number.isFinite(d.dwellSeconds) || d.dwellSeconds < 0 || d.dwellSeconds > 900) errors.dwell = 'Between 0 and 900 seconds.';
  if (!Number.isFinite(d.exitBufferM) || d.exitBufferM < 0 || d.exitBufferM > 500) errors.buffer = 'Between 0 and 500 meters.';

  if (d.automations.eta_text) {
    const t = d.automations.eta_template;
    const unknown = unknownPlaceholders(t);
    if (t.length > MAX_TEMPLATE_LENGTH) errors.template = `Keep the message under ${MAX_TEMPLATE_LENGTH} characters.`;
    else if (unknown.length > 0) errors.template = `Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `{${u}}`).join(', ')}.`;
  }
  return errors;
}

export const isDraftValid = (d: GeofenceDraft) => Object.keys(validateDraft(d)).length === 0;

/** Columns written to fleet_geofences (user_id is added by the API layer). Call only on a valid draft. */
export function draftToRow(d: GeofenceDraft) {
  const circle = d.shape === 'circle';
  const center = circle ? (d.center as GeoPoint) : polygonCentroid(d.polygon);
  const radius = circle ? d.radiusM : Math.ceil(boundingRadiusM(d.polygon, center));
  return {
    name: d.name.trim(),
    geofence_type: d.type,
    shape: d.shape,
    latitude: Number(center.lat.toFixed(7)),
    longitude: Number(center.lng.toFixed(7)),
    radius_meters: Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(radius))),
    polygon: circle ? null : d.polygon.map((p) => [Number(p[0].toFixed(7)), Number(p[1].toFixed(7))]),
    color: d.color,
    notes: d.notes.trim() || null,
    dwell_seconds: Math.round(d.dwellSeconds),
    exit_buffer_m: Math.round(d.exitBufferM),
    job_id: d.jobId,
    active: d.active,
    automations: automationsToJson(d.automations),
  };
}

export interface GeofenceRow {
  id: string;
  name: string | null;
  geofence_type: string | null;
  shape?: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number | null;
  polygon?: unknown;
  color?: string | null;
  notes?: string | null;
  dwell_seconds?: number | null;
  exit_buffer_m?: number | null;
  job_id?: string | null;
  active?: boolean | null;
  automations?: unknown;
}

/** Defensive mapping: a malformed row is dropped (null) instead of crashing the map. */
export function rowToGeofence(row: GeofenceRow): Geofence | null {
  const lat = Number(row.latitude), lng = Number(row.longitude);
  if (!row.id || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let polygon: LngLat[] | null = null;
  if (row.shape === 'polygon') {
    if (!Array.isArray(row.polygon)) return null;
    const ring: LngLat[] = [];
    for (const pt of row.polygon as unknown[]) {
      if (!Array.isArray(pt) || typeof pt[0] !== 'number' || typeof pt[1] !== 'number') return null;
      ring.push([pt[0], pt[1]]);
    }
    if (ring.length < MIN_VERTICES) return null;
    polygon = ring;
  }
  const type = (ZONE_TYPES as string[]).includes(row.geofence_type ?? '') ? (row.geofence_type as ZoneType) : 'customer_site';
  return {
    id: row.id, name: row.name?.trim() || 'Untitled zone', type, shape: polygon ? 'polygon' : 'circle', lat, lng,
    radiusM: Number(row.radius_meters) || 0, polygon,
    color: /^#[0-9a-fA-F]{6}$/.test(row.color ?? '') ? (row.color as string) : ZONE_TYPE_META[type].color,
    notes: row.notes ?? '', dwellSeconds: Number(row.dwell_seconds ?? 60), exitBufferM: Number(row.exit_buffer_m ?? 30),
    jobId: row.job_id ?? null, active: row.active !== false, automations: automationsFromJson(row.automations),
  };
}

// ---------------------------------------------------------------------------
// GeoJSON for the map
// ---------------------------------------------------------------------------

export interface ZoneFeature {
  type: 'Feature';
  properties: Record<string, string | number | boolean>;
  geometry: { type: 'Polygon'; coordinates: LngLat[][] } | { type: 'LineString'; coordinates: LngLat[] } | { type: 'Point'; coordinates: LngLat };
}
export interface ZoneCollection { type: 'FeatureCollection'; features: ZoneFeature[] }

const closed = (ring: LngLat[]): LngLat[] => [...ring, ring[0]];

function geofenceRing(g: Pick<Geofence, 'shape' | 'lat' | 'lng' | 'radiusM' | 'polygon'>): LngLat[] {
  return g.shape === 'polygon' && g.polygon ? closed(g.polygon) : circleRing({ lat: g.lat, lng: g.lng }, g.radiusM);
}

/** Saved zones. `hideId` hides the one being edited (its live preview is drawn from the draft instead). */
export function zoneCollection(zones: Geofence[], selectedId: string | null, hideId: string | null): ZoneCollection {
  const features: ZoneFeature[] = [];
  for (const z of zones) {
    if (z.id === hideId) continue;
    features.push({
      type: 'Feature',
      properties: { id: z.id, name: z.name, color: z.color, active: z.active, selected: z.id === selectedId },
      geometry: { type: 'Polygon', coordinates: [geofenceRing(z)] },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function zoneLabelCollection(zones: Geofence[], hideId: string | null): ZoneCollection {
  return {
    type: 'FeatureCollection',
    features: zones.filter((z) => z.id !== hideId).map((z) => ({
      type: 'Feature' as const, properties: { name: z.name, color: z.color },
      geometry: { type: 'Point' as const, coordinates: [z.lng, z.lat] as LngLat },
    })),
  };
}

/** Live preview of the zone being drawn: ring / outline / nothing yet. */
export function draftCollection(d: GeofenceDraft | null): ZoneCollection {
  const features: ZoneFeature[] = [];
  if (d) {
    const props = { color: d.color, draft: true };
    if (d.shape === 'circle' && d.center && d.radiusM > 0) {
      features.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [circleRing(d.center, d.radiusM)] } });
    } else if (d.shape === 'polygon') {
      if (d.polygon.length >= 3) features.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [closed(d.polygon)] } });
      else if (d.polygon.length === 2) features.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: d.polygon } });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** East-most point of a circle: where the radius handle sits. */
export function radiusHandlePoint(center: GeoPoint, radiusM: number): LngLat {
  const dLng = radiusM / (M_PER_DEG * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180)));
  return [center.lng + dLng, center.lat];
}

export function clampRadiusM(m: number): number {
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(m)));
}

// ---------------------------------------------------------------------------
// Activity feed (fleet_geofence_events)
// ---------------------------------------------------------------------------

export interface ZoneActionResult { action: 'arrived' | 'clock_in' | 'eta_text' | 'exit_alert'; status: 'done' | 'skipped' | 'failed'; detail?: string }

export interface ZoneEventRow {
  id: string;
  zone_name: string;
  vehicle_id: string;
  kind: 'enter' | 'exit';
  occurred_at: string;
  actions: ZoneActionResult[] | null;
}

const ACTION_NAME: Record<ZoneActionResult['action'], string> = { arrived: 'Arrived', clock_in: 'Clock-in', eta_text: 'ETA text', exit_alert: 'Exit alert' };
const SKIP_REASON: Record<string, string> = {
  stale_event: 'late data', already_inside: 'already inside', no_job_in_zone: 'no job here', no_customer_phone: 'no phone',
  already_sent: 'already sent', opted_out: 'opted out', a2p_not_approved: 'texting not approved', quiet_hours: 'quiet hours',
  not_configured: 'texting not set up', no_technician: 'no technician', no_employee: 'not an employee',
  already_clocked_in: 'already clocked in', status_changed: 'job changed', duplicate: 'duplicate',
};

export function summarizeActions(actions: ZoneActionResult[] | null | undefined): string {
  if (!actions || actions.length === 0) return 'No automations';
  return actions
    .map((a) => {
      const name = ACTION_NAME[a.action] ?? a.action;
      if (a.status === 'done') return `${name} ✓`;
      const why = a.detail ? (SKIP_REASON[a.detail] ?? a.detail.replace(/_/g, ' ')) : '';
      return a.status === 'failed' ? `${name} failed${why ? ` (${why})` : ''}` : `${name} skipped${why ? ` (${why})` : ''}`;
    })
    .join(' · ');
}

export function relativeTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.max(0, Math.round((nowMs - t) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 1440) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / 1440)} d ago`;
}
