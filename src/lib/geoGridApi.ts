import { supabase } from '@/lib/supabase';
import {
  normalizeCandidates,
  normalizeKeywordRow,
  normalizeKeywords,
  normalizeLocation,
  normalizeLocations,
  normalizePoints,
  normalizeProviderStatus,
  normalizeScan,
  normalizeScans,
  type GeoGridKeyword,
  type GeoGridLocation,
  type GeoGridPoint,
  type GeoGridScan,
  type KeywordDraft,
  type LocationDraft,
  type PlaceCandidate,
  type ProviderStatus,
} from '@/lib/geoGrid';

/**
 * Data access for /dashboard/geo-grid. Reads are scoped to the account owner on top of RLS. Locations and
 * keywords are edited directly (RLS + guard triggers); scans and points are written ONLY by the
 * geo-grid-scan edge function, never from the browser.
 * Schema: supabase/migrations/20280105000000_geo_grid_rank_tracking.sql.
 */

const LOCATION_COLUMNS = 'id, user_id, name, business_name, google_place_id, address, latitude, longitude, archived_at, created_at, updated_at';
const KEYWORD_COLUMNS = 'id, user_id, location_id, keyword, grid_size, radius_m, schedule, next_run_at, last_scan_at, archived_at, created_at, updated_at';
const SCAN_COLUMNS =
  'id, keyword_id, location_id, keyword, status, triggered_by, grid_size, radius_m, center_lat, center_lng, point_count, checked_count, ranked_count, top3_count, error_count, avg_rank, solv, error, started_at, completed_at';
const POINT_COLUMNS = 'id, scan_id, row_idx, col_idx, latitude, longitude, outcome, rank, competitors';

export class GeoGridConflictError extends Error {
  constructor() {
    super('This item changed or is no longer available. Reload to see the latest version.');
    this.name = 'GeoGridConflictError';
  }
}

export class GeoGridFunctionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GeoGridFunctionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchLocations(accountOwnerId: string): Promise<GeoGridLocation[]> {
  const { data, error } = await supabase
    .from('geo_grid_locations')
    .select(LOCATION_COLUMNS)
    .eq('user_id', accountOwnerId)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  return normalizeLocations(data);
}

