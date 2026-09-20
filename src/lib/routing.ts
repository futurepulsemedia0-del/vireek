/**
 * Advanced Routing — client library.
 *
 * Geocoding and route optimization call external services (Nominatim,
 * OSRM, optionally Google) and so live server-side in the
 * `geocode-address` and `optimize-route` edge functions — this module is
 * the thin client wrapper around them, plus everything that's pure
 * client-side aggregation on data already fetched: territory balance and
 * technician proximity sort. Same split as every other feature in this
 * app (compare `lib/coachingReports.ts` vs. the `calls` table it reads).
 */

import { supabase, Job, TeamMember, Territory } from '@/lib/supabase';

// ============================================================
// HAVERSINE — mirrors haversine_miles() in the migration and the
// edge functions. Keep all three in sync if this changes.
// ============================================================

export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ============================================================
// GEOCODING
// ============================================================

export interface GeocodeTarget {
  type: 'job' | 'technician_home' | 'scratch';
  id: string;
  address: string;
}

export interface GeocodeResult {
  id: string;
  type: GeocodeTarget['type'];
  status: 'geocoded' | 'not_found' | 'error';
  latitude?: number;
  longitude?: number;
}

/** Geocodes up to 25 targets per call — the edge function enforces this to stay under Nominatim's rate limit. Call repeatedly for larger batches. */
export async function geocodeTargets(targets: GeocodeTarget[]): Promise<{ geocoded: number; total: number; results: GeocodeResult[] }> {
  const { data, error } = await supabase.functions.invoke('geocode-address', { body: { targets } });
  if (error) throw error;
  return data as { geocoded: number; total: number; results: GeocodeResult[] };
}

export function jobsNeedingGeocode(jobs: Job[]): GeocodeTarget[] {
  return jobs
    .filter((j) => j.address && (j.latitude === null || j.latitude === undefined))
    .map((j) => ({ type: 'job' as const, id: j.id, address: j.address as string }));
}

export function techniciansNeedingGeocode(technicians: TeamMember[]): GeocodeTarget[] {
  return technicians
    .filter((t) => t.home_address && (t.home_latitude === null || t.home_latitude === undefined))
    .map((t) => ({ type: 'technician_home' as const, id: t.id, address: t.home_address as string }));
}

// ============================================================
// ROUTE OPTIMIZATION
// ============================================================

export interface OptimizedStop {
  jobId: string;
  order: number;
  address: string;
  etaArrival: string;
  travelMinutesFromPrev: number;
  distanceMilesFromPrev: number;
}

export interface OptimizedRoute {
  technicianId: string;
  technicianName: string | null;
  date: string;
  etaSource: 'google_traffic' | 'osrm_road_network' | 'estimated' | 'n/a';
  stops: OptimizedStop[];
  unrouted: string[];
  totalDistanceMiles: number;
  totalDriveMinutes: number;
}

/** Recompute-on-demand is the "dynamic rerouting" story: call this again any time a job is added, cancelled, or the day changes — nothing is cached that would need separate invalidation. */
export async function optimizeRoute(technicianId: string, date: string): Promise<OptimizedRoute> {
  const { data, error } = await supabase.functions.invoke('optimize-route', { body: { technicianId, date } });
  if (error) throw error;
  return data as OptimizedRoute;
}

// ============================================================
// TECHNICIAN PROXIMITY / EMERGENCY DISPATCH
// ============================================================

export interface NearestTechnician {
  technician_id: string;
  technician_name: string | null;
  distance_miles: number;
  today_load: number;
  max_jobs_per_day: number;
  has_skill: boolean;
}

/** Ranks available technicians by straight-line distance to a point — what an emergency dispatcher needs ("who's closest right now"), not the fuller skill/capacity score `assign_technician_to_job` uses for routine assignment. */
export async function findNearestTechnicians(
  latitude: number,
  longitude: number,
  serviceType?: string,
  limit = 5,
): Promise<NearestTechnician[]> {
  const { data, error } = await supabase.rpc('find_nearest_technicians', {
    p_latitude: latitude,
    p_longitude: longitude,
    p_service_type: serviceType ?? null,
    p_limit: limit,
  });
  if (error) throw error;
  return (data as NearestTechnician[]) ?? [];
}

