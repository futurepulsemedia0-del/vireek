import { describe, it, expect } from 'vitest';
import {
  ZONE_TYPES, ZONE_TYPE_META, automationsFromJson, automationsToJson, boundingRadiusM, clampRadiusM, defaultAutomations, describeAutomations,
  draftCollection, draftFromGeofence, draftToRow, formatArea, formatDistance, insertVertex, isDraftValid, isSelfIntersecting,
  newDraft, pointInGeofence, pointInPolygon, polygonAreaM2, polygonCentroid, previewEtaTemplate, radiusHandlePoint, relativeTime,
  removeVertex, rowToGeofence, summarizeActions, unknownPlaceholders, validateDraft, zoneCollection, zoneLabelCollection,
  type Geofence, type GeofenceDraft, type LngLat,
} from './geofences';
import { metersBetween } from './liveMap';

const HOME = { lat: 30.2672, lng: -97.7431 };
// ~222 m square around HOME
const SQUARE: LngLat[] = [
  [HOME.lng - 0.001, HOME.lat - 0.001], [HOME.lng + 0.001, HOME.lat - 0.001],
  [HOME.lng + 0.001, HOME.lat + 0.001], [HOME.lng - 0.001, HOME.lat + 0.001],
];
const BOWTIE: LngLat[] = [[0, 0], [0.002, 0.002], [0.002, 0], [0, 0.002]];

const circleDraft = (o: Partial<GeofenceDraft> = {}): GeofenceDraft => ({ ...newDraft('circle', 'shop'), name: 'Shop', center: HOME, radiusM: 200, ...o });
const polyDraft = (o: Partial<GeofenceDraft> = {}): GeofenceDraft => ({ ...newDraft('polygon', 'service_area'), name: 'Metro', polygon: SQUARE, ...o });

describe('geometry', () => {
  it('computes polygon area', () => {
    const a = polygonAreaM2(SQUARE);
    expect(a).toBeGreaterThan(42_000);
    expect(a).toBeLessThan(43_700); // ~222 m x ~192 m at this latitude
    expect(polygonAreaM2(SQUARE.slice(0, 2))).toBe(0);
  });

  it('finds the centroid of a square at its center', () => {
    const c = polygonCentroid(SQUARE);
    expect(c.lat).toBeCloseTo(HOME.lat, 5);
    expect(c.lng).toBeCloseTo(HOME.lng, 5);
  });

  it('centroid falls back to the mean for degenerate rings', () => {
    const c = polygonCentroid([[0, 0], [1, 1], [2, 2]]);
    expect(Number.isFinite(c.lat) && Number.isFinite(c.lng)).toBe(true);
  });

  it('bounding radius reaches the farthest vertex', () => {
    expect(boundingRadiusM(SQUARE, HOME)).toBeGreaterThan(140);
    expect(boundingRadiusM(SQUARE, HOME)).toBeLessThan(170);
  });

  it('detects self-intersection (bow-tie) but not simple or concave shapes', () => {
    expect(isSelfIntersecting(BOWTIE)).toBe(true);
    expect(isSelfIntersecting(SQUARE)).toBe(false);
    expect(isSelfIntersecting([[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]])).toBe(false);
    expect(isSelfIntersecting([[0, 0], [1, 0], [0, 1]])).toBe(false);
  });

  it('point in polygon / geofence', () => {
    expect(pointInPolygon(HOME, SQUARE)).toBe(true);
    expect(pointInPolygon({ lat: HOME.lat + 0.01, lng: HOME.lng }, SQUARE)).toBe(false);
    const c: Geofence = { ...rowToGeofence({ id: 'a', name: 'c', geofence_type: 'shop', latitude: HOME.lat, longitude: HOME.lng, radius_meters: 150 })! };
    expect(pointInGeofence(HOME, c)).toBe(true);
    expect(pointInGeofence({ lat: HOME.lat + 0.01, lng: HOME.lng }, c)).toBe(false);
  });

  it('inserts and removes vertices safely', () => {
    expect(insertVertex(SQUARE, 1, [9, 9])[1]).toEqual([9, 9]);
    expect(insertVertex(SQUARE, 99, [9, 9]).at(-1)).toEqual([9, 9]);
    expect(removeVertex(SQUARE, 0)).toHaveLength(3);
    expect(removeVertex(SQUARE.slice(0, 3), 0)).toHaveLength(3); // never below 3 points
  });

  it('radius handle sits one radius east of the center', () => {
    const [lng, lat] = radiusHandlePoint(HOME, 300);
    expect(lat).toBe(HOME.lat);
    expect(metersBetween(HOME, { lat, lng })).toBeCloseTo(300, 0);
  });

  it('clamps radii', () => {
    expect(clampRadiusM(1)).toBe(25);
    expect(clampRadiusM(999_999)).toBe(100_000);
    expect(clampRadiusM(150.6)).toBe(151);
  });

  it('formats distance and area', () => {
    expect(formatDistance(150)).toBe('150 m');
    expect(formatDistance(2_500)).toBe('2.5 km (1.6 mi)');
    expect(formatArea(5_000)).toBe('5,000 m²');
    expect(formatArea(2_500_000)).toBe('2.50 km²');
  });
});

