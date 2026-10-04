/**
 * Fleet Intelligence — client library.
 *
 *   Vehicle → GPS → Technician → Job → Drive → Arrival → Work → Outcome
 *
 * Reads the output tables written by the `compute-fleet-intelligence` and
 * `fleet-telemetry-ingest` edge functions and turns them into:
 *   - the Fleet Intelligence page data,
 *   - the per-technician FleetDispatchSignal that Dispatch Profitability uses
 *     (real speed, real cost/mile, live truck GPS, typical on-site time),
 *   - small pure helpers (formatting, ingest-token generation).
 *
 * Pure builders are separated from I/O so they are unit-tested the same way as
 * dispatchProfitability.ts.
 */

import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/priceBook';
import type { FleetDispatchSignal } from '@/lib/dispatchProfitability';

// ============================================================
// TYPES — mirror 20270210000000_fleet_telematics_intelligence.sql
// ============================================================

export type FleetConfidence = 'high' | 'medium' | 'low';
export type FleetProfileScope = 'technician' | 'technician_service' | 'vehicle' | 'territory_service' | 'combo';
export type TelematicsProvider = 'vireek_mobile' | 'samsara' | 'geotab' | 'verizon_connect' | 'motive' | 'other';

export interface FleetVehicle {
  id: string;
  label: string;
  make: string | null;
  model: string | null;
  status: 'active' | 'in_shop' | 'retired';
  assigned_technician_id: string | null;
  fuel_type: string;
  rated_mpg: number | null;
  odometer_miles: number;
  telematics_provider: string | null;
  telematics_device_id: string | null;
  last_latitude: number | null;
  last_longitude: number | null;
  last_speed_mph: number | null;
  last_ignition_on: boolean | null;
  last_seen_at: string | null;
}

export interface FleetProfile {
  id: string;
  profile_key: string;
  scope: FleetProfileScope;
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
  cost_per_mile_cents: number | null;
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
  confidence: FleetConfidence;
  computed_at: string;
}

export interface FleetTrip {
  id: string;
  job_id: string;
  vehicle_id: string;
  technician_id: string | null;
  service_type: string | null;
  departed_at: string | null;
  arrived_at: string | null;
  work_started_at: string | null;
  work_completed_at: string | null;
  arrival_verified: boolean;
  drive_minutes: number | null;
  idle_minutes: number | null;
  on_site_minutes: number | null;
  arrival_delay_minutes: number | null;
  distance_miles: number | null;
  distance_source: 'odometer' | 'gps_path' | 'estimated' | 'manual' | 'none';
  avg_speed_mph: number | null;
  harsh_event_count: number;
  vehicle_cost_cents: number;
  fully_loaded_cost_cents: number;
  revenue_cents: number;
  contribution_cents: number;
  margin_pct: number | null;
  confidence: FleetConfidence;
  computed_at: string;
  jobs: { customer_name: string } | null;
}

export interface FleetSafetyEvent {
  id: string;
  vehicle_id: string;
  technician_id: string | null;
  event_type: string;
  severity: number;
  value: number | null;
  unit: string | null;
  occurred_at: string;
}

export interface FleetDiagnostic {
  id: string;
  vehicle_id: string;
  code: string;
  description: string | null;
  severity: 'info' | 'warning' | 'critical';
  first_seen_at: string;
  last_seen_at: string;
}

export interface TelematicsConnection {
  id: string;
  provider: TelematicsProvider;
  label: string;
  token_hint: string;
  status: 'active' | 'paused';
  last_event_at: string | null;
  created_at: string;
}

export interface FleetPerson {
  id: string;
  member_name: string | null;
  member_email: string;
}

export interface FleetOverview {
  vehicles: FleetVehicle[];
  profiles: FleetProfile[];
  trips: FleetTrip[];
  safetyEvents: FleetSafetyEvent[];
  diagnostics: FleetDiagnostic[];
  connections: TelematicsConnection[];
  technicians: FleetPerson[];
  territories: { id: string; name: string }[];
}