/** Updates a technician's live position — call from a technician's own device/session. Distinct from `home_latitude`, which is their fixed base and only changes when their home address does. */
export async function reportTechnicianLocation(technicianId: string, latitude: number, longitude: number): Promise<void> {
  const { error } = await supabase
    .from('team_members')
    .update({ current_latitude: latitude, current_longitude: longitude, location_updated_at: new Date().toISOString() })
    .eq('id', technicianId);
  if (error) throw error;
}

// ============================================================
// TERRITORIES
// ============================================================

export async function fetchTerritories(): Promise<Territory[]> {
  const { data, error } = await supabase.from('territories').select('*').order('name');
  if (error) throw error;
  return (data as Territory[]) ?? [];
}

export async function saveTerritory(input: {
  id?: string;
  name: string;
  color: string;
  centerLatitude: number;
  centerLongitude: number;
  radiusMiles: number;
}): Promise<Territory> {
  const payload = {
    name: input.name,
    color: input.color,
    center_latitude: input.centerLatitude,
    center_longitude: input.centerLongitude,
    radius_miles: input.radiusMiles,
  };
  const query = input.id
    ? supabase.from('territories').update(payload).eq('id', input.id).select().single()
    : supabase.from('territories').insert(payload).select().single();
  const { data, error } = await query;
  if (error) throw error;
  return data as Territory;
}

export async function deleteTerritory(id: string): Promise<void> {
  const { error } = await supabase.from('territories').delete().eq('id', id);
  if (error) throw error;
}

export async function assignTechnicianTerritory(technicianId: string, territoryId: string | null): Promise<void> {
  const { error } = await supabase.from('team_members').update({ territory_id: territoryId }).eq('id', technicianId);
  if (error) throw error;
}

// ============================================================
// TERRITORY BALANCE (pure — no network)
// ============================================================

export interface TerritoryBalance {
  territoryId: string;
  territoryName: string;
  color: string;
  technicianCount: number;
  openJobCount: number;
  jobsPerTechnician: number | null;
}

/** Flags imbalance by open-jobs-per-technician within each territory — a territory with 3x the load-per-tech of another is the actionable signal, not raw job counts (which just reflect territory size). */
export function computeTerritoryBalance(
  territories: Territory[],
  technicians: TeamMember[],
  openJobs: Job[],
): TerritoryBalance[] {
  return territories.map((territory) => {
    const techsInTerritory = technicians.filter((t) => t.territory_id === territory.id);
    const techIds = new Set(techsInTerritory.map((t) => t.id));
    const jobCount = openJobs.filter((j) => j.assigned_technician_id && techIds.has(j.assigned_technician_id)).length;
    return {
      territoryId: territory.id,
      territoryName: territory.name,
      color: territory.color,
      technicianCount: techsInTerritory.length,
      openJobCount: jobCount,
      jobsPerTechnician: techsInTerritory.length > 0 ? Math.round((jobCount / techsInTerritory.length) * 10) / 10 : null,
    };
  });
}

// ============================================================
// TECHNICIAN PROXIMITY SORT (pure — no network)
// ============================================================

export interface TechnicianDistance {
  technician: TeamMember;
  distanceMiles: number | null;
  source: 'live' | 'home' | 'unknown';
}

export function sortTechniciansByProximity(technicians: TeamMember[], latitude: number, longitude: number): TechnicianDistance[] {
  return technicians
    .map((tech) => {
      const hasLive = tech.current_latitude !== null && tech.current_latitude !== undefined;
      const lat = hasLive ? tech.current_latitude : tech.home_latitude;
      const lon = hasLive ? tech.current_longitude : tech.home_longitude;
      const source: TechnicianDistance['source'] = hasLive ? 'live' : lat !== null && lat !== undefined ? 'home' : 'unknown';
      return {
        technician: tech,
        distanceMiles: lat !== null && lat !== undefined && lon !== null && lon !== undefined
          ? Math.round(haversineMiles(lat, lon, latitude, longitude) * 10) / 10
          : null,
        source,
      };
    })
    .sort((a, b) => (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity));
}
