import { describe, it, expect } from 'vitest';
import {
  appendTrailPoint,
  buildVehicleViews,
  circleRing,
  clampRadius,
  computeBounds,
  filterViews,
  formatEta,
  geofenceCollection,
  groupTrails,
  isLateJob,
  metersBetween,
  pickTargetJob,
  routeCollection,
  summarizeLiveMap,
  trailCollection,
  vehicleState,
  type LiveRow,
  type MapJob,
  type MapTech,
  type MapVehicle,
} from './liveMap';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const vehicle = (o: Partial<MapVehicle> & { id: string }): MapVehicle => ({
  label: `Van ${o.id}`,
  status: 'active',
  assigned_technician_id: null,
  ...o,
});

const live = (o: Partial<LiveRow> & { vehicle_id: string }): LiveRow => ({
  latitude: 40.0,
  longitude: -74.0,
  speed_mph: 0,
  heading_deg: null,
  engine_state: 'off',
  fuel_pct: null,
  check_engine: false,
  last_fix_at: minAgo(1),
  stationary_since: null,
  reverse_geo: null,
  current_job_id: null,
  ...o,
});

const job = (o: Partial<MapJob> & { id: string }): MapJob => ({
  customer_name: `Customer ${o.id}`,
  service_type: 'HVAC',
  address: '1 Main St',
  scheduled_datetime: minAgo(-60),
  job_status: 'scheduled',
  assigned_technician_id: null,
  latitude: 40.05,
  longitude: -74.0,
  ...o,
});

const techs: MapTech[] = [
  { id: 't1', member_name: 'Ana Ruiz', member_email: 'ana@example.com' },
  { id: 't2', member_name: null, member_email: 'bo@example.com' },
];

describe('geometry', () => {
  it('computes distances in meters', () => {
    const d = metersBetween({ lat: 40, lng: -74 }, { lat: 40.01, lng: -74 });
    expect(Math.round(d / 100)).toBe(11); // ~1.11 km
  });

  it('builds a closed circle ring at the requested radius', () => {
    const center = { lat: 40, lng: -74 };
    const ring = circleRing(center, 150);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const [lng, lat] of ring.slice(0, -1)) {
      expect(Math.abs(metersBetween(center, { lat, lng }) - 150) < 2).toBe(true);
    }
  });

  it('clamps bad geofence radii', () => {
    expect(clampRadius(undefined)).toBe(150);
    expect(clampRadius(-5)).toBe(150);
    expect(clampRadius(5)).toBe(30);
    expect(clampRadius(99999)).toBe(1000);
    expect(clampRadius(200.4)).toBe(200);
  });

  it('computes bounds and ignores invalid points', () => {
    expect(computeBounds([])).toBeNull();
    expect(computeBounds([{ lat: 200, lng: 0 }])).toBeNull();
    expect(computeBounds([{ lat: 1, lng: 2 }, { lat: 3, lng: -4 }])).toEqual([[-4, 1], [2, 3]]);
  });
});

describe('vehicle state', () => {
  it('classifies moving, idling, stopped and offline', () => {
    expect(vehicleState({ speed_mph: 30, engine_state: 'on', last_fix_at: minAgo(1) }, NOW)).toBe('moving');
    expect(vehicleState({ speed_mph: 0, engine_state: 'idle', last_fix_at: minAgo(1) }, NOW)).toBe('idling');
    expect(vehicleState({ speed_mph: 0, engine_state: 'off', last_fix_at: minAgo(1) }, NOW)).toBe('stopped');
    expect(vehicleState({ speed_mph: 30, engine_state: 'on', last_fix_at: minAgo(20) }, NOW)).toBe('offline');
    expect(vehicleState({ speed_mph: 30, engine_state: 'on', last_fix_at: null }, NOW)).toBe('offline');
  });
});

