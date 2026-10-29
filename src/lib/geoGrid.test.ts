import { describe, it, expect } from 'vitest';
import {
  biasRadiusMeters,
  findRank,
  formatMiles,
  generateGridPoints,
  gridPointCount,
  gridStepMeters,
  haversineMeters,
  nextRunAfter,
  normalizeKeyword,
  rankBucket,
  summarizePoints,
  validateCenter,
} from '../../supabase/functions/_shared/geo-grid/engine';
import {
  compareScans,
  filterKeywords,
  isScanActive,
  latestCompletedByKeyword,
  normalizeKeywordRow,
  normalizePoint,
  normalizeScan,
  pointMatrix,
  relativeTime,
  summarizeOverview,
  trendSeries,
  validateKeywordDraft,
  type GeoGridKeyword,
  type GeoGridPoint,
  type GeoGridScan,
} from './geoGrid';

const AUSTIN = { lat: 30.2672, lng: -97.7431 };

function scan(over: Partial<GeoGridScan> = {}): GeoGridScan {
  return {
    id: 's1',
    keyword_id: 'k1',
    location_id: 'l1',
    keyword: 'plumber',
    status: 'completed',
    triggered_by: 'manual',
    grid_size: 5,
    radius_m: 8047,
    center_lat: AUSTIN.lat,
    center_lng: AUSTIN.lng,
    point_count: 25,
    checked_count: 25,
    ranked_count: 20,
    top3_count: 10,
    error_count: 0,
    avg_rank: 4.2,
    solv: 40,
    error: null,
    started_at: '2028-01-10T10:00:00.000Z',
    completed_at: '2028-01-10T10:00:12.000Z',
    ...over,
  };
}

function keyword(over: Partial<GeoGridKeyword> = {}): GeoGridKeyword {
  return {
    id: 'k1',
    user_id: 'u1',
    location_id: 'l1',
    keyword: 'Emergency Plumber',
    grid_size: 5,
    radius_m: 8047,
    schedule: 'weekly',
    next_run_at: null,
    last_scan_at: null,
    archived_at: null,
    created_at: '2028-01-01T00:00:00.000Z',
    updated_at: '2028-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('grid geometry', () => {
  it('builds size×size points, row-major, north→south and west→east', () => {
    const pts = generateGridPoints(AUSTIN.lat, AUSTIN.lng, 5, 8047);
    expect(pts).toHaveLength(25);
    expect(pts[0]).toMatchObject({ row: 0, col: 0 });
    expect(pts[24]).toMatchObject({ row: 4, col: 4 });
    expect(pts[0].lat).toBeGreaterThan(pts[24].lat); // row 0 is north
    expect(pts[0].lng).toBeLessThan(pts[24].lng); // col 0 is west
  });

  it('puts the business exactly in the centre cell', () => {
    for (const size of [3, 5, 7, 9]) {
      const pts = generateGridPoints(AUSTIN.lat, AUSTIN.lng, size, 8047);
      const mid = (size - 1) / 2;
      const centre = pts.find((p) => p.row === mid && p.col === mid)!;
      expect(centre.lat).toBeCloseTo(AUSTIN.lat, 5);
      expect(centre.lng).toBeCloseTo(AUSTIN.lng, 5);
    }
  });

  it('places the outer ring at the requested radius and neighbours one step apart', () => {
    const radius = 8047;
    const pts = generateGridPoints(AUSTIN.lat, AUSTIN.lng, 5, radius);
    const north = pts.find((p) => p.row === 0 && p.col === 2)!;
    const east = pts.find((p) => p.row === 2 && p.col === 4)!;
    expect(haversineMeters(AUSTIN.lat, AUSTIN.lng, north.lat, north.lng)).toBeCloseTo(radius, -1);
    expect(haversineMeters(AUSTIN.lat, AUSTIN.lng, east.lat, east.lng)).toBeCloseTo(radius, -1);
    const a = pts.find((p) => p.row === 2 && p.col === 2)!;
    const b = pts.find((p) => p.row === 2 && p.col === 3)!;
    expect(haversineMeters(a.lat, a.lng, b.lat, b.lng)).toBeCloseTo(gridStepMeters(5, radius), -1);
  });

  it('stays correct at high latitude and across the antimeridian', () => {
    const oslo = generateGridPoints(59.9139, 10.7522, 3, 5000);
    expect(haversineMeters(59.9139, 10.7522, oslo[1].lat, oslo[1].lng)).toBeCloseTo(5000, -1);
    const fiji = generateGridPoints(-17.7, 179.99, 3, 20000);
    for (const p of fiji) expect(p.lng >= -180 && p.lng <= 180).toBe(true);
    expect(fiji.some((p) => p.lng < 0)).toBe(true); // wrapped to the western hemisphere
  });

  it('rejects unsupported inputs instead of producing garbage', () => {
    expect(() => generateGridPoints(AUSTIN.lat, AUSTIN.lng, 4, 8047)).toThrow();
    expect(() => generateGridPoints(AUSTIN.lat, AUSTIN.lng, 5, 10)).toThrow();
    expect(() => generateGridPoints(89, 0, 5, 8047)).toThrow();
    expect(validateCenter(Number.NaN, 0)).not.toBeNull();
    expect(validateCenter(30, 200)).not.toBeNull();
    expect(validateCenter(30, -97)).toBeNull();
  });

  it('counts points and formats distances', () => {
    expect(gridPointCount(9)).toBe(81);
    expect(formatMiles(8047)).toBe('5 mi');
    expect(formatMiles(805)).toBe('0.5 mi');
    expect(biasRadiusMeters(100)).toBe(500);
    expect(biasRadiusMeters(2682)).toBe(2682);
    expect(biasRadiusMeters(99999)).toBe(5000);
  });
});

