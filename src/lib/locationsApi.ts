import { supabase } from '@/lib/supabase';
import {
  friendlyLocationError,
  normalizeBrands,
  normalizeLocation,
  normalizeLocations,
  normalizeTeamMembers,
  type Brand,
  type BusinessLocation,
  type LocationPayload,
  type TeamMemberLite,
} from '@/lib/locations';

/**
 * Data access for /dashboard/settings/locations.
 *
 * Tenant scoping (accountOwnerId = public.get_account_owner_id()) and "who may write" are enforced by
 * RLS in supabase/migrations/20270501000000_business_locations.sql, never by the client. Every function
 * throws an Error whose message is already user-safe (see friendlyLocationError).
 */

const LOCATION_SELECT = '*, brand:business_brands(id, name), members:location_members(count)';
const NO_PERMISSION = 'You do not have permission to change locations.';

function fail(error: unknown, fallback: string): never {
  throw new Error(friendlyLocationError(error, fallback));
}

// ------------------------------------------------------------------ reads

export async function fetchLocations(): Promise<BusinessLocation[]> {
  const { data, error } = await supabase.from('business_locations').select(LOCATION_SELECT).order('created_at', { ascending: true });
  if (error) fail(error, 'Could not load locations.');
  return normalizeLocations(data);
}

export async function fetchBrands(locations: BusinessLocation[] = []): Promise<Brand[]> {
  const { data, error } = await supabase
    .from('business_brands')
    .select('id, name, website_url, primary_color')
    .order('name', { ascending: true });
  if (error) fail(error, 'Could not load brands.');
  return normalizeBrands(data, locations);
}

/** Team list for the assignment picker. Failure is non-fatal for the page, so callers may swallow it. */
export async function fetchTeamMembers(): Promise<TeamMemberLite[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, member_name, member_email, role')
    .order('member_name', { ascending: true });
  if (error) fail(error, 'Could not load your team.');
  return normalizeTeamMembers(data);
}

export async function fetchLocationMembers(locationId: string): Promise<{ memberIds: string[]; managerIds: string[] }> {
  const { data, error } = await supabase.from('location_members').select('member_id, is_manager').eq('location_id', locationId);
  if (error) fail(error, 'Could not load the team for this location.');
  const rows = (data ?? []) as { member_id: string; is_manager: boolean }[];
  return { memberIds: rows.map((r) => r.member_id), managerIds: rows.filter((r) => r.is_manager).map((r) => r.member_id) };
}

export async function fetchActiveLocationId(userId: string): Promise<string | null> {
  const { data, error } = await supabase.from('location_preferences').select('active_location_id').eq('user_id', userId).maybeSingle();
  if (error) return null; // the switcher must never break the dashboard
  return (data as { active_location_id: string | null } | null)?.active_location_id ?? null;
}

// ------------------------------------------------------------------ writes: locations

export async function createLocation(payload: LocationPayload): Promise<BusinessLocation> {
  const { data, error } = await supabase.from('business_locations').insert(payload).select(LOCATION_SELECT).single();
  if (error) fail(error, 'Could not create the location.');
  const loc = normalizeLocation(data);
  if (!loc) throw new Error('Could not create the location.');
  return loc;
}

export async function updateLocation(id: string, payload: LocationPayload): Promise<BusinessLocation> {
  const { data, error } = await supabase.from('business_locations').update(payload).eq('id', id).select(LOCATION_SELECT).maybeSingle();
  if (error) fail(error, 'Could not save the location.');
  const loc = normalizeLocation(data);
  if (!loc) throw new Error(NO_PERMISSION); // RLS filtered the row out
  return loc;
}

export async function setPrimaryLocation(id: string): Promise<void> {
  const { error } = await supabase.rpc('set_primary_location', { p_location_id: id });
  if (error) fail(error, 'Could not change the primary location.');
}

export async function archiveLocation(id: string): Promise<void> {
  const { error } = await supabase.rpc('archive_business_location', { p_location_id: id });
  if (error) fail(error, 'Could not archive the location.');
}

/** Restore an archived location (comes back as active). */
export async function restoreLocation(id: string): Promise<void> {
  const { data, error } = await supabase.from('business_locations').update({ status: 'active' }).eq('id', id).select('id').maybeSingle();
  if (error) fail(error, 'Could not restore the location.');
  if (!data) throw new Error(NO_PERMISSION);
}

export async function setLocationStatus(id: string, status: 'active' | 'paused'): Promise<void> {
  const { data, error } = await supabase.from('business_locations').update({ status }).eq('id', id).select('id').maybeSingle();
  if (error) fail(error, 'Could not update the location.');
  if (!data) throw new Error(NO_PERMISSION);
}

/** Only archived locations can be deleted (enforced by RLS). */
export async function deleteLocation(id: string): Promise<void> {
  const { data, error } = await supabase.from('business_locations').delete().eq('id', id).select('id');
  if (error) fail(error, 'Could not delete the location.');
  if (!data || data.length === 0) throw new Error('Only archived locations can be deleted.');
}

export async function saveLocationMembers(locationId: string, memberIds: string[], managerIds: string[]): Promise<void> {
  const { error } = await supabase.rpc('set_location_members', {
    p_location_id: locationId,
    p_member_ids: memberIds,
    p_manager_ids: managerIds.filter((id) => memberIds.includes(id)),
  });
  if (error) fail(error, 'Could not save the team for this location.');
}

// ------------------------------------------------------------------ writes: brands

export async function createBrand(name: string, websiteUrl: string, color: string): Promise<void> {
  const { error } = await supabase
    .from('business_brands')
    .insert({ name: name.trim(), website_url: websiteUrl.trim() || null, primary_color: color.trim() || null });
  if (error) fail(error, 'Could not create the brand.');
}

export async function updateBrand(id: string, name: string, websiteUrl: string, color: string): Promise<void> {
  const { data, error } = await supabase
    .from('business_brands')
    .update({ name: name.trim(), website_url: websiteUrl.trim() || null, primary_color: color.trim() || null })
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) fail(error, 'Could not save the brand.');
  if (!data) throw new Error(NO_PERMISSION);
}

/** Locations under the brand are kept (brand_id becomes null). */
export async function deleteBrand(id: string): Promise<void> {
  const { data, error } = await supabase.from('business_brands').delete().eq('id', id).select('id');
  if (error) fail(error, 'Could not delete the brand.');
  if (!data || data.length === 0) throw new Error(NO_PERMISSION);
}

// ------------------------------------------------------------------ active location (org switcher)

export async function saveActiveLocationId(userId: string, locationId: string | null): Promise<void> {
  const { error } = await supabase
    .from('location_preferences')
    .upsert({ user_id: userId, active_location_id: locationId, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) fail(error, 'Could not remember your selected location.');
}
