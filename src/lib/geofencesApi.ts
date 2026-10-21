import { supabase } from '@/lib/supabase';
import {
  draftToRow, rowToGeofence, validateDraft,
  type Geofence, type GeofenceDraft, type GeofenceRow, type ZoneEventRow,
} from '@/lib/geofences';

export const GEOFENCE_COLUMNS =
  'id, name, geofence_type, shape, latitude, longitude, radius_meters, polygon, color, notes, dwell_seconds, exit_buffer_m, job_id, active, automations';
const EVENT_COLUMNS = 'id, zone_name, vehicle_id, kind, occurred_at, actions';
const MAX_ZONES = 500;

interface DbError { code?: string; message?: string }

/** Turns raw Postgres / PostgREST errors into something a dispatcher can act on. */
export function friendlyGeofenceError(error: DbError | null | undefined): string {
  const msg = error?.message ?? '';
  if (error?.code === '42501' || /row-level security|permission denied/i.test(msg)) return 'You don’t have permission to change zones. Ask the account owner.';
  if (error?.code === 'PGRST116') return 'That zone no longer exists, or you can’t change it. Refresh and try again.';
  if (error?.code === '23514') return 'Some zone settings aren’t allowed. Check the shape, name and automations.';
  if (error?.code === '23505') return 'A zone with those details already exists.';
  return msg ? `Couldn’t save the zone: ${msg}` : 'Something went wrong. Please try again.';
}

export async function loadGeofences(ownerId: string): Promise<Geofence[]> {
  const { data, error } = await supabase.from('fleet_geofences').select(GEOFENCE_COLUMNS).eq('user_id', ownerId).order('name').limit(MAX_ZONES);
  if (error) throw new Error(friendlyGeofenceError(error));
  return ((data ?? []) as unknown as GeofenceRow[]).map(rowToGeofence).filter((g): g is Geofence => g !== null);
}

export async function saveGeofence(ownerId: string, draft: GeofenceDraft): Promise<Geofence> {
  const errors = validateDraft(draft);
  const first = Object.values(errors)[0];
  if (first) throw new Error(first);
  const row = draftToRow(draft);
  const table = supabase.from('fleet_geofences');
  const { data, error } = draft.id
    ? await table.update(row).eq('id', draft.id).eq('user_id', ownerId).select(GEOFENCE_COLUMNS).single()
    : await table.insert({ ...row, user_id: ownerId }).select(GEOFENCE_COLUMNS).single();
  if (error) throw new Error(friendlyGeofenceError(error));
  const saved = rowToGeofence(data as unknown as GeofenceRow);
  if (!saved) throw new Error('The zone was saved but could not be read back. Refresh the page.');
  return saved;
}

export async function setGeofenceActive(ownerId: string, id: string, active: boolean): Promise<void> {
  const { data, error } = await supabase.from('fleet_geofences').update({ active }).eq('id', id).eq('user_id', ownerId).select('id');
  if (error) throw new Error(friendlyGeofenceError(error));
  if (!data || data.length === 0) throw new Error(friendlyGeofenceError({ code: 'PGRST116' }));
}

export async function deleteGeofence(ownerId: string, id: string): Promise<void> {
  const { data, error } = await supabase.from('fleet_geofences').delete().eq('id', id).eq('user_id', ownerId).select('id');
  if (error) throw new Error(friendlyGeofenceError(error));
  if (!data || data.length === 0) throw new Error(friendlyGeofenceError({ code: 'PGRST116' }));
}

export async function loadGeofenceEvents(ownerId: string, limit = 12): Promise<ZoneEventRow[]> {
  const { data, error } = await supabase.from('fleet_geofence_events').select(EVENT_COLUMNS).eq('user_id', ownerId).order('occurred_at', { ascending: false }).limit(limit);
  if (error) throw new Error(friendlyGeofenceError(error));
  return (data ?? []) as unknown as ZoneEventRow[];
}