describe('automations', () => {
  it('round-trips through jsonb and drops disabled ones', () => {
    const a = { arrived: true, clock_in: false, eta_text: true, exit_alert: false, eta_template: '  On the way {eta}  ' };
    expect(automationsToJson(a)).toEqual({ arrived: { enabled: true }, eta_text: { enabled: true, template: 'On the way {eta}' } });
    expect(automationsFromJson(automationsToJson(a))).toEqual({ ...a, clock_in: false, exit_alert: false, eta_template: 'On the way {eta}' });
  });

  it('is defensive about bad json', () => {
    expect(automationsFromJson(null)).toEqual({ arrived: false, clock_in: false, eta_text: false, exit_alert: false, eta_template: '' });
    expect(automationsFromJson({ arrived: { enabled: 'yes' } }).arrived).toBe(false);
  });

  it('has sensible presets per zone type', () => {
    expect(defaultAutomations('shop').clock_in).toBe(true);
    expect(defaultAutomations('job_site').arrived).toBe(true);
    expect(defaultAutomations('customer_site').eta_text).toBe(true);
    expect(defaultAutomations('service_area').exit_alert).toBe(true);
    expect(describeAutomations(defaultAutomations('depot'))).toEqual([]);
    expect(ZONE_TYPES).toHaveLength(6);
    expect(Object.keys(ZONE_TYPE_META)).toEqual(ZONE_TYPES);
  });

  it('describes enabled automations', () => {
    expect(describeAutomations({ ...defaultAutomations('shop'), exit_alert: true })).toEqual(['Auto clock-in', 'Exit alert']);
  });
});

describe('ETA template', () => {
  it('finds unknown placeholders', () => {
    expect(unknownPlaceholders('Hi {customer} {eta} {nope} {nope} {link}')).toEqual(['nope']);
    expect(unknownPlaceholders('plain')).toEqual([]);
  });

  it('previews the default and a custom template', () => {
    expect(previewEtaTemplate('')).toContain('is about 12 min away');
    expect(previewEtaTemplate('{tech} arrives in {eta} {bogus}')).toBe('Alex arrives in 12 min');
  });
});