// ============================================================
// CONSTANTS
// ============================================================

/** A truck counts as "live" if it reported within this many minutes. */
export const VEHICLE_LIVE_MINUTES = 10;
/** Minimum trips before a profile is allowed to influence a dispatch ranking. */
export const MIN_DISPATCH_SAMPLE = 3;
/** A technician above this share of paid time behind the wheel is a routing problem. */
export const HIGH_WINDSHIELD_SHARE_PCT = 40;
export const HIGH_HARSH_PER_100MI = 2;

export const PROVIDER_LABELS: Record<TelematicsProvider, string> = {
  vireek_mobile: 'Vireek mobile app',
  samsara: 'Samsara',
  geotab: 'Geotab',
  verizon_connect: 'Verizon Connect',
  motive: 'Motive',
  other: 'Other / custom',
};

export const EVENT_LABELS: Record<string, string> = {
  harsh_braking: 'Harsh braking',
  harsh_acceleration: 'Harsh acceleration',
  harsh_cornering: 'Harsh cornering',
  speeding: 'Speeding',
  excessive_idle: 'Excessive idle',
  geofence_enter: 'Geofence enter',
  geofence_exit: 'Geofence exit',
  dashcam_clip: 'Dashcam clip',
  collision: 'Collision',
};

// ============================================================
// FORMATTING + SMALL PURE HELPERS
// ============================================================

export { formatCents };

export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  const total = Math.round(minutes);
  if (total < 60) return `${total}m`;
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

