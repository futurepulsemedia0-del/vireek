import { describe, it, expect, vi } from 'vitest';

// The pure functions under test never touch the network — keep the real client out of the test.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  normalizePostalCode,
  parsePostalCodeList,
  extractPostalCode,
  parsePolygonInput,
  pointInPolygon,
  resolveServiceArea,
  computeAreaQuote,
  isSurgeActive,
  validateAreaInput,
  findZipOverlaps,
  outOfAreaReply,
  DEFAULT_OUT_OF_AREA_MESSAGES,
  type ServiceArea,
  type ServiceAreaInput,
} from './serviceAreas';

function makeArea(overrides: Partial<ServiceArea> = {}): ServiceArea {
  return {
    id: 'a1',
    user_id: 'owner-1',
    name: 'Downtown',
    color: '#3b82f6',
    zone_type: 'zip',
    zip_codes: ['78701', '78702'],
    polygon: null,
    is_active: true,
    priority: 0,
    travel_fee_cents: 0,
    surge_enabled: false,
    surge_multiplier: 1,
    surge_ends_at: null,
    notes: null,
    created_at: '2027-01-01T00:00:00.000Z',
    updated_at: '2027-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const SQUARE: [number, number][] = [
  [30.0, -98.0],
  [30.0, -97.0],
  [31.0, -97.0],
  [31.0, -98.0],
];

describe('postal codes', () => {
  it('normalizes US, ZIP+4 and Canadian codes', () => {
    expect(normalizePostalCode(' 78701 ')).toBe('78701');
    expect(normalizePostalCode('78701-1234')).toBe('78701');
    expect(normalizePostalCode('k1a 0b1')).toBe('K1A0B1');
    expect(normalizePostalCode('K1A')).toBe('K1A');
    expect(normalizePostalCode('abc')).toBeNull();
    expect(normalizePostalCode('1234')).toBeNull();
  });

  it('parses mixed lists, de-duplicates and reports invalid tokens', () => {
    const { codes, invalid } = parsePostalCodeList('78701, 78702\n78701 78703; K1A 0B1 oops');
    expect(codes).toEqual(['78701', '78702', '78703', 'K1A0B1']);
    expect(invalid).toEqual(['oops']);
  });

  it('extracts the postal code from an address (last match wins)', () => {
    expect(extractPostalCode('12345 Main St, Austin, TX 78701')).toBe('78701');
    expect(extractPostalCode('1 Rideau St, Ottawa ON K1N 8S7')).toBe('K1N8S7');
    expect(extractPostalCode('Main St, nowhere')).toBeNull();
    expect(extractPostalCode(null)).toBeNull();
  });
});

describe('polygons', () => {
  it('parses lat/lng lines and drops a repeated closing point', () => {
    const r = parsePolygonInput('30,-98\n30,-97\n31,-97\n30,-98');
    expect(r.error).toBeNull();
    expect(r.polygon).toEqual([
      [30, -98],
      [30, -97],
      [31, -97],
    ]);
  });

  it('parses GeoJSON (lng,lat order) into [lat,lng]', () => {
    const r = parsePolygonInput(
      JSON.stringify({
        type: 'Polygon',
        coordinates: [
          [
            [-98, 30],
            [-97, 30],
            [-97, 31],
            [-98, 30],
          ],
        ],
      }),
    );
    expect(r.polygon?.[0]).toEqual([30, -98]);
    expect(r.polygon).toHaveLength(3);
  });

  it('rejects bad input with a useful message', () => {
    expect(parsePolygonInput('').error).toMatch(/at least 3/);
    expect(parsePolygonInput('30,-98\nfoo').error).toMatch(/Line 2/);
    expect(parsePolygonInput('95,0\n0,0\n1,1').error).toMatch(/Latitude/);
    expect(parsePolygonInput('1,1\n1,1\n1,1').error).toMatch(/3 distinct/);
    expect(parsePolygonInput('{bad').error).toMatch(/JSON/);
  });

  it('point-in-polygon works inside, outside and for degenerate polygons', () => {
    expect(pointInPolygon(30.5, -97.5, SQUARE)).toBe(true);
    expect(pointInPolygon(32, -97.5, SQUARE)).toBe(false);
    expect(pointInPolygon(30.5, -99, SQUARE)).toBe(false);
    expect(
      pointInPolygon(1, 1, [
        [0, 0],
        [1, 1],
      ]),
    ).toBe(false);
  });
});

describe('resolveServiceArea', () => {
  it('reports no_areas_configured when nothing is active', () => {
    expect(resolveServiceArea([], { postalCode: '78701' }).status).toBe('no_areas_configured');
    expect(
      resolveServiceArea([makeArea({ is_active: false })], { postalCode: '78701' }).status,
    ).toBe('no_areas_configured');
  });

  it('matches zip zones, including Canadian FSA prefixes', () => {
    const r = resolveServiceArea([makeArea()], { postalCode: '78701-4444' });
    expect(r.status).toBe('in_area');
    const fsa = resolveServiceArea([makeArea({ zip_codes: ['K1A'] })], { postalCode: 'K1A 0B1' });
    expect(fsa.status).toBe('in_area');
  });

  it('says out_of_area only when it could actually check', () => {
    expect(resolveServiceArea([makeArea()], { postalCode: '99999' }).status).toBe('out_of_area');
    // zip zones but no code supplied → cannot decide
    expect(resolveServiceArea([makeArea()], {}).status).toBe('unknown');
    // polygon zone but only a postal code supplied → cannot decide
    const poly = makeArea({ id: 'p', zone_type: 'polygon', zip_codes: [], polygon: SQUARE });
    expect(resolveServiceArea([poly], { postalCode: '78701' }).status).toBe('unknown');
    expect(resolveServiceArea([poly], { latitude: 40, longitude: -97.5 }).status).toBe(
      'out_of_area',
    );
  });

  it('matches polygon zones by coordinates', () => {
    const poly = makeArea({ id: 'p', zone_type: 'polygon', zip_codes: [], polygon: SQUARE });
    const r = resolveServiceArea([poly], { latitude: 30.5, longitude: -97.5 });
    expect(r.status).toBe('in_area');
  });

  it('a polygon hit wins even when no postal code is available for the zip zone', () => {
    const zip = makeArea();
    const poly = makeArea({ id: 'p', zone_type: 'polygon', zip_codes: [], polygon: SQUARE });
    expect(resolveServiceArea([zip, poly], { latitude: 30.5, longitude: -97.5 }).status).toBe(
      'in_area',
    );
  });

  it('breaks overlaps by priority, then oldest, and lists the others', () => {
    const low = makeArea({ id: 'low', priority: 1 });
    const high = makeArea({ id: 'high', priority: 5, name: 'Premium' });
    const r = resolveServiceArea([low, high], { postalCode: '78701' });
    expect(r.status).toBe('in_area');
    if (r.status === 'in_area') {
      expect(r.area.id).toBe('high');
      expect(r.alsoMatched.map((a) => a.id)).toEqual(['low']);
    }
    const older = makeArea({ id: 'older', created_at: '2026-01-01T00:00:00.000Z' });
    const newer = makeArea({ id: 'newer' });
    const tie = resolveServiceArea([newer, older], { postalCode: '78701' });
    if (tie.status === 'in_area') expect(tie.area.id).toBe('older');
  });

  it('ignores inactive zones', () => {
    const off = makeArea({ is_active: false });
    const on = makeArea({ id: 'b', zip_codes: ['10001'] });
    expect(resolveServiceArea([off, on], { postalCode: '78701' }).status).toBe('out_of_area');
  });
});

describe('pricing', () => {
  const now = new Date('2027-03-01T12:00:00.000Z');

  it('adds the travel fee flat and multiplies only the base by surge', () => {
    const area = makeArea({ travel_fee_cents: 2500, surge_enabled: true, surge_multiplier: 1.5 });
    const q = computeAreaQuote(area, 10000, now);
    expect(q.surgeApplied).toBe(true);
    expect(q.surgeAmountCents).toBe(5000);
    expect(q.travelFeeCents).toBe(2500);
    expect(q.totalCents).toBe(17500);
  });

  it('does not apply an expired or disabled surge', () => {
    const expired = makeArea({
      surge_enabled: true,
      surge_multiplier: 2,
      surge_ends_at: '2027-02-01T00:00:00.000Z',
    });
    expect(isSurgeActive(expired, now)).toBe(false);
    expect(computeAreaQuote(expired, 10000, now).totalCents).toBe(10000);
    expect(isSurgeActive(makeArea({ surge_enabled: false, surge_multiplier: 3 }), now)).toBe(false);
    expect(isSurgeActive(makeArea({ surge_enabled: true, surge_multiplier: 1 }), now)).toBe(false);
  });

  it('keeps a future-dated surge active and never returns negative totals', () => {
    const live = makeArea({
      surge_enabled: true,
      surge_multiplier: 2,
      surge_ends_at: '2027-04-01T00:00:00.000Z',
    });
    expect(isSurgeActive(live, now)).toBe(true);
    expect(computeAreaQuote(makeArea(), -500, now).totalCents).toBe(0);
  });

  it('rounds once to whole cents', () => {
    const area = makeArea({ surge_enabled: true, surge_multiplier: 1.33 });
    expect(computeAreaQuote(area, 999, now).totalCents).toBe(Math.round(999 * 1.33));
  });
});

describe('validation & helpers', () => {
  const valid: ServiceAreaInput = {
    name: 'North',
    color: '#22c55e',
    zoneType: 'zip',
    zipCodes: ['78701'],
    polygon: null,
    isActive: true,
    priority: 0,
    travelFeeCents: 1000,
    surgeEnabled: false,
    surgeMultiplier: 1,
    surgeEndsAt: null,
    notes: null,
    technicians: [],
  };

  it('accepts a valid input and rejects each invalid field', () => {
    expect(validateAreaInput(valid)).toBeNull();
    expect(validateAreaInput({ ...valid, name: '  ' })).toMatch(/name/i);
    expect(validateAreaInput({ ...valid, zipCodes: [] })).toMatch(/ZIP/);
    expect(validateAreaInput({ ...valid, zoneType: 'polygon', polygon: null })).toMatch(/polygon/i);
    expect(validateAreaInput({ ...valid, travelFeeCents: -1 })).toMatch(/Travel fee/);
    expect(validateAreaInput({ ...valid, surgeMultiplier: 9 })).toMatch(/Surge multiplier/);
    expect(validateAreaInput({ ...valid, priority: 1.5 })).toMatch(/Priority/);
  });

  it('finds zip overlaps with other zones but not itself', () => {
    const a = makeArea({ id: 'a', zip_codes: ['78701', '78702'] });
    const b = makeArea({ id: 'b', zip_codes: ['78702', '78703'] });
    const overlaps = findZipOverlaps([a, b], { id: 'b', zipCodes: ['78702', '78703'] });
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].shared).toEqual(['78702']);
  });

  it('uses the custom out-of-area message, falling back to the mode default', () => {
    expect(outOfAreaReply(null)).toBe(DEFAULT_OUT_OF_AREA_MESSAGES.waitlist);
    expect(outOfAreaReply({ out_of_area_mode: 'decline', out_of_area_message: null })).toBe(
      DEFAULT_OUT_OF_AREA_MESSAGES.decline,
    );
    expect(outOfAreaReply({ out_of_area_mode: 'decline', out_of_area_message: ' Sorry! ' })).toBe(
      'Sorry!',
    );
  });
});
