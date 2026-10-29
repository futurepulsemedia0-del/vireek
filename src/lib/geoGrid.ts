/**
 * Geo-grid local rank tracking — client logic for /dashboard/geo-grid.
 *
 * Grid geometry, ranking and the headline metrics live in the shared engine (also used by the edge function),
 * so the dashboard and the scanner can never disagree. This file adds row normalisers, filtering, trends and
 * labels. Schema + security: supabase/migrations/20280105000000_geo_grid_rank_tracking.sql.
 */

import {
  GRID_SIZES,
  MAX_RANK,
  SCHEDULES,
  formatMiles,
  gridPointCount,
  isGridSize,
  normalizeKeyword,
  rankBucket,
  type Competitor,
  type GridSize,
  type PointOutcome,
  type RankBucket,
  type ScanSchedule,
} from '../../supabase/functions/_shared/geo-grid/engine';

export {
  DEFAULT_GRID_SIZE,
  DEFAULT_RADIUS_M,
  GRID_SIZES,
  KEYWORD_MAX,
  MAX_ACTIVE_KEYWORDS,
  MAX_ACTIVE_LOCATIONS,
  MAX_RANK,
  RADIUS_PRESETS_MI,
  SCHEDULES,
  formatMiles,
  gridPointCount,
  gridStepMeters,
  milesToMeters,
  normalizeKeyword,
  rankBucket,
  summarizePoints,
} from '../../supabase/functions/_shared/geo-grid/engine';
export type { Competitor, GridSize, PointOutcome, RankBucket, ScanSchedule };

// ---------------------------------------------------------------------------
// Types & labels
// ---------------------------------------------------------------------------

export type ScanStatus = 'running' | 'completed' | 'failed';

