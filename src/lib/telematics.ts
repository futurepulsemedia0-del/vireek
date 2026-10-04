import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// Types mirror supabase/migrations/20270215000000_real_telematics_os.sql
// ---------------------------------------------------------------------------

export type TelematicsProvider = 'samsara' | 'geotab' | 'webhook';
export type ConnectionStatus = 'pending' | 'connected' | 'error' | 'disconnected';

export interface TelematicsSettings {
  geofence_radius_m: number;
  dwell_arrival_seconds: number;
  departure_buffer_m: number;
  idle_threshold_seconds: number;
  auto_advance_job_status: boolean;
}

export interface TelematicsConnection {
  id: string;
  provider: TelematicsProvider;
  label: string;
  status: ConnectionStatus;
  last_sync_at: string | null;
  last_error: string | null;
  settings: TelematicsSettings;
}

export interface LiveVehicle {
  vehicle_id: string;
  latitude: number | null;
  longitude: number | null;
  speed_mph: number | null;
  engine_state: 'on' | 'off' | 'idle' | 'unknown';
  odometer_miles: number | null;
  fuel_pct: number | null;
  check_engine: boolean;
  last_fix_at: string | null;
  stationary_since: string | null;
  reverse_geo: string | null;
  current_job_id: string | null;
}

export interface FleetVehicle {
  id: string;
  label: string;
  status: 'active' | 'in_shop' | 'retired';
  odometer_miles: number;
  assigned_technician_id: string | null;
  telematics_external_id: string | null;
}

export interface SafetyDay {
  vehicle_id: string;
  technician_id: string | null;
  day: string;
  miles: number;
  harsh_brake: number;
  harsh_accel: number;
  harsh_turn: number;
  speeding_events: number;
  other_events: number;
  idle_minutes: number;
  score: number;
}

export interface TelematicsEvent {
  id: string;
  vehicle_id: string;
  job_id: string | null;
  event_type: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  occurred_at: string;
  speed_mph: number | null;
  speed_limit_mph: number | null;
  media_url: string | null;
}

export interface VehicleFault {
  id: string;
  vehicle_id: string;
  code: string;
  description: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
  check_engine: boolean;
  last_seen_at: string;
}

export interface MaintenanceSchedule {
  id: string;
  vehicle_id: string;
  name: string;
  interval_miles: number | null;
  interval_days: number | null;
  last_service_miles: number | null;
  last_service_date: string | null;
  active: boolean;
}

export interface JobTruthRow {
  job_id: string;
  vehicle_id: string | null;
  drive_miles: number;
  drive_minutes: number;
  idle_minutes: number;
  onsite_minutes: number | null;
  minutes_late: number | null;
  harsh_events: number;
  speeding_events: number;
  travel_cost: number;
  revenue: number;
  value_per_onsite_hour: number | null;
  customer_rating: number | null;
  integrity_score: number;
  flags: string[];
  computed_at: string;
  jobs: { customer_name: string; service_type: string | null } | null;
}

export interface JobVisit {
  arrived_at: string;
  departed_at: string | null;
  onsite_seconds: number | null;
  minutes_late: number | null;
  arrival_distance_m: number | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (kept free of I/O so they are unit-testable)
// ---------------------------------------------------------------------------

/** A vehicle with no fix for this long is considered offline. */
export const OFFLINE_AFTER_MIN = 15;

export type LiveStatus = 'moving' | 'idling' | 'stopped' | 'offline';

export function liveStatus(v: Pick<LiveVehicle, 'speed_mph' | 'engine_state' | 'last_fix_at'> | undefined, now = Date.now()): LiveStatus {
  if (!v?.last_fix_at) return 'offline';
  const age = (now - Date.parse(v.last_fix_at)) / 60_000;
  if (Number.isNaN(age) || age > OFFLINE_AFTER_MIN) return 'offline';
  if ((v.speed_mph ?? 0) >= 3) return 'moving';
  if (v.engine_state === 'on' || v.engine_state === 'idle') return 'idling';
  return 'stopped';
}

export function ageLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
}

export function safetyTier(score: number): 'excellent' | 'good' | 'watch' | 'at_risk' {
  return score >= 90 ? 'excellent' : score >= 75 ? 'good' : score >= 60 ? 'watch' : 'at_risk';
}