describe('pickTargetJob', () => {
  const v = vehicle({ id: 'v1', assigned_technician_id: 't1' });

  it('prefers the live current job when it is open and on the map', () => {
    const jobs = [job({ id: 'a', assigned_technician_id: 't1' }), job({ id: 'b' })];
    expect(pickTargetJob(v, live({ vehicle_id: 'v1', current_job_id: 'b' }), jobs)?.id).toBe('b');
  });

  it('falls back to the technician job: en_route, then in_progress, then earliest scheduled', () => {
    const jobs = [
      job({ id: 'late', assigned_technician_id: 't1', scheduled_datetime: minAgo(-300) }),
      job({ id: 'soon', assigned_technician_id: 't1', scheduled_datetime: minAgo(-30) }),
    ];
    expect(pickTargetJob(v, live({ vehicle_id: 'v1' }), jobs)?.id).toBe('soon');
    jobs.push(job({ id: 'going', assigned_technician_id: 't1', job_status: 'en_route', scheduled_datetime: minAgo(-500) }));
    expect(pickTargetJob(v, live({ vehicle_id: 'v1' }), jobs)?.id).toBe('going');
  });

  it('ignores jobs without coordinates and vehicles without a technician', () => {
    const noCoords = [job({ id: 'x', assigned_technician_id: 't1', latitude: null, longitude: null })];
    expect(pickTargetJob(v, live({ vehicle_id: 'v1' }), noCoords)).toBeNull();
    expect(pickTargetJob(vehicle({ id: 'v2' }), live({ vehicle_id: 'v2' }), [job({ id: 'y', assigned_technician_id: 't1' })])).toBeNull();
  });
});

describe('buildVehicleViews', () => {
  const vehicles = [
    vehicle({ id: 'v1', label: 'B Van', assigned_technician_id: 't1' }),
    vehicle({ id: 'v2', label: 'A Van', assigned_technician_id: 't2' }),
    vehicle({ id: 'v3', label: 'No GPS' }),
    vehicle({ id: 'v4', label: 'Retired', status: 'retired' }),
  ];
  const rows = new Map([
    ['v1', live({ vehicle_id: 'v1', latitude: 40.0, longitude: -74.0, speed_mph: 25, engine_state: 'on' })],
    ['v2', live({ vehicle_id: 'v2', latitude: 40.05, longitude: -74.0005, last_fix_at: minAgo(2) })],
    ['v3', live({ vehicle_id: 'v3', latitude: null, longitude: null })],
  ]);
  const jobs = [job({ id: 'j1', assigned_technician_id: 't1' }), job({ id: 'j2', assigned_technician_id: 't2' })];
  const { views, unlocated } = buildVehicleViews(vehicles, rows, techs, jobs, NOW, 150);

  it('sorts by label, resolves technician names, and separates vehicles without a fix', () => {
    expect(views.map((v) => v.label)).toEqual(['A Van', 'B Van']);
    expect(views[0].techName).toBe('bo@example.com');
    expect(views[1].techName).toBe('Ana Ruiz');
    expect(unlocated.map((u) => u.label)).toEqual(['No GPS']);
  });

  it('computes ETA and distance for a vehicle heading to a job', () => {
    const v1 = views.find((v) => v.id === 'v1')!;
    expect(v1.onSite).toBe(false);
    expect(v1.distanceMiles).toBe(3.5);
    expect((v1.etaMinutes ?? 0) > 5).toBe(true);
  });

  it('marks a vehicle inside the geofence as on site with no ETA', () => {
    const v2 = views.find((v) => v.id === 'v2')!;
    expect(v2.onSite).toBe(true);
    expect(v2.etaMinutes).toBeNull();
  });

  it('gives no ETA when the GPS fix is stale', () => {
    const stale = new Map([['v1', live({ vehicle_id: 'v1', speed_mph: 25, last_fix_at: minAgo(30) })]]);
    const out = buildVehicleViews([vehicles[0]], stale, techs, jobs, NOW, 150).views[0];
    expect(out.etaMinutes).toBeNull();
    expect(out.state).toBe('offline');
  });

  it('filters and summarizes', () => {
    expect(filterViews(views, 'moving').map((v) => v.id)).toEqual(['v1']);
    expect(filterViews(views, 'idling').map((v) => v.id)).toEqual(['v2']);
    expect(filterViews(views, 'all')).toHaveLength(2);
    expect(summarizeLiveMap(views, jobs, NOW)).toMatchObject({ located: 2, moving: 1, idle: 1, offline: 0, openJobs: 2, lateJobs: 0, jobsNotOnMap: 0 });
  });
});

describe('jobs', () => {
  it('flags scheduled jobs that are more than 10 minutes past their start as late', () => {
    expect(isLateJob(job({ id: 'a', scheduled_datetime: minAgo(15) }), NOW)).toBe(true);
    expect(isLateJob(job({ id: 'b', scheduled_datetime: minAgo(5) }), NOW)).toBe(false);
    expect(isLateJob(job({ id: 'c', scheduled_datetime: minAgo(60), job_status: 'in_progress' }), NOW)).toBe(false);
    expect(isLateJob(job({ id: 'd', scheduled_datetime: null }), NOW)).toBe(false);
  });

  it('counts jobs without coordinates and skips them on the map', () => {
    const jobs = [job({ id: 'a' }), job({ id: 'b', latitude: null, longitude: null })];
    expect(summarizeLiveMap([], jobs, NOW).jobsNotOnMap).toBe(1);
    expect(geofenceCollection(jobs, 150).features).toHaveLength(1);
  });
});

