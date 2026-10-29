/**
 * Geo-grid local rank tracking — pure engine shared by the edge function and the dashboard.
 *
 * No imports, no I/O, no Deno/DOM APIs: it runs unchanged in Deno (supabase/functions/geo-grid-scan),
 * in the browser (src/lib/geoGrid.ts) and in Vitest. Persistence + security live in
 * supabase/migrations/20280105000000_geo_grid_rank_tracking.sql.
 *
 * Grid convention: row 0 is the NORTH edge, col 0 is the WEST edge; the business sits in the centre cell.
 * `radiusM` is the distance from the centre to the outer ring, so spacing = radiusM / ((size - 1) / 2).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GRID_SIZES = [3, 5, 7, 9] as const;
export type GridSize = (typeof GRID_SIZES)[number];

export const METERS_PER_MILE = 1609.344;
export const RADIUS_PRESETS_MI = [1, 2, 3, 5, 10, 15, 25] as const;
export const MIN_RADIUS_M = 800;
export const MAX_RADIUS_M = 40234; // 25 miles
export const DEFAULT_GRID_SIZE: GridSize = 5;
export const DEFAULT_RADIUS_M = Math.round(5 * METERS_PER_MILE);

/** Google returns at most 20 results per text search; anything beyond is "not ranking". */
export const MAX_RANK = 20;
export const KEYWORD_MIN = 2;
export const KEYWORD_MAX = 120;
export const MAX_ACTIVE_LOCATIONS = 25;
export const MAX_ACTIVE_KEYWORDS = 50;
export const MAX_ABS_LATITUDE = 85;

const EARTH_RADIUS_M = 6_371_008.8;

export type PointOutcome = 'ranked' | 'not_found' | 'error';
export type RankBucket = 'top3' | 'top10' | 'top20' | 'missing' | 'error';
export type ScanSchedule = 'manual' | 'weekly' | 'monthly';

export const SCHEDULES: readonly ScanSchedule[] = ['manual', 'weekly', 'monthly'];

// ---------------------------------------------------------------------------
// Grid geometry
// ---------------------------------------------------------------------------

export interface GridPoint {
  row: number;
  col: number;
  lat: number;
  lng: number;
}

export function isGridSize(n: unknown): n is GridSize {
  return typeof n === 'number' && (GRID_SIZES as readonly number[]).includes(n);
}

export function gridPointCount(size: number): number {
  return size * size;
}

/** Distance between two neighbouring grid points, in metres. */
export function gridStepMeters(size: number, radiusM: number): number {
  if (size < 2) return 0;
  return radiusM / ((size - 1) / 2);
}

/** Google treats the search circle as a bias, not a filter; this keeps it local to the point. */
export function biasRadiusMeters(stepM: number): number {
  return Math.min(Math.max(Math.round(stepM), 500), 5000);
}

export function milesToMeters(mi: number): number {
  return Math.round(mi * METERS_PER_MILE);
}

export function metersToMiles(m: number): number {
  return m / METERS_PER_MILE;
}

/** "5 mi", "0.5 mi" — never more than one decimal. */
export function formatMiles(m: number): string {
  const mi = Math.round(metersToMiles(m) * 10) / 10;
  return `${Number.isInteger(mi) ? mi.toFixed(0) : mi.toFixed(1)} mi`;
}

export function validateCenter(lat: unknown, lng: unknown): string | null {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return 'The location needs valid coordinates.';
  }
  if (Math.abs(lat) > MAX_ABS_LATITUDE) return 'Locations near the poles are not supported.';
  if (Math.abs(lng) > 180) return 'The location needs valid coordinates.';
  return null;
}

