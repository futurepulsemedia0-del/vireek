import { supabase } from '@/lib/supabase';
import {
  clampRadius,
  groupTrails,
  isOpenJob,
  TRAIL_WINDOW_MIN,
  type LiveRow,
  type MapJob,
  type MapTech,
  type MapVehicle,
  type PositionLogRow,
  type TrailPoint,
} from '@/lib/liveMap';

export interface LiveMapSnapshot {
  vehicles: MapVehicle[];
  live: Map<string, LiveRow>;
  techs: MapTech[];
  jobs: MapJob[];
  trails: Map<string, TrailPoint[]>;
  geofenceM: number;
  /** Non-fatal problems (e.g. trails failed to load) so the UI can say so instead of silently degrading. */
  warnings: string[];
}

const LIVE_COLUMNS =
  'vehicle_id, latitude, longitude, speed_mph, heading_deg, engine_state, fuel_pct, check_engine, last_fix_at, stationary_since, reverse_geo, current_job_id';
const JOB_COLUMNS =
  'id, customer_name, service_type, address, scheduled_datetime, job_status, assigned_technician_id, latitude, longitude';

export async function loadLiveMap(ownerId: string): Promise<LiveMapSnapshot> {
  const now = Date.now();
  const dayMs = 86_400_000;
  const from = new Date(now - dayMs).toISOString();
  const to = new Date(now + 1.5 * dayMs).toISOString();
  const since = new Date(now - TRAIL_WINDOW_MIN * 60_000).toISOString();

  const [vehiclesRes, liveRes, techsRes, jobsRes, connRes, trailRes] = await Promise.all([
    supabase.from('vehicles').select('id, label, status, assigned_technician_id').eq('user_id', ownerId).neq('status', 'retired').order('label'),
    supabase.from('vehicle_live_state').select(LIVE_COLUMNS).eq('user_id', ownerId),
    supabase.from('team_members').select('id, member_name, member_email').eq('account_owner_id', ownerId),
    supabase
      .from('jobs')
      .select(JOB_COLUMNS)
      .eq('user_id', ownerId)
      .in('job_status', ['scheduled', 'en_route', 'in_progress'])
      .or(`job_status.in.(en_route,in_progress),and(scheduled_datetime.gte.${from},scheduled_datetime.lte.${to})`)
      .limit(500),
    supabase.from('telematics_connections').select('settings, status').eq('user_id', ownerId).neq('status', 'disconnected'),
    supabase
      .from('vehicle_position_log')
      .select('vehicle_id, recorded_at, latitude, longitude')
      .eq('user_id', ownerId)
      .gte('recorded_at', since)
      .order('recorded_at', { ascending: false })
      .limit(4000),
  ]);

  // Core data: without these the map is meaningless, so fail loudly.
  if (vehiclesRes.error) throw new Error(vehiclesRes.error.message);
  if (liveRes.error) throw new Error(liveRes.error.message);
  if (jobsRes.error) throw new Error(jobsRes.error.message);

  const warnings: string[] = [];
  if (techsRes.error) warnings.push('Technician names could not be loaded.');
  if (connRes.error) warnings.push('Geofence settings could not be loaded; using the 150 m default.');
  if (trailRes.error) warnings.push('Recent route trails could not be loaded.');

  const live = new Map<string, LiveRow>();
  for (const row of (liveRes.data ?? []) as LiveRow[]) live.set(row.vehicle_id, row);

  const settings = ((connRes.data ?? []) as Array<{ settings: { geofence_radius_m?: number } | null; status: string }>)
    .filter((c) => c.status === 'connected')
    .map((c) => c.settings?.geofence_radius_m)
    .find((r) => r !== undefined && r !== null);

  const jobs = ((jobsRes.data ?? []) as Array<Omit<MapJob, 'job_status'> & { job_status: string }>)
    .filter((j) => isOpenJob(j.job_status))
    .map((j) => ({ ...j, job_status: j.job_status as MapJob['job_status'] }));

  return {
    vehicles: (vehiclesRes.data ?? []) as MapVehicle[],
    live,
    techs: (techsRes.data ?? []) as MapTech[],
    jobs,
    trails: groupTrails((trailRes.data ?? []) as PositionLogRow[]),
    geofenceM: clampRadius(settings),
    warnings,
  };
}