export function formatPct(value: number | null | undefined, digits = 0): string {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}%`;
}

export function minutesSince(iso: string | null, nowMs = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (nowMs - t) / 60000) : null;
}

export function isVehicleLive(v: Pick<FleetVehicle, 'last_seen_at'>, nowMs = Date.now()): boolean {
  const age = minutesSince(v.last_seen_at, nowMs);
  return age != null && age <= VEHICLE_LIVE_MINUTES;
}

export function formatAge(minutes: number | null): string {
  if (minutes == null) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function normalizeProfile(r: Record<string, unknown>): FleetProfile {
  const p = r as unknown as FleetProfile;
  return {
    ...p,
    sample_size: Number(p.sample_size) || 0,
    avg_drive_minutes: num(p.avg_drive_minutes),
    avg_on_site_minutes: num(p.avg_on_site_minutes),
    avg_distance_miles: num(p.avg_distance_miles),
    avg_speed_mph: num(p.avg_speed_mph),
    windshield_share_pct: num(p.windshield_share_pct),
    idle_share_pct: num(p.idle_share_pct),
    cost_per_mile_cents: num(p.cost_per_mile_cents),
    variable_cost_per_mile_cents: num(p.variable_cost_per_mile_cents),
    avg_idle_cost_cents: num(p.avg_idle_cost_cents),
    avg_vehicle_cost_cents: num(p.avg_vehicle_cost_cents),
    avg_fully_loaded_cost_cents: num(p.avg_fully_loaded_cost_cents),
    avg_revenue_cents: num(p.avg_revenue_cents),
    avg_contribution_cents: num(p.avg_contribution_cents),
    avg_margin_pct: num(p.avg_margin_pct),
    on_time_pct: num(p.on_time_pct),
    harsh_per_100mi: num(p.harsh_per_100mi),
    total_vehicle_cost_cents: Number(p.total_vehicle_cost_cents) || 0,
    total_contribution_cents: Number(p.total_contribution_cents) || 0,
  };
}

function normalizeVehicle(r: Record<string, unknown>): FleetVehicle {
  const v = r as unknown as FleetVehicle;
  return {
    ...v,
    rated_mpg: num(v.rated_mpg),
    odometer_miles: Number(v.odometer_miles) || 0,
    last_latitude: num(v.last_latitude),
    last_longitude: num(v.last_longitude),
    last_speed_mph: num(v.last_speed_mph),
  };
}

function weightedAverage(items: { value: number | null; weight: number }[]): number | null {
  let sum = 0;
  let weight = 0;
  for (const i of items) {
    if (i.value == null) continue;
    sum += i.value * i.weight;
    weight += i.weight;
  }
  return weight > 0 ? sum / weight : null;
}

export interface FleetSummary {
  trips: number;
  vehicleCostCents: number;
  contributionCents: number;
  avgDriveMinutes: number | null;
  avgOnSiteMinutes: number | null;
  windshieldSharePct: number | null;
  idleSharePct: number | null;
  onTimePct: number | null;
  harshPer100Mi: number | null;
  avgMarginPct: number | null;
}

/** Account-level KPIs from the per-technician profiles (every trip belongs to exactly one). */
export function summarizeFleet(profiles: FleetProfile[]): FleetSummary {
  const techs = profiles.filter((p) => p.scope === 'technician');
  const w = (pick: (p: FleetProfile) => number | null) =>
    weightedAverage(techs.map((p) => ({ value: pick(p), weight: p.sample_size })));
  return {
    trips: techs.reduce((s, p) => s + p.sample_size, 0),
    vehicleCostCents: techs.reduce((s, p) => s + p.total_vehicle_cost_cents, 0),
    contributionCents: techs.reduce((s, p) => s + p.total_contribution_cents, 0),
    avgDriveMinutes: w((p) => p.avg_drive_minutes),
    avgOnSiteMinutes: w((p) => p.avg_on_site_minutes),
    windshieldSharePct: w((p) => p.windshield_share_pct),
    idleSharePct: w((p) => p.idle_share_pct),
    onTimePct: w((p) => p.on_time_pct),
    harshPer100Mi: w((p) => p.harsh_per_100mi),
    avgMarginPct: w((p) => p.avg_margin_pct),
  };
}

// ============================================================
// INSIGHTS (rule-based, explainable)
// ============================================================

export interface FleetInsight {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;
const MIN_INSIGHT_SAMPLE = 5;

export function buildFleetInsights(
  profiles: FleetProfile[],
  names: { technician: (id: string | null) => string; vehicle: (id: string | null) => string },
): FleetInsight[] {
  const out: FleetInsight[] = [];

  for (const p of profiles.filter((x) => x.scope === 'technician' && x.sample_size >= MIN_INSIGHT_SAMPLE)) {
    const who = names.technician(p.technician_id);
    if (p.windshield_share_pct != null && p.windshield_share_pct >= HIGH_WINDSHIELD_SHARE_PCT) {
      out.push({
        id: `wind:${p.profile_key}`, severity: 'warning',
        title: `${who} spends ${Math.round(p.windshield_share_pct)}% of job time driving`,
        detail: `${formatMinutes(p.avg_drive_minutes)} driving vs ${formatMinutes(p.avg_on_site_minutes)} on site per job. Tighter zones or batching nearby jobs would recover paid hours.`,
      });
    }
    if (p.idle_share_pct != null && p.idle_share_pct >= 15) {
      out.push({
        id: `idle:${p.profile_key}`, severity: 'warning',
        title: `${who}'s truck idles ${Math.round(p.idle_share_pct)}% of drive time`,
        detail: 'Engine on, wheels not turning. It burns fuel and hides delays (traffic, calls, waiting).',
      });
    }
    if (p.on_time_pct != null && p.on_time_pct < 80) {
      out.push({
        id: `ontime:${p.profile_key}`, severity: 'warning',
        title: `${who} arrives on time only ${Math.round(p.on_time_pct)}% of the time`,
        detail: 'Arrival is measured from truck GPS against the scheduled window (10 min grace).',
      });
    }
    if (p.harsh_per_100mi != null && p.harsh_per_100mi >= HIGH_HARSH_PER_100MI) {
      out.push({
        id: `harsh:${p.profile_key}`, severity: 'critical',
        title: `${who}: ${p.harsh_per_100mi.toFixed(1)} harsh driving events per 100 miles`,
        detail: 'Harsh braking, acceleration and extreme speed raise accident, insurance and wear cost. Coach this driver.',
      });
    }
  }

  for (const p of profiles.filter((x) => x.scope === 'combo' && x.sample_size >= MIN_INSIGHT_SAMPLE && x.avg_margin_pct != null && x.avg_margin_pct < 0)) {
    out.push({
      id: `loss:${p.profile_key}`, severity: 'critical',
      title: `${p.service_type ?? 'Jobs'} by ${names.technician(p.technician_id)} in ${names.vehicle(p.vehicle_id)} lose money`,
      detail: `Average margin ${(p.avg_margin_pct as number).toFixed(1)}% across ${p.sample_size} jobs after drive time, vehicle cost and labor. Reprice, reroute or reassign.`,
    });
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]).slice(0, 8);
}