export interface MaintenanceStatus {
  status: 'ok' | 'due_soon' | 'overdue';
  milesRemaining: number | null;
  daysRemaining: number | null;
}

export function maintenanceStatus(s: MaintenanceSchedule, odometer: number | null, now = Date.now()): MaintenanceStatus {
  let milesRemaining: number | null = null;
  let daysRemaining: number | null = null;
  if (s.interval_miles && s.last_service_miles != null && odometer != null) {
    milesRemaining = Math.round(s.last_service_miles + s.interval_miles - odometer);
  }
  if (s.interval_days && s.last_service_date) {
    const due = Date.parse(`${s.last_service_date}T00:00:00Z`) + s.interval_days * 86_400_000;
    if (!Number.isNaN(due)) daysRemaining = Math.ceil((due - now) / 86_400_000);
  }
  const overdue = (milesRemaining != null && milesRemaining < 0) || (daysRemaining != null && daysRemaining < 0);
  const soonMiles = milesRemaining != null && !!s.interval_miles && milesRemaining <= Math.max(300, s.interval_miles * 0.1);
  const soonDays = daysRemaining != null && !!s.interval_days && daysRemaining <= Math.max(7, Math.round(s.interval_days * 0.1));
  return { status: overdue ? 'overdue' : soonMiles || soonDays ? 'due_soon' : 'ok', milesRemaining, daysRemaining };
}

export const FLAG_LABELS: Record<string, string> = {
  no_gps_arrival: 'No GPS arrival',
  late_arrival: 'Late arrival',
  very_late_arrival: 'Very late arrival',
  unsafe_driving: 'Unsafe driving',
  rework: 'Rework',
  disputed: 'Customer dispute',
  low_rating: 'Low rating',
  travel_heavy: 'Travel-heavy',
  short_visit_billed: 'Short visit, billed',
  excess_idle: 'Excess idling',
};

export const EVENT_LABELS: Record<string, string> = {
  harsh_brake: 'Harsh braking', harsh_accel: 'Harsh acceleration', harsh_turn: 'Harsh turn', speeding: 'Speeding',
  idling: 'Excess idling', collision: 'Collision', dtc_fault: 'Diagnostic fault', geofence_enter: 'Arrived on site',
  geofence_exit: 'Left site', ignition_on: 'Ignition on', ignition_off: 'Ignition off', dashcam_clip: 'Dashcam clip',
  distracted_driving: 'Distracted driving', seatbelt: 'Seatbelt', other: 'Other',
};

export function mapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

// ---------------------------------------------------------------------------
// Data access (RLS scopes everything to the account owner)
// ---------------------------------------------------------------------------

const SINCE_DAYS = 14;
const sinceIso = () => new Date(Date.now() - SINCE_DAYS * 86_400_000).toISOString();

export interface TelematicsSnapshot {
  connections: TelematicsConnection[];
  vehicles: FleetVehicle[];
  live: LiveVehicle[];
  safety: SafetyDay[];
  events: TelematicsEvent[];
  faults: VehicleFault[];
  schedules: MaintenanceSchedule[];
  truth: JobTruthRow[];
}

export async function loadTelematics(): Promise<TelematicsSnapshot> {
  const [c, v, l, s, e, f, m, t] = await Promise.all([
    supabase.from('telematics_connections').select('id, provider, label, status, last_sync_at, last_error, settings').neq('status', 'disconnected'),
    supabase.from('vehicles').select('id, label, status, odometer_miles, assigned_technician_id, telematics_external_id').neq('status', 'retired').order('label'),
    supabase.from('vehicle_live_state').select('vehicle_id, latitude, longitude, speed_mph, engine_state, odometer_miles, fuel_pct, check_engine, last_fix_at, stationary_since, reverse_geo, current_job_id'),
    supabase.from('driver_safety_daily').select('vehicle_id, technician_id, day, miles, harsh_brake, harsh_accel, harsh_turn, speeding_events, other_events, idle_minutes, score').gte('day', sinceIso().slice(0, 10)).order('day', { ascending: false }),
    supabase.from('telematics_events').select('id, vehicle_id, job_id, event_type, severity, occurred_at, speed_mph, speed_limit_mph, media_url').not('event_type', 'in', '(geofence_enter,geofence_exit,ignition_on,ignition_off)').gte('occurred_at', sinceIso()).order('occurred_at', { ascending: false }).limit(60),
    supabase.from('vehicle_faults').select('id, vehicle_id, code, description, severity, check_engine, last_seen_at').is('cleared_at', null).order('last_seen_at', { ascending: false }),
    supabase.from('vehicle_maintenance_schedules').select('id, vehicle_id, name, interval_miles, interval_days, last_service_miles, last_service_date, active').eq('active', true),
    supabase.from('job_operational_truth').select('job_id, vehicle_id, drive_miles, drive_minutes, idle_minutes, onsite_minutes, minutes_late, harsh_events, speeding_events, travel_cost, revenue, value_per_onsite_hour, customer_rating, integrity_score, flags, computed_at, jobs:job_id (customer_name, service_type)').order('integrity_score', { ascending: true }).limit(100),
  ]);
  return {
    connections: (c.data as TelematicsConnection[]) ?? [],
    vehicles: (v.data as FleetVehicle[]) ?? [],
    live: (l.data as LiveVehicle[]) ?? [],
    safety: (s.data as SafetyDay[]) ?? [],
    events: (e.data as TelematicsEvent[]) ?? [],
    faults: (f.data as VehicleFault[]) ?? [],
    schedules: (m.data as MaintenanceSchedule[]) ?? [],
    truth: (t.data as unknown as JobTruthRow[]) ?? [],
  };
}