export interface GeoGridLocation {
  id: string;
  user_id: string;
  name: string;
  business_name: string;
  google_place_id: string;
  address: string | null;
  latitude: number;
  longitude: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GeoGridKeyword {
  id: string;
  user_id: string;
  location_id: string;
  keyword: string;
  grid_size: GridSize;
  radius_m: number;
  schedule: ScanSchedule;
  next_run_at: string | null;
  last_scan_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GeoGridScan {
  id: string;
  keyword_id: string;
  location_id: string;
  keyword: string;
  status: ScanStatus;
  triggered_by: 'manual' | 'schedule';
  grid_size: GridSize;
  radius_m: number;
  center_lat: number;
  center_lng: number;
  point_count: number;
  checked_count: number;
  ranked_count: number;
  top3_count: number;
  error_count: number;
  avg_rank: number | null;
  solv: number | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface GeoGridPoint {
  id: string;
  scan_id: string;
  row_idx: number;
  col_idx: number;
  latitude: number;
  longitude: number;
  outcome: PointOutcome;
  rank: number | null;
  competitors: Competitor[];
}

export interface PlaceCandidate {
  place_id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

export interface ProviderStatus {
  configured: boolean;
  monthly_limit: number;
  used_points: number;
}

export interface LocationDraft {
  name: string;
  business_name: string;
  google_place_id: string;
  address: string;
  latitude: number;
  longitude: number;
}

export interface KeywordDraft {
  location_id: string;
  keyword: string;
  grid_size: GridSize;
  radius_m: number;
  schedule: ScanSchedule;
}

export const SCHEDULE_LABELS: Record<ScanSchedule, string> = {
  manual: 'Manual only',
  weekly: 'Every week',
  monthly: 'Every month',
};

export const BUCKET_LABELS: Record<RankBucket, string> = {
  top3: 'Top 3',
  top10: '4–10',
  top20: '11–20',
  missing: `Not in top ${MAX_RANK}`,
  error: 'Check failed',
};

/** Tailwind classes per bucket (design tokens only, so light/dark themes keep working). */
export const BUCKET_STYLES: Record<RankBucket, string> = {
  top3: 'bg-success/20 text-success border-success/40',
  top10: 'bg-warning-500/20 text-warning-500 border-warning-500/40',
  top20: 'bg-danger/15 text-danger border-danger/30',
  missing: 'bg-bg-tertiary text-text-secondary border-border',
  error: 'bg-bg-secondary text-text-secondary border-dashed border-border',
};

export const BUCKET_ORDER: readonly RankBucket[] = ['top3', 'top10', 'top20', 'missing', 'error'];

export const SCAN_STATUS_LABELS: Record<ScanStatus, string> = {
  running: 'Scanning…',
  completed: 'Completed',
  failed: 'Failed',
};

// ---------------------------------------------------------------------------
// Normalisers (defensive: a bad row never crashes the page)
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const schedule = (v: unknown): ScanSchedule => (SCHEDULES as readonly unknown[]).includes(v) ? (v as ScanSchedule) : 'manual';

export function normalizeLocation(raw: unknown): GeoGridLocation | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const user_id = str(raw.user_id);
  const name = str(raw.name);
  const business_name = str(raw.business_name);
  const google_place_id = str(raw.google_place_id);
  const latitude = num(raw.latitude);
  const longitude = num(raw.longitude);
  if (!id || !user_id || !name || !business_name || !google_place_id || latitude === null || longitude === null) return null;
  return {
    id,
    user_id,
    name,
    business_name,
    google_place_id,
    address: str(raw.address),
    latitude,
    longitude,
    archived_at: str(raw.archived_at),
    created_at: str(raw.created_at) ?? '',
    updated_at: str(raw.updated_at) ?? '',
  };
}

export function normalizeKeywordRow(raw: unknown): GeoGridKeyword | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const user_id = str(raw.user_id);
  const location_id = str(raw.location_id);
  const keyword = str(raw.keyword);
  const grid = num(raw.grid_size);
  const radius = num(raw.radius_m);
  if (!id || !user_id || !location_id || !keyword || !isGridSize(grid) || radius === null) return null;
  return {
    id,
    user_id,
    location_id,
    keyword,
    grid_size: grid,
    radius_m: radius,
    schedule: schedule(raw.schedule),
    next_run_at: str(raw.next_run_at),
    last_scan_at: str(raw.last_scan_at),
    archived_at: str(raw.archived_at),
    created_at: str(raw.created_at) ?? '',
    updated_at: str(raw.updated_at) ?? '',
  };
}

export function normalizeScan(raw: unknown): GeoGridScan | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const keyword_id = str(raw.keyword_id);
  const location_id = str(raw.location_id);
  const grid = num(raw.grid_size);
  const status = raw.status;
  const center_lat = num(raw.center_lat);
  const center_lng = num(raw.center_lng);
  const started_at = str(raw.started_at);
  if (!id || !keyword_id || !location_id || !isGridSize(grid) || center_lat === null || center_lng === null || !started_at) return null;
  if (status !== 'running' && status !== 'completed' && status !== 'failed') return null;
  const point_count = num(raw.point_count) ?? gridPointCount(grid);
  return {
    id,
    keyword_id,
    location_id,
    keyword: str(raw.keyword) ?? '',
    status,
    triggered_by: raw.triggered_by === 'schedule' ? 'schedule' : 'manual',
    grid_size: grid,
    radius_m: num(raw.radius_m) ?? 0,
    center_lat,
    center_lng,
    point_count,
    checked_count: num(raw.checked_count) ?? 0,
    ranked_count: num(raw.ranked_count) ?? 0,
    top3_count: num(raw.top3_count) ?? 0,
    error_count: num(raw.error_count) ?? 0,
    avg_rank: num(raw.avg_rank),
    solv: num(raw.solv),
    error: str(raw.error),
    started_at,
    completed_at: str(raw.completed_at),
  };
}

function normalizeCompetitors(raw: unknown): Competitor[] {
  if (!Array.isArray(raw)) return [];
  const out: Competitor[] = [];
  for (const c of raw) {
    if (!isObj(c)) continue;
    const n = str(c.n);
    const r = num(c.r);
    if (n && r !== null) out.push({ n, r });
  }
  return out.slice(0, 3);
}

export function normalizePoint(raw: unknown): GeoGridPoint | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const scan_id = str(raw.scan_id);
  const row_idx = num(raw.row_idx);
  const col_idx = num(raw.col_idx);
  const latitude = num(raw.latitude);
  const longitude = num(raw.longitude);
  const outcome = raw.outcome;
  if (!id || !scan_id || row_idx === null || col_idx === null || latitude === null || longitude === null) return null;
  if (outcome !== 'ranked' && outcome !== 'not_found' && outcome !== 'error') return null;
  const rank = num(raw.rank);
  if ((outcome === 'ranked') !== (rank !== null)) return null;
  return { id, scan_id, row_idx, col_idx, latitude, longitude, outcome, rank, competitors: normalizeCompetitors(raw.competitors) };
}