export async function fetchKeywords(accountOwnerId: string): Promise<GeoGridKeyword[]> {
  const { data, error } = await supabase
    .from('geo_grid_keywords')
    .select(KEYWORD_COLUMNS)
    .eq('user_id', accountOwnerId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw error;
  return normalizeKeywords(data);
}

/** Newest scans for the whole account (aggregates only — no points), enough for list badges and trends. */
export async function fetchRecentScans(accountOwnerId: string, limit = 300): Promise<GeoGridScan[]> {
  const { data, error } = await supabase
    .from('geo_grid_scans')
    .select(SCAN_COLUMNS)
    .eq('user_id', accountOwnerId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return normalizeScans(data);
}

export async function fetchKeywordScans(accountOwnerId: string, keywordId: string, limit = 60): Promise<GeoGridScan[]> {
  const { data, error } = await supabase
    .from('geo_grid_scans')
    .select(SCAN_COLUMNS)
    .eq('user_id', accountOwnerId)
    .eq('keyword_id', keywordId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return normalizeScans(data);
}

export async function fetchScanPoints(accountOwnerId: string, scanId: string): Promise<GeoGridPoint[]> {
  const { data, error } = await supabase
    .from('geo_grid_points')
    .select(POINT_COLUMNS)
    .eq('user_id', accountOwnerId)
    .eq('scan_id', scanId)
    .order('row_idx', { ascending: true })
    .order('col_idx', { ascending: true })
    .limit(100);
  if (error) throw error;
  return normalizePoints(data);
}

// ---------------------------------------------------------------------------
// Locations & keywords (direct writes, protected by RLS + guard triggers)
// ---------------------------------------------------------------------------

function requireLocation(data: unknown): GeoGridLocation {
  const row = normalizeLocation(data);
  if (!row) throw new Error('Unexpected response from the server.');
  return row;
}

function requireKeyword(data: unknown): GeoGridKeyword {
  const row = normalizeKeywordRow(data);
  if (!row) throw new Error('Unexpected response from the server.');
  return row;
}

export async function createLocation(accountOwnerId: string, draft: LocationDraft): Promise<GeoGridLocation> {
  const { data, error } = await supabase
    .from('geo_grid_locations')
    .insert({
      user_id: accountOwnerId,
      name: draft.name.trim(),
      business_name: draft.business_name.trim(),
      google_place_id: draft.google_place_id,
      address: draft.address.trim() || null,
      latitude: draft.latitude,
      longitude: draft.longitude,
    })
    .select(LOCATION_COLUMNS)
    .single();
  if (error) throw error;
  return requireLocation(data);
}

export async function setLocationArchived(
  id: string,
  accountOwnerId: string,
  expectedUpdatedAt: string,
  archived: boolean,
): Promise<GeoGridLocation> {
  const { data, error } = await supabase
    .from('geo_grid_locations')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', id)
    .eq('user_id', accountOwnerId)
    .eq('updated_at', expectedUpdatedAt)
    .select(LOCATION_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new GeoGridConflictError();
  return requireLocation(data);
}

export async function createKeyword(accountOwnerId: string, draft: KeywordDraft): Promise<GeoGridKeyword> {
  const { data, error } = await supabase
    .from('geo_grid_keywords')
    .insert({
      user_id: accountOwnerId,
      location_id: draft.location_id,
      keyword: draft.keyword.trim().replace(/\s+/g, ' '),
      grid_size: draft.grid_size,
      radius_m: draft.radius_m,
      schedule: draft.schedule,
    })
    .select(KEYWORD_COLUMNS)
    .single();
  if (error) throw error;
  return requireKeyword(data);
}

/** Optimistic concurrency: only applies if nobody changed the row since `expectedUpdatedAt`. */
export async function updateKeyword(
  id: string,
  accountOwnerId: string,
  expectedUpdatedAt: string,
  draft: Omit<KeywordDraft, 'location_id'>,
): Promise<GeoGridKeyword> {
  const { data, error } = await supabase
    .from('geo_grid_keywords')
    .update({
      keyword: draft.keyword.trim().replace(/\s+/g, ' '),
      grid_size: draft.grid_size,
      radius_m: draft.radius_m,
      schedule: draft.schedule,
    })
    .eq('id', id)
    .eq('user_id', accountOwnerId)
    .eq('updated_at', expectedUpdatedAt)
    .select(KEYWORD_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new GeoGridConflictError();
  return requireKeyword(data);
}

export async function setKeywordArchived(
  id: string,
  accountOwnerId: string,
  expectedUpdatedAt: string,
  archived: boolean,
): Promise<GeoGridKeyword> {
  const { data, error } = await supabase
    .from('geo_grid_keywords')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', id)
    .eq('user_id', accountOwnerId)
    .eq('updated_at', expectedUpdatedAt)
    .select(KEYWORD_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new GeoGridConflictError();
  return requireKeyword(data);
}

// ---------------------------------------------------------------------------
// Edge function (provider calls + scans)
// ---------------------------------------------------------------------------

/** supabase-js hides the JSON body of non-2xx replies inside error.context. */
async function functionError(err: unknown): Promise<GeoGridFunctionError> {
  const ctx = (err as { context?: unknown } | null)?.context;
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown; message?: unknown };
      const code = typeof body.error === 'string' ? body.error : 'error';
      const message = typeof body.message === 'string' && body.message ? body.message : 'Something went wrong. Please try again.';
      return new GeoGridFunctionError(code, message);
    } catch {
      /* fall through */
    }
  }
  return new GeoGridFunctionError('error', 'Could not reach the server. Check your connection and try again.');
}

async function callFunction<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('geo-grid-scan', { body });
  if (error) throw await functionError(error);
  return data as T;
}

export async function fetchProviderStatus(): Promise<ProviderStatus> {
  return normalizeProviderStatus(await callFunction<unknown>({ action: 'status' }));
}

export async function searchPlaces(query: string, near?: { lat: number; lng: number }): Promise<PlaceCandidate[]> {
  const res = await callFunction<{ places?: unknown }>({ action: 'search_places', query: query.trim(), lat: near?.lat, lng: near?.lng });
  return normalizeCandidates(res?.places);
}

/** Runs one full scan (typically 5–20 seconds). Resolves with the finished scan row. */
export async function runGeoGridScan(keywordId: string): Promise<GeoGridScan> {
  const res = await callFunction<{ scan?: unknown }>({ action: 'scan', keyword_id: keywordId });
  const scan = normalizeScan(res?.scan);
  if (!scan) throw new Error('Unexpected response from the server.');
  return scan;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Turns any thrown value into a message that is safe and useful in a toast. */
export function describeGeoGridError(err: unknown): string {
  if (err instanceof GeoGridConflictError) return err.message;
  if (err instanceof GeoGridFunctionError) return err.message;
  const e = err as { code?: string; message?: string } | null;
  const code = e?.code ?? '';
  const message = typeof e?.message === 'string' ? e.message : '';
  if (code === '23505') return 'You are already tracking this keyword or location.';
  if (code === '23514') return 'One of the values is out of range. Check the keyword length, grid size and radius.';
  if (code === '42501') return /row-level security/i.test(message) ? 'You do not have permission to do that.' : message || 'You do not have permission to do that.';
  if (['53400', '22023', '55000', 'P0002', 'P0001'].includes(code) && message) return message;
  return 'Something went wrong. Please try again.';
}