export async function fetchJobVisit(jobId: string): Promise<{ visit: JobVisit | null; truth: Pick<JobTruthRow, 'integrity_score' | 'flags' | 'drive_miles' | 'harsh_events' | 'value_per_onsite_hour'> | null }> {
  const [v, t] = await Promise.all([
    supabase.from('telematics_job_visits').select('arrived_at, departed_at, onsite_seconds, minutes_late, arrival_distance_m').eq('job_id', jobId).order('arrived_at', { ascending: true }).limit(1).maybeSingle(),
    supabase.from('job_operational_truth').select('integrity_score, flags, drive_miles, harsh_events, value_per_onsite_hour').eq('job_id', jobId).maybeSingle(),
  ]);
  return { visit: (v.data as JobVisit | null) ?? null, truth: (t.data as never) ?? null };
}

/** Subscribe to live vehicle updates. Returns an unsubscribe function. */
export function subscribeLive(onChange: (row: LiveVehicle) => void): () => void {
  const channel = supabase
    .channel('vehicle-live-state')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'vehicle_live_state' }, (payload) => {
      if (payload.new && 'vehicle_id' in payload.new) onChange(payload.new as LiveVehicle);
    })
    .subscribe();
  return () => { void supabase.removeChannel(channel); };
}

// ---------------------------------------------------------------------------
// Edge function calls
// ---------------------------------------------------------------------------

export interface ConnectResult {
  ok?: boolean;
  error?: string;
  connection_id?: string;
  vehicles_found?: number;
  linked?: number;
  created?: number;
  ingest_url?: string;
  ingest_token?: string | null;
}

export async function telematicsConnect(action: string, payload: Record<string, unknown> = {}): Promise<ConnectResult> {
  const { data, error } = await supabase.functions.invoke('telematics-connect', { body: { action, ...payload } });
  if (error) {
    // supabase-js hides the JSON body on non-2xx; surface the server's message when present.
    const ctx = (error as { context?: Response }).context;
    const body = ctx ? await ctx.json().catch(() => null) : null;
    return { error: body?.error ?? 'Request failed. Please try again.' };
  }
  return (data as ConnectResult) ?? { error: 'Empty response.' };
}

export async function recomputeChain(days = 2): Promise<{ trips?: number; jobs_scored?: number; error?: string }> {
  const { data, error } = await supabase.functions.invoke('compute-telematics-chain', { body: { days } });
  if (error || data?.error) return { error: data?.error ?? 'Could not recompute.' };
  return data as { trips: number; jobs_scored: number };
}

export async function addMaintenanceSchedule(input: { vehicle_id: string; name: string; interval_miles: number | null; interval_days: number | null; last_service_miles: number | null; last_service_date: string | null }, userId: string) {
  return supabase.from('vehicle_maintenance_schedules').insert({ user_id: userId, ...input });
}

export async function markServiced(scheduleId: string, odometer: number | null) {
  return supabase.from('vehicle_maintenance_schedules').update({ last_service_miles: odometer, last_service_date: new Date().toISOString().slice(0, 10) }).eq('id', scheduleId);
}