function wrapLng(lng: number): number {
  let x = ((lng + 180) % 360 + 360) % 360 - 180;
  if (x === -180 && lng > 0) x = 180;
  return x;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Row-major list (north→south, west→east) of size × size points centred on the business. */
export function generateGridPoints(centerLat: number, centerLng: number, size: number, radiusM: number): GridPoint[] {
  const err = validateCenter(centerLat, centerLng);
  if (err) throw new Error(err);
  if (!isGridSize(size)) throw new Error('Unsupported grid size.');
  if (!Number.isFinite(radiusM) || radiusM < MIN_RADIUS_M || radiusM > MAX_RADIUS_M) throw new Error('Unsupported radius.');

  const step = gridStepMeters(size, radiusM);
  const mid = (size - 1) / 2;
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  const points: GridPoint[] = [];
  for (let row = 0; row < size; row++) {
    const north = (mid - row) * step;
    const lat = centerLat + ((north / EARTH_RADIUS_M) * 180) / Math.PI;
    for (let col = 0; col < size; col++) {
      const east = (col - mid) * step;
      const lng = centerLng + ((east / (EARTH_RADIUS_M * cosLat)) * 180) / Math.PI;
      points.push({ row, col, lat: round6(lat), lng: round6(wrapLng(lng)) });
    }
  }
  return points;
}

/** Great-circle distance in metres (used by tests and by the UI "distance from business" hint). */
export function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface PlaceHit {
  id: string;
  name?: string | null;
}

export interface Competitor {
  n: string;
  r: number;
}

/**
 * Rank of `targetPlaceId` inside one search result list (1-based, first MAX_RANK entries only), plus the
 * top three OTHER businesses so the owner can see who is winning that spot.
 */
export function findRank(hits: readonly PlaceHit[], targetPlaceId: string): { rank: number | null; competitors: Competitor[] } {
  const seen = new Set<string>();
  const ordered: PlaceHit[] = [];
  for (const h of hits) {
    if (!h || typeof h.id !== 'string' || h.id === '' || seen.has(h.id)) continue;
    seen.add(h.id);
    ordered.push(h);
    if (ordered.length >= MAX_RANK) break;
  }
  let rank: number | null = null;
  const competitors: Competitor[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const h = ordered[i];
    if (h.id === targetPlaceId) {
      rank = i + 1;
      continue;
    }
    const name = typeof h.name === 'string' ? h.name.trim().slice(0, 80) : '';
    if (competitors.length < 3 && name) competitors.push({ n: name, r: i + 1 });
  }
  return { rank, competitors };
}

export function rankBucket(outcome: PointOutcome, rank: number | null): RankBucket {
  if (outcome === 'error') return 'error';
  if (outcome !== 'ranked' || rank === null) return 'missing';
  if (rank <= 3) return 'top3';
  if (rank <= 10) return 'top10';
  return 'top20';
}

export interface PointResultLike {
  outcome: PointOutcome;
  rank: number | null;
}

export interface GridSummary {
  total: number;
  checked: number;
  ranked: number;
  errors: number;
  top3: number;
  top10: number;
  /** Average rank across points where the business appears (lower is better), null when it never appears. */
  avgRank: number | null;
  /** Share of Local Voice: percent of checked points where the business is in the top 3. */
  solv: number | null;
  /** Percent of checked points where the business appears at all. */
  coverage: number | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function summarizePoints(points: readonly PointResultLike[]): GridSummary {
  let checked = 0;
  let ranked = 0;
  let errors = 0;
  let top3 = 0;
  let top10 = 0;
  let rankSum = 0;
  for (const p of points) {
    if (p.outcome === 'error') {
      errors++;
      continue;
    }
    checked++;
    if (p.outcome === 'ranked' && p.rank !== null) {
      ranked++;
      rankSum += p.rank;
      if (p.rank <= 3) top3++;
      if (p.rank <= 10) top10++;
    }
  }
  return {
    total: points.length,
    checked,
    ranked,
    errors,
    top3,
    top10,
    avgRank: ranked > 0 ? round1(rankSum / ranked) : null,
    solv: checked > 0 ? round1((top3 / checked) * 100) : null,
    coverage: checked > 0 ? round1((ranked / checked) * 100) : null,
  };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Collapses whitespace and validates a search phrase. Returns the clean value or an error message. */
export function normalizeKeyword(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Enter a keyword.' };
  // eslint-disable-next-line no-control-regex
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (value.length < KEYWORD_MIN) return { ok: false, error: `Keywords need at least ${KEYWORD_MIN} characters.` };
  if (value.length > KEYWORD_MAX) return { ok: false, error: `Keywords can be at most ${KEYWORD_MAX} characters.` };
  return { ok: true, value };
}

/** ISO timestamp of the next scheduled run, or null for manual keywords. */
export function nextRunAfter(schedule: ScanSchedule, from: Date): string | null {
  if (schedule === 'manual') return null;
  const days = schedule === 'weekly' ? 7 : 30;
  return new Date(from.getTime() + days * 86_400_000).toISOString();
}