function normalizeList<T>(raw: unknown, one: (r: unknown) => T | null): T[] {
  return Array.isArray(raw) ? raw.map(one).filter((r): r is T => r !== null) : [];
}
export const normalizeLocations = (raw: unknown) => normalizeList(raw, normalizeLocation);
export const normalizeKeywords = (raw: unknown) => normalizeList(raw, normalizeKeywordRow);
export const normalizeScans = (raw: unknown) => normalizeList(raw, normalizeScan);
export const normalizePoints = (raw: unknown) => normalizeList(raw, normalizePoint);

export function normalizeCandidates(raw: unknown): PlaceCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: PlaceCandidate[] = [];
  for (const c of raw) {
    if (!isObj(c)) continue;
    const place_id = str(c.place_id);
    const name = str(c.name);
    const latitude = num(c.latitude);
    const longitude = num(c.longitude);
    if (place_id && name && latitude !== null && longitude !== null) {
      out.push({ place_id, name, address: str(c.address) ?? '', latitude, longitude });
    }
  }
  return out;
}

export function normalizeProviderStatus(raw: unknown): ProviderStatus {
  const o = isObj(raw) ? raw : {};
  return {
    configured: o.configured === true,
    monthly_limit: Math.max(0, num(o.monthly_limit) ?? 0),
    used_points: Math.max(0, num(o.used_points) ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

export function activeOnly<T extends { archived_at: string | null }>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.archived_at === null);
}

/** Newest first. Running scans always sort ahead of finished ones started earlier. */
export function sortScans(scans: readonly GeoGridScan[]): GeoGridScan[] {
  return [...scans].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}

export function latestScanByKeyword(scans: readonly GeoGridScan[]): Map<string, GeoGridScan> {
  const map = new Map<string, GeoGridScan>();
  for (const s of sortScans(scans)) if (!map.has(s.keyword_id)) map.set(s.keyword_id, s);
  return map;
}

/** Latest scan that actually produced numbers (used for the trend and the overview tiles). */
export function latestCompletedByKeyword(scans: readonly GeoGridScan[]): Map<string, GeoGridScan> {
  const map = new Map<string, GeoGridScan>();
  for (const s of sortScans(scans)) if (s.status === 'completed' && !map.has(s.keyword_id)) map.set(s.keyword_id, s);
  return map;
}

export interface KeywordFilters {
  locationId: string;
  query: string;
}
export const DEFAULT_FILTERS: KeywordFilters = { locationId: 'all', query: '' };

export function filterKeywords(rows: readonly GeoGridKeyword[], f: KeywordFilters): GeoGridKeyword[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((k) => (f.locationId === 'all' || k.location_id === f.locationId) && (q === '' || k.keyword.toLowerCase().includes(q)));
}

export interface TrendDelta {
  solv: number | null;
  avgRank: number | null;
  direction: 'up' | 'down' | 'flat' | 'none';
}

/** Compares two completed scans. "up" always means visibility improved (higher SoLV, or equal SoLV and better rank). */
export function compareScans(current: GeoGridScan | undefined, previous: GeoGridScan | undefined): TrendDelta {
  if (!current || !previous || current.solv === null || previous.solv === null) return { solv: null, avgRank: null, direction: 'none' };
  const solv = Math.round((current.solv - previous.solv) * 10) / 10;
  const avgRank = current.avg_rank !== null && previous.avg_rank !== null ? Math.round((current.avg_rank - previous.avg_rank) * 10) / 10 : null;
  let direction: TrendDelta['direction'] = 'flat';
  if (solv > 0) direction = 'up';
  else if (solv < 0) direction = 'down';
  else if (avgRank !== null && avgRank < 0) direction = 'up';
  else if (avgRank !== null && avgRank > 0) direction = 'down';
  return { solv, avgRank, direction };
}

export interface OverviewSummary {
  keywords: number;
  scanned: number;
  avgSolv: number | null;
  avgRank: number | null;
}

export function summarizeOverview(keywords: readonly GeoGridKeyword[], scans: readonly GeoGridScan[]): OverviewSummary {
  const latest = latestCompletedByKeyword(scans);
  let solvSum = 0;
  let solvN = 0;
  let rankSum = 0;
  let rankN = 0;
  let scanned = 0;
  for (const k of keywords) {
    const s = latest.get(k.id);
    if (!s) continue;
    scanned++;
    if (s.solv !== null) {
      solvSum += s.solv;
      solvN++;
    }
    if (s.avg_rank !== null) {
      rankSum += s.avg_rank;
      rankN++;
    }
  }
  return {
    keywords: keywords.length,
    scanned,
    avgSolv: solvN ? Math.round((solvSum / solvN) * 10) / 10 : null,
    avgRank: rankN ? Math.round((rankSum / rankN) * 10) / 10 : null,
  };
}

/** Chronological (oldest → newest) SoLV series of completed scans, for the trend bars. */
export function trendSeries(scans: readonly GeoGridScan[], limit = 12): { id: string; at: string; solv: number }[] {
  return sortScans(scans)
    .filter((s) => s.status === 'completed' && s.solv !== null)
    .slice(0, limit)
    .reverse()
    .map((s) => ({ id: s.id, at: s.started_at, solv: s.solv as number }));
}

/** A scan stuck in "running" long after it started is treated as dead by the UI (the database reaps it on the next run). */
export const STALE_SCAN_MS = 10 * 60_000;
export function isScanActive(scan: GeoGridScan | undefined, now = Date.now()): boolean {
  return !!scan && scan.status === 'running' && now - Date.parse(scan.started_at) < STALE_SCAN_MS;
}

// ---------------------------------------------------------------------------
// Grid rendering helpers
// ---------------------------------------------------------------------------

/** size × size matrix (row-major) of points; missing cells are null so a partial scan still renders. */
export function pointMatrix(points: readonly GeoGridPoint[], size: number): (GeoGridPoint | null)[][] {
  const m: (GeoGridPoint | null)[][] = Array.from({ length: size }, () => Array<GeoGridPoint | null>(size).fill(null));
  for (const p of points) if (p.row_idx < size && p.col_idx < size && p.row_idx >= 0 && p.col_idx >= 0) m[p.row_idx][p.col_idx] = p;
  return m;
}

export function bucketCounts(points: readonly GeoGridPoint[]): Record<RankBucket, number> {
  const c: Record<RankBucket, number> = { top3: 0, top10: 0, top20: 0, missing: 0, error: 0 };
  for (const p of points) c[rankBucket(p.outcome, p.rank)]++;
  return c;
}

export function pointLabel(p: GeoGridPoint): string {
  if (p.outcome === 'error') return 'Check failed';
  if (p.outcome === 'ranked' && p.rank !== null) return `Ranked #${p.rank}`;
  return `Not in the top ${MAX_RANK}`;
}

export function googleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

// ---------------------------------------------------------------------------
// Drafts & validation
// ---------------------------------------------------------------------------

export function describeGrid(size: number, radiusM: number): string {
  return `${size}×${size} grid · ${gridPointCount(size)} points · ${formatMiles(radiusM)} radius`;
}

export function validateKeywordDraft(d: KeywordDraft, existing: readonly GeoGridKeyword[], editingId?: string): string | null {
  const kw = normalizeKeyword(d.keyword);
  if (!kw.ok) return kw.error;
  if (!d.location_id) return 'Choose a location.';
  if (!(GRID_SIZES as readonly number[]).includes(d.grid_size)) return 'Choose a grid size.';
  const dup = existing.some(
    (k) => k.id !== editingId && k.archived_at === null && k.location_id === d.location_id && k.keyword.toLowerCase() === kw.value.toLowerCase(),
  );
  return dup ? 'You are already tracking this keyword for this location.' : null;
}

export function validateLocationDraft(d: LocationDraft): string | null {
  if (!d.google_place_id) return 'Search for your business and pick it from the results.';
  if (d.name.trim().length < 1 || d.name.trim().length > 120) return 'Give this location a short name.';
  return null;
}

export function draftsEqual(a: KeywordDraft, b: KeywordDraft): boolean {
  return a.location_id === b.location_id && a.keyword.trim() === b.keyword.trim() && a.grid_size === b.grid_size && a.radius_m === b.radius_m && a.schedule === b.schedule;
}

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const diff = now - Date.parse(iso);
  if (!Number.isFinite(diff)) return 'never';
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const unit = mins < 60 ? `${Math.max(mins, 1)} min` : mins < 1440 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`;
  return diff >= 0 ? (mins < 1 ? 'just now' : `${unit} ago`) : `in ${unit}`;
}