describe('findRank', () => {
  const hit = (id: string, name = id) => ({ id, name });

  it('returns the 1-based position and the top other businesses', () => {
    const { rank, competitors } = findRank([hit('a', 'Alpha'), hit('b', 'Beta'), hit('me', 'Me'), hit('d', 'Delta'), hit('e', 'Echo')], 'me');
    expect(rank).toBe(3);
    expect(competitors).toEqual([
      { n: 'Alpha', r: 1 },
      { n: 'Beta', r: 2 },
      { n: 'Delta', r: 4 },
    ]);
  });

  it('returns null when the business is absent or beyond the top 20', () => {
    expect(findRank([hit('a'), hit('b')], 'me').rank).toBeNull();
    const many = Array.from({ length: 25 }, (_, i) => hit(`p${i}`));
    many[22] = hit('me');
    expect(findRank(many, 'me').rank).toBeNull();
    many[19] = hit('me');
    expect(findRank(many, 'me').rank).toBe(20);
  });

  it('ignores duplicates and malformed entries', () => {
    const { rank } = findRank([hit('a'), hit('a'), { id: '' }, hit('me')], 'me');
    expect(rank).toBe(2);
    expect(findRank([], 'me')).toEqual({ rank: null, competitors: [] });
  });
});

describe('summaries', () => {
  it('computes share of local voice, average rank and coverage', () => {
    const s = summarizePoints([
      { outcome: 'ranked', rank: 1 },
      { outcome: 'ranked', rank: 3 },
      { outcome: 'ranked', rank: 8 },
      { outcome: 'not_found', rank: null },
      { outcome: 'error', rank: null },
    ]);
    expect(s).toMatchObject({ total: 5, checked: 4, ranked: 3, errors: 1, top3: 2, top10: 3 });
    expect(s.avgRank).toBe(4);
    expect(s.solv).toBe(50);
    expect(s.coverage).toBe(75);
  });

  it('handles empty and all-error scans without dividing by zero', () => {
    expect(summarizePoints([])).toMatchObject({ solv: null, avgRank: null, coverage: null });
    expect(summarizePoints([{ outcome: 'error', rank: null }])).toMatchObject({ checked: 0, solv: null });
  });

  it('buckets ranks', () => {
    expect(rankBucket('ranked', 3)).toBe('top3');
    expect(rankBucket('ranked', 4)).toBe('top10');
    expect(rankBucket('ranked', 10)).toBe('top10');
    expect(rankBucket('ranked', 11)).toBe('top20');
    expect(rankBucket('not_found', null)).toBe('missing');
    expect(rankBucket('error', null)).toBe('error');
  });
});