// ============================================================
// DISPATCH SIGNALS (pure)
// ============================================================

/**
 * Builds the per-technician signal Dispatch Profitability consumes. A
 * technician with fewer than MIN_DISPATCH_SAMPLE scored trips gets no signal
 * at all, so thin data can never move a ranking.
 */
export function buildFleetDispatchSignals(
  profiles: FleetProfile[],
  vehicles: FleetVehicle[],
  nowMs = Date.now(),
): Record<string, FleetDispatchSignal> {
  const out: Record<string, FleetDispatchSignal> = {};

  for (const tech of profiles.filter((p) => p.scope === 'technician' && p.technician_id && p.sample_size >= MIN_DISPATCH_SAMPLE)) {
    const technicianId = tech.technician_id as string;
    const vehicle = vehicles.find((v) => v.assigned_technician_id === technicianId && v.status === 'active') ?? null;
    const vehicleProfile = vehicle
      ? profiles.find((p) => p.scope === 'vehicle' && p.vehicle_id === vehicle.id && p.sample_size >= MIN_DISPATCH_SAMPLE)
      : undefined;

    const onSiteMinutesByService: Record<string, number> = {};
    for (const p of profiles) {
      if (p.scope === 'technician_service' && p.technician_id === technicianId && p.service_type && p.sample_size >= MIN_DISPATCH_SAMPLE && p.avg_on_site_minutes != null) {
        onSiteMinutesByService[p.service_type] = p.avg_on_site_minutes;
      }
    }

    const age = vehicle ? minutesSince(vehicle.last_seen_at, nowMs) : null;
    const vehicleLocation =
      vehicle && vehicle.last_latitude != null && vehicle.last_longitude != null && age != null
        ? { lat: vehicle.last_latitude, lng: vehicle.last_longitude, ageMinutes: age }
        : null;

    out[technicianId] = {
      technicianId,
      vehicleLocation,
      avgSpeedMph: tech.avg_speed_mph,
      costPerMileCents: vehicleProfile?.variable_cost_per_mile_cents ?? tech.variable_cost_per_mile_cents,
      idleCostPerTripCents: tech.avg_idle_cost_cents,
      onSiteMinutesByService,
      onTimePct: tech.on_time_pct,
      sampleSize: tech.sample_size,
      confidence: tech.confidence,
    };
  }
  return out;
}

// ============================================================
// QUERIES
// ============================================================

const VEHICLE_COLUMNS =
  'id, label, make, model, status, assigned_technician_id, fuel_type, rated_mpg, odometer_miles, telematics_provider, telematics_device_id, last_latitude, last_longitude, last_speed_mph, last_ignition_on, last_seen_at';