describe('validateDraft', () => {
  it('accepts a good circle and a good polygon', () => {
    expect(validateDraft(circleDraft())).toEqual({});
    expect(isDraftValid(polyDraft())).toBe(true);
  });

  it('requires a name', () => {
    expect(validateDraft(circleDraft({ name: '   ' })).name).toBeTruthy();
    expect(validateDraft(circleDraft({ name: 'x'.repeat(81) })).name).toBeTruthy();
  });

  it('requires a center and a sane radius for circles', () => {
    expect(validateDraft(circleDraft({ center: null })).shape).toBeTruthy();
    expect(validateDraft(circleDraft({ radiusM: 10 })).radius).toBeTruthy();
    expect(validateDraft(circleDraft({ radiusM: 100_001 })).radius).toBeTruthy();
    expect(validateDraft(circleDraft({ radiusM: Number.NaN })).radius).toBeTruthy();
  });

  it('rejects bad polygons', () => {
    expect(validateDraft(polyDraft({ polygon: SQUARE.slice(0, 2) })).shape).toMatch(/at least 3/);
    expect(validateDraft(polyDraft({ polygon: BOWTIE })).shape).toMatch(/cross/);
    const tiny = SQUARE.map(([x, y]) => [HOME.lng + (x - HOME.lng) / 100, HOME.lat + (y - HOME.lat) / 100] as LngLat);
    expect(validateDraft(polyDraft({ polygon: tiny })).shape).toMatch(/too small/);
    expect(validateDraft(polyDraft({ polygon: [[0, 0], [200, 0], [0, 5]] })).shape).toBeTruthy();
    const huge: LngLat[] = [[-100, 30], [-98, 30], [-98, 32], [-100, 32]];
    expect(validateDraft(polyDraft({ polygon: huge })).shape).toMatch(/too large/);
    const many = Array.from({ length: 201 }, (_, i) => [HOME.lng + Math.cos(i) * 0.001, HOME.lat + Math.sin(i) * 0.001] as LngLat);
    expect(validateDraft(polyDraft({ polygon: many })).shape).toBeTruthy();
  });

  it('validates tuning fields and the ETA template only when enabled', () => {
    expect(validateDraft(circleDraft({ dwellSeconds: 901 })).dwell).toBeTruthy();
    expect(validateDraft(circleDraft({ exitBufferM: -1 })).buffer).toBeTruthy();
    const bad = { ...defaultAutomations('customer_site'), eta_template: 'Hi {oops}' };
    expect(validateDraft(circleDraft({ automations: bad })).template).toMatch(/\{oops\}/);
    expect(validateDraft(circleDraft({ automations: { ...bad, eta_text: false } })).template).toBeUndefined();
    expect(validateDraft(circleDraft({ automations: { ...bad, eta_template: 'x'.repeat(321) } })).template).toMatch(/under 320/);
  });
});

describe('draftToRow / rowToGeofence', () => {
  it('maps a circle', () => {
    const row = draftToRow(circleDraft({ name: '  Shop  ', radiusM: 200.4, notes: '  ' }));
    expect(row).toMatchObject({ name: 'Shop', geofence_type: 'shop', shape: 'circle', radius_meters: 200, polygon: null, notes: null, active: true });
    expect(row.latitude).toBeCloseTo(HOME.lat, 6);
    expect(row.automations).toEqual({ clock_in: { enabled: true } });
  });

  it('maps a polygon with centroid and enclosing radius', () => {
    const row = draftToRow(polyDraft());
    expect(row.shape).toBe('polygon');
    expect(row.polygon).toHaveLength(4);
    expect(row.latitude).toBeCloseTo(HOME.lat, 5);
    expect(row.radius_meters).toBeGreaterThanOrEqual(145);
    expect(row.radius_meters).toBeLessThanOrEqual(155);
  });

  it('round-trips a saved zone back into an equal draft', () => {
    const row = { id: 'z', ...draftToRow(polyDraft({ automations: { ...defaultAutomations('service_area'), eta_text: true, eta_template: 'Hey {eta}' } })) };
    const g = rowToGeofence(row)!;
    expect(g.shape).toBe('polygon');
    const back = draftFromGeofence(g);
    expect(back.polygon).toEqual(row.polygon);
    expect(back.automations.eta_template).toBe('Hey {eta}');
    expect(back.id).toBe('z');
  });

  it('rowToGeofence drops malformed rows and repairs bad fields', () => {
    expect(rowToGeofence({ id: 'a', name: 'x', geofence_type: 'shop', latitude: Number.NaN, longitude: 1, radius_meters: 100 })).toBeNull();
    expect(rowToGeofence({ id: 'a', name: 'x', geofence_type: 'shop', shape: 'polygon', latitude: 1, longitude: 1, radius_meters: 100, polygon: 'nope' })).toBeNull();
    expect(rowToGeofence({ id: 'a', name: 'x', geofence_type: 'shop', shape: 'polygon', latitude: 1, longitude: 1, radius_meters: 100, polygon: [[0, 0], [1, 1]] })).toBeNull();
    const g = rowToGeofence({ id: 'a', name: '  ', geofence_type: 'weird', latitude: 1, longitude: 1, radius_meters: 100, color: 'red', active: null })!;
    expect(g).toMatchObject({ name: 'Untitled zone', type: 'customer_site', color: ZONE_TYPE_META.customer_site.color, active: true, shape: 'circle' });
  });

  it('legacy rows (no shape column values) load as circles', () => {
    expect(rowToGeofence({ id: 'a', name: 'Yard', geofence_type: 'depot', latitude: 1, longitude: 2, radius_meters: 200 })?.shape).toBe('circle');
  });
});