describe('trails', () => {
  const rows = [
    { vehicle_id: 'v1', recorded_at: minAgo(1), latitude: 40.002, longitude: -74 },
    { vehicle_id: 'v1', recorded_at: minAgo(3), latitude: 40.001, longitude: -74 },
    { vehicle_id: 'v1', recorded_at: minAgo(3), latitude: 40.001, longitude: -74 },
    { vehicle_id: 'v1', recorded_at: 'garbage', latitude: 40, longitude: -74 },
    { vehicle_id: 'v2', recorded_at: minAgo(2), latitude: 999, longitude: -74 },
  ];

  it('groups, sorts ascending, de-duplicates and drops invalid rows', () => {
    const trails = groupTrails(rows);
    expect(trails.get('v1')?.map((p) => p.lat)).toEqual([40.001, 40.002]);
    expect(trails.has('v2')).toBe(false);
  });

  it('caps very long trails', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ vehicle_id: 'v1', recorded_at: new Date(NOW - i * 1000).toISOString(), latitude: 40 + i * 1e-5, longitude: -74 }));
    expect(groupTrails(many).get('v1')!.length).toBe(240);
  });

  it('appends realtime points but skips jitter, out-of-order and invalid points', () => {
    const base = [{ lat: 40, lng: -74, t: NOW - 60_000 }];
    expect(appendTrailPoint(base, { lat: 40.001, lng: -74, t: NOW }, NOW)).toHaveLength(2);
    expect(appendTrailPoint(base, { lat: 40.00001, lng: -74, t: NOW }, NOW)).toHaveLength(1);
    expect(appendTrailPoint(base, { lat: 40.001, lng: -74, t: NOW - 120_000 }, NOW)).toHaveLength(1);
    expect(appendTrailPoint(base, { lat: 500, lng: -74, t: NOW }, NOW)).toHaveLength(1);
  });

  it('drops points older than the trail window', () => {
    const old = [{ lat: 40, lng: -74, t: NOW - 3 * 3_600_000 }];
    expect(appendTrailPoint(old, { lat: 40.01, lng: -74, t: NOW }, NOW)).toHaveLength(1);
  });
});

describe('map collections', () => {
  const vehicles = [vehicle({ id: 'v1', assigned_technician_id: 't1' }), vehicle({ id: 'v2', assigned_technician_id: 't2' })];
  const rows = new Map([
    ['v1', live({ vehicle_id: 'v1', speed_mph: 20, engine_state: 'on' })],
    ['v2', live({ vehicle_id: 'v2', latitude: 40.05, longitude: -74.0 })],
  ]);
  const jobs = [job({ id: 'j1', assigned_technician_id: 't1' }), job({ id: 'j2', assigned_technician_id: 't2' })];
  const { views } = buildVehicleViews(vehicles, rows, techs, jobs, NOW, 150);

  it('draws a route only for vehicles that are en route (not on site, not offline)', () => {
    const routes = routeCollection(views);
    expect(routes.features).toHaveLength(1);
    expect(routes.features[0].properties).toEqual({ vehicleId: 'v1' });
  });

  it('emits trail lines only for visible vehicles with at least two points', () => {
    const trails = new Map([
      ['v1', [{ lat: 40, lng: -74, t: 1 }, { lat: 40.1, lng: -74, t: 2 }]],
      ['v2', [{ lat: 40, lng: -74, t: 1 }]],
      ['v9', [{ lat: 40, lng: -74, t: 1 }, { lat: 40.1, lng: -74, t: 2 }]],
    ]);
    const out = trailCollection(trails, new Set(['v1', 'v2']), 'v1');
    expect(out.features).toHaveLength(1);
    expect(out.features[0].properties).toEqual({ vehicleId: 'v1', selected: true });
  });
});

describe('formatEta', () => {
  it('formats minutes and hours', () => {
    expect(formatEta(null)).toBe('—');
    expect(formatEta(12)).toBe('12 min');
    expect(formatEta(60)).toBe('1 h');
    expect(formatEta(95)).toBe('1 h 35 min');
  });
});