export async function fetchFleetOverview(): Promise<FleetOverview> {
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [vehicles, profiles, trips, events, diagnostics, connections, technicians, territories] = await Promise.all([
    supabase.from('vehicles').select(VEHICLE_COLUMNS).neq('status', 'retired').order('label'),
    supabase.from('fleet_intelligence_profiles').select('*').order('sample_size', { ascending: false }).limit(1000),
    supabase
      .from('fleet_trip_intelligence')
      .select('id, job_id, vehicle_id, technician_id, service_type, departed_at, arrived_at, work_started_at, work_completed_at, arrival_verified, drive_minutes, idle_minutes, on_site_minutes, arrival_delay_minutes, distance_miles, distance_source, avg_speed_mph, harsh_event_count, vehicle_cost_cents, fully_loaded_cost_cents, revenue_cents, contribution_cents, margin_pct, confidence, computed_at, jobs:job_id (customer_name)')
      .order('work_completed_at', { ascending: false, nullsFirst: false })
      .limit(60),
    supabase
      .from('vehicle_safety_events')
      .select('id, vehicle_id, technician_id, event_type, severity, value, unit, occurred_at')
      .gte('occurred_at', since30)
      .not('event_type', 'in', '(geofence_enter,geofence_exit)')
      .order('occurred_at', { ascending: false })
      .limit(100),
    supabase.from('vehicle_diagnostics').select('id, vehicle_id, code, description, severity, first_seen_at, last_seen_at').eq('status', 'active').order('first_seen_at', { ascending: false }).limit(100),
    supabase.from('telematics_connections').select('id, provider, label, token_hint, status, last_event_at, created_at').order('created_at', { ascending: false }),
    supabase.from('team_members').select('id, member_name, member_email').eq('role', 'technician'),
    supabase.from('territories').select('id, name'),
  ]);

  const firstError = [vehicles, profiles, trips, events, diagnostics, connections, technicians].find((r) => r.error)?.error;
  if (firstError) throw new Error(firstError.message);

  return {
    vehicles: ((vehicles.data ?? []) as Record<string, unknown>[]).map(normalizeVehicle),
    profiles: ((profiles.data ?? []) as Record<string, unknown>[]).map(normalizeProfile),
    trips: (trips.data ?? []) as unknown as FleetTrip[],
    safetyEvents: (events.data ?? []) as FleetSafetyEvent[],
    diagnostics: (diagnostics.data ?? []) as FleetDiagnostic[],
    connections: (connections.data ?? []) as TelematicsConnection[],
    technicians: (technicians.data ?? []) as FleetPerson[],
    territories: (territories.data ?? []) as { id: string; name: string }[],
  };
}

/** Never throws: Dispatch must keep working when fleet data is missing or the tables are not migrated yet. */
export async function fetchFleetDispatchSignals(): Promise<Record<string, FleetDispatchSignal>> {
  try {
    const [profiles, vehicles] = await Promise.all([
      supabase
        .from('fleet_intelligence_profiles')
        .select('*')
        .in('scope', ['technician', 'technician_service', 'vehicle'])
        .gte('sample_size', MIN_DISPATCH_SAMPLE),
      supabase.from('vehicles').select(VEHICLE_COLUMNS).eq('status', 'active'),
    ]);
    if (profiles.error || vehicles.error) return {};
    return buildFleetDispatchSignals(
      ((profiles.data ?? []) as Record<string, unknown>[]).map(normalizeProfile),
      ((vehicles.data ?? []) as Record<string, unknown>[]).map(normalizeVehicle),
    );
  } catch {
    return {};
  }
}

export interface FleetJobCost {
  vehicle_cost_cents: number;
  fuel_cost_cents: number;
  wear_cost_cents: number;
  idle_cost_cents: number;
  fixed_cost_cents: number;
  drive_labor_cost_cents: number;
  on_site_labor_cost_cents: number;
  fully_loaded_cost_cents: number;
  revenue_cents: number;
  contribution_cents: number;
  margin_pct: number | null;
  drive_minutes: number | null;
  distance_miles: number | null;
  confidence: FleetConfidence;
}