describe('GeoJSON builders', () => {
  const zones = [
    rowToGeofence({ id: 'a', name: 'A', geofence_type: 'shop', latitude: HOME.lat, longitude: HOME.lng, radius_meters: 150 })!,
    rowToGeofence({ id: 'b', ...draftToRow(polyDraft()) })!,
  ];

  it('builds closed polygons, marks the selected zone and hides the edited one', () => {
    const all = zoneCollection(zones, 'a', null);
    expect(all.features).toHaveLength(2);
    expect(all.features[0].properties.selected).toBe(true);
    const ring = (all.features[1].geometry as { coordinates: LngLat[][] }).coordinates[0];
    expect(ring[0]).toEqual(ring.at(-1));
    expect(zoneCollection(zones, null, 'a').features.map((f) => f.properties.id)).toEqual(['b']);
    expect(zoneLabelCollection(zones, 'b').features).toHaveLength(1);
  });

  it('previews the draft as it is drawn', () => {
    expect(draftCollection(null).features).toHaveLength(0);
    expect(draftCollection(newDraft('circle')).features).toHaveLength(0);
    expect(draftCollection(circleDraft()).features[0].geometry.type).toBe('Polygon');
    expect(draftCollection(polyDraft({ polygon: SQUARE.slice(0, 1) })).features).toHaveLength(0);
    expect(draftCollection(polyDraft({ polygon: SQUARE.slice(0, 2) })).features[0].geometry.type).toBe('LineString');
    expect(draftCollection(polyDraft()).features[0].geometry.type).toBe('Polygon');
  });
});

describe('activity feed', () => {
  it('summarizes automation outcomes with human reasons', () => {
    expect(summarizeActions(null)).toBe('No automations');
    expect(summarizeActions([])).toBe('No automations');
    expect(summarizeActions([
      { action: 'clock_in', status: 'done' },
      { action: 'eta_text', status: 'skipped', detail: 'opted_out' },
      { action: 'arrived', status: 'failed', detail: 'boom' },
      { action: 'exit_alert', status: 'skipped' },
    ])).toBe('Clock-in ✓ · ETA text skipped (opted out) · Arrived failed (boom) · Exit alert skipped');
  });

  it('formats relative time', () => {
    const now = Date.parse('2026-10-18T12:00:00Z');
    expect(relativeTime('2026-10-18T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-10-18T11:30:00Z', now)).toBe('30 min ago');
    expect(relativeTime('2026-10-18T07:00:00Z', now)).toBe('5 h ago');
    expect(relativeTime('2026-10-16T12:00:00Z', now)).toBe('2 d ago');
    expect(relativeTime('garbage', now)).toBe('');
  });
});