describe('keywords and schedules', () => {
  it('cleans and validates keywords', () => {
    expect(normalizeKeyword('  emergency   plumber \n')).toEqual({ ok: true, value: 'emergency plumber' });
    expect(normalizeKeyword('a').ok).toBe(false);
    expect(normalizeKeyword('x'.repeat(121)).ok).toBe(false);
    expect(normalizeKeyword(42).ok).toBe(false);
  });

  it('computes the next run', () => {
    const from = new Date('2028-01-01T00:00:00.000Z');
    expect(nextRunAfter('manual', from)).toBeNull();
    expect(nextRunAfter('weekly', from)).toBe('2028-01-08T00:00:00.000Z');
    expect(nextRunAfter('monthly', from)).toBe('2028-01-31T00:00:00.000Z');
  });

  it('flags duplicate keywords per location but allows editing the same row', () => {
    const existing = [keyword()];
    const draft = { location_id: 'l1', keyword: ' emergency  plumber', grid_size: 5 as const, radius_m: 8047, schedule: 'weekly' as const };
    expect(validateKeywordDraft(draft, existing)).toMatch(/already tracking/);
    expect(validateKeywordDraft(draft, existing, 'k1')).toBeNull();
    expect(validateKeywordDraft({ ...draft, location_id: 'l2' }, existing)).toBeNull();
    expect(validateKeywordDraft({ ...draft, location_id: '' }, existing)).toMatch(/location/i);
    expect(validateKeywordDraft({ ...draft, keyword: '' }, existing)).not.toBeNull();
  });

  it('ignores archived keywords when checking duplicates and filters by location and text', () => {
    const rows = [keyword({ id: 'a', keyword: 'Plumber', archived_at: '2028-01-02T00:00:00Z' }), keyword({ id: 'b', keyword: 'Drain cleaning', location_id: 'l2' })];
    const draft = { location_id: 'l1', keyword: 'plumber', grid_size: 5 as const, radius_m: 8047, schedule: 'manual' as const };
    expect(validateKeywordDraft(draft, rows)).toBeNull();
    expect(filterKeywords(rows, { locationId: 'l2', query: '' }).map((k) => k.id)).toEqual(['b']);
    expect(filterKeywords(rows, { locationId: 'all', query: 'DRAIN' }).map((k) => k.id)).toEqual(['b']);
  });
});