/** Fleet-attributed cost of one job (for the Profitability page). Null when the job has no scored trip. */
export async function fetchFleetJobCost(jobId: string): Promise<FleetJobCost | null> {
  const { data, error } = await supabase
    .from('fleet_trip_intelligence')
    .select('vehicle_cost_cents, fuel_cost_cents, wear_cost_cents, idle_cost_cents, fixed_cost_cents, drive_labor_cost_cents, on_site_labor_cost_cents, fully_loaded_cost_cents, revenue_cents, contribution_cents, margin_pct, drive_minutes, distance_miles, confidence')
    .eq('job_id', jobId)
    .maybeSingle();
  if (error || !data) return null;
  const d = data as Record<string, unknown>;
  return {
    vehicle_cost_cents: Number(d.vehicle_cost_cents) || 0,
    fuel_cost_cents: Number(d.fuel_cost_cents) || 0,
    wear_cost_cents: Number(d.wear_cost_cents) || 0,
    idle_cost_cents: Number(d.idle_cost_cents) || 0,
    fixed_cost_cents: Number(d.fixed_cost_cents) || 0,
    drive_labor_cost_cents: Number(d.drive_labor_cost_cents) || 0,
    on_site_labor_cost_cents: Number(d.on_site_labor_cost_cents) || 0,
    fully_loaded_cost_cents: Number(d.fully_loaded_cost_cents) || 0,
    revenue_cents: Number(d.revenue_cents) || 0,
    contribution_cents: Number(d.contribution_cents) || 0,
    margin_pct: num(d.margin_pct),
    drive_minutes: num(d.drive_minutes),
    distance_miles: num(d.distance_miles),
    confidence: d.confidence as FleetConfidence,
  };
}

export async function refreshFleetIntelligence(days = 30): Promise<{ trips_scored: number; trips_linked: number; vehicles_scanned: number }> {
  const { data, error } = await supabase.functions.invoke('compute-fleet-intelligence', { body: { days } });
  if (error || data?.error) throw new Error(data?.error || 'Could not refresh fleet intelligence.');
  return {
    trips_scored: Number(data?.trips_scored) || 0,
    trips_linked: Number(data?.trips_linked) || 0,
    vehicles_scanned: Number(data?.vehicles_scanned) || 0,
  };
}

// ============================================================
// TELEMATICS CONNECTIONS (ingest tokens)
// ============================================================

export function fleetIngestUrl(): string {
  const base = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
  return `${base.replace(/\/$/, '')}/functions/v1/fleet-telemetry-ingest`;
}

export function generateIngestToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `flt_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Creates a connection and returns the raw token ONCE — only its hash is stored. */
export async function createTelematicsConnection(input: {
  ownerId: string;
  provider: TelematicsProvider;
  label: string;
}): Promise<{ connection: TelematicsConnection; token: string }> {
  const token = generateIngestToken();
  const { data, error } = await supabase
    .from('telematics_connections')
    .insert({
      user_id: input.ownerId,
      provider: input.provider,
      label: input.label.trim() || PROVIDER_LABELS[input.provider],
      token_hash: await sha256Hex(token),
      token_hint: token.slice(-4),
    })
    .select('id, provider, label, token_hint, status, last_event_at, created_at')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Could not create the connection.');
  return { connection: data as TelematicsConnection, token };
}

export async function setConnectionStatus(id: string, status: 'active' | 'paused'): Promise<void> {
  const { error } = await supabase.from('telematics_connections').update({ status }).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteConnection(id: string): Promise<void> {
  const { error } = await supabase.from('telematics_connections').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function updateVehicleTelematics(
  vehicleId: string,
  patch: Partial<Pick<FleetVehicle, 'assigned_technician_id' | 'telematics_provider' | 'telematics_device_id' | 'fuel_type' | 'rated_mpg'>>,
): Promise<void> {
  const { error } = await supabase.from('vehicles').update(patch).eq('id', vehicleId);
  if (error) throw new Error(error.message);
}