describe('scans over time', () => {
  it('compares scans and reads direction as visibility improving or slipping', () => {
    expect(compareScans(scan({ solv: 52 }), scan({ solv: 40 }))).toMatchObject({ solv: 12, direction: 'up' });
    expect(compareScans(scan({ solv: 30 }), scan({ solv: 40 }))).toMatchObject({ solv: -10, direction: 'down' });
    expect(compareScans(scan({ solv: 40, avg_rank: 3 }), scan({ solv: 40, avg_rank: 5 }))).toMatchObject({ direction: 'up', avgRank: -2 });
    expect(compareScans(scan({ solv: 40, avg_rank: 5 }), scan({ solv: 40, avg_rank: 5 }))).toMatchObject({ direction: 'flat' });
    expect(compareScans(scan(), undefined).direction).toBe('none');
    expect(compareScans(scan({ solv: null }), scan()).direction).toBe('none');
  });

  it('summarises the overview from the latest COMPLETED scan of each keyword', () => {
    const scans = [
      scan({ id: 'new-fail', status: 'failed', solv: null, avg_rank: null, started_at: '2028-01-12T00:00:00Z' }),
      scan({ id: 'old-ok', solv: 40, avg_rank: 4, started_at: '2028-01-10T00:00:00Z' }),
      scan({ id: 'older', solv: 10, avg_rank: 9, started_at: '2028-01-03T00:00:00Z' }),
      scan({ id: 'k2-ok', keyword_id: 'k2', solv: 20, avg_rank: 6, started_at: '2028-01-11T00:00:00Z' }),
    ];
    expect(latestCompletedByKeyword(scans).get('k1')?.id).toBe('old-ok');
    const o = summarizeOverview([keyword({ id: 'k1' }), keyword({ id: 'k2' }), keyword({ id: 'k3' })], scans);
    expect(o).toEqual({ keywords: 3, scanned: 2, avgSolv: 30, avgRank: 5 });
  });

  it('builds a chronological trend of completed scans only', () => {
    const scans = [
      scan({ id: 'c', solv: 50, started_at: '2028-01-12T00:00:00Z' }),
      scan({ id: 'x', status: 'failed', solv: null, started_at: '2028-01-11T00:00:00Z' }),
      scan({ id: 'b', solv: 40, started_at: '2028-01-10T00:00:00Z' }),
      scan({ id: 'a', solv: 30, started_at: '2028-01-09T00:00:00Z' }),
    ];
    expect(trendSeries(scans).map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(trendSeries(scans, 2).map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('treats a stale running scan as inactive', () => {
    const now = Date.parse('2028-01-10T10:30:00Z');
    expect(isScanActive(scan({ status: 'running', started_at: '2028-01-10T10:29:00Z' }), now)).toBe(true);
    expect(isScanActive(scan({ status: 'running', started_at: '2028-01-10T10:00:00Z' }), now)).toBe(false);
    expect(isScanActive(scan({ status: 'completed' }), now)).toBe(false);
    expect(isScanActive(undefined, now)).toBe(false);
  });

  it('formats relative times in both directions', () => {
    const now = Date.parse('2028-01-10T12:00:00Z');
    expect(relativeTime(null, now)).toBe('never');
    expect(relativeTime('2028-01-10T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2028-01-10T10:00:00Z', now)).toBe('2 h ago');
    expect(relativeTime('2028-01-13T12:00:00Z', now)).toBe('in 3 d');
  });
});

describe('row normalisers', () => {
  it('accepts well-formed rows and numeric strings from the database', () => {
    const row = normalizeScan({
      ...scan(),
      avg_rank: '4.2',
      solv: '40.0',
      grid_size: 5,
    });
    expect(row?.avg_rank).toBe(4.2);
    expect(row?.solv).toBe(40);
  });

  it('drops malformed rows instead of crashing the page', () => {
    expect(normalizeScan({ id: 's' })).toBeNull();
    expect(normalizeScan({ ...scan(), status: 'weird' })).toBeNull();
    expect(normalizeScan({ ...scan(), grid_size: 4 })).toBeNull();
    expect(normalizeKeywordRow({ ...keyword(), grid_size: 6 })).toBeNull();
    expect(normalizeKeywordRow({ ...keyword(), schedule: 'daily' })?.schedule).toBe('manual');
    expect(normalizePoint(null)).toBeNull();
    // rank must agree with outcome
    expect(normalizePoint({ id: 'p', scan_id: 's', row_idx: 0, col_idx: 0, latitude: 1, longitude: 1, outcome: 'ranked', rank: null })).toBeNull();
    expect(normalizePoint({ id: 'p', scan_id: 's', row_idx: 0, col_idx: 0, latitude: 1, longitude: 1, outcome: 'not_found', rank: 4 })).toBeNull();
  });

  it('lays points into a matrix and leaves missing cells empty', () => {
    const p = (row: number, col: number): GeoGridPoint => ({
      id: `${row}-${col}`,
      scan_id: 's',
      row_idx: row,
      col_idx: col,
      latitude: 0,
      longitude: 0,
      outcome: 'not_found',
      rank: null,
      competitors: [],
    });
    const m = pointMatrix([p(0, 0), p(2, 2), p(9, 9)], 3);
    expect(m[0][0]?.id).toBe('0-0');
    expect(m[2][2]?.id).toBe('2-2');
    expect(m[1][1]).toBeNull();
    expect(m).toHaveLength(3);
  });
});
