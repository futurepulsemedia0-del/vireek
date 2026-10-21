import { describe, it, expect } from 'vitest';
import {
  EXIT_CONFIRM_MS, STALE_ACTION_MS, estimateEtaMinutes, formatEtaMinutes, haversineMeters, insideZone, normalizeAutomations,
  parseZone, pickZoneJob, planActions, pointInPolygon, renderEtaMessage, signedDistanceM, stepZones,
  type LngLat, type Zone, type ZoneJobCandidate, type ZoneStateMap, type ZoneTransition,
} from './zones';

const HOME = { lat: 30.2672, lng: -97.7431 };
const at = (dLat: number) => ({ lat: HOME.lat + dLat, lng: HOME.lng });
const fix = (t: number, p: { lat: number; lng: number }) => ({ t, lat: p.lat, lng: p.lng });

const circle = (o: Partial<Zone> = {}): Zone => ({
  id: 'z1', name: 'Shop', type: 'shop', shape: 'circle', lat: HOME.lat, lng: HOME.lng, radiusM: 150, polygon: null,
  dwellSeconds: 60, exitBufferM: 30, jobId: null, automations: {}, ...o,
});

// ~222 m x ~222 m square centered on HOME (0.001 deg lat ~ 111 m)
const SQUARE: LngLat[] = [
  [HOME.lng - 0.001, HOME.lat - 0.001], [HOME.lng + 0.001, HOME.lat - 0.001],
  [HOME.lng + 0.001, HOME.lat + 0.001], [HOME.lng - 0.001, HOME.lat + 0.001],
];
const square = (o: Partial<Zone> = {}): Zone => circle({ id: 'p1', shape: 'polygon', polygon: SQUARE, radiusM: 160, ...o });

describe('geometry', () => {
  it('point in polygon handles inside, outside and concave shapes', () => {
    expect(pointInPolygon(HOME, SQUARE)).toBe(true);
    expect(pointInPolygon(at(0.01), SQUARE)).toBe(false);
    const L: LngLat[] = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
    expect(pointInPolygon({ lng: 0.5, lat: 1.5 }, L)).toBe(true);
    expect(pointInPolygon({ lng: 1.5, lat: 1.5 }, L)).toBe(false); // the notch
  });

  it('signed distance is negative inside and positive outside, for circles and polygons', () => {
    expect(signedDistanceM(HOME, circle())).toBeCloseTo(-150, 0);
    expect(signedDistanceM(at(0.002), circle())).toBeGreaterThan(0); // ~222 m from center, radius 150
    expect(signedDistanceM(HOME, square())).toBeLessThan(0);
    expect(signedDistanceM(at(0.002), square())).toBeGreaterThan(0);
  });

  it('polygon edge distance is about right', () => {
    // 0.0005 deg north of the north edge (0.001) -> ~55 m outside
    const d = signedDistanceM(at(0.0015), square());
    expect(d).toBeGreaterThan(50);
    expect(d).toBeLessThan(60);
  });

  it('insideZone matches signed distance', () => {
    expect(insideZone(HOME, circle())).toBe(true);
    expect(insideZone(at(0.01), circle())).toBe(false);
  });

  it('haversine sanity', () => {
    expect(haversineMeters(HOME, at(0.001))).toBeCloseTo(111.2, 0);
  });
});

describe('parseZone', () => {
  const row = { id: 'a', name: 'Yard', geofence_type: 'depot', shape: 'circle', latitude: 30, longitude: -97, radius_meters: 200, dwell_seconds: 30, exit_buffer_m: 20, automations: { clock_in: { enabled: true } } };

  it('parses a circle and clamps numbers', () => {
    const z = parseZone({ ...row, dwell_seconds: 99999, exit_buffer_m: -5 });
    expect(z).toMatchObject({ id: 'a', shape: 'circle', radiusM: 200, dwellSeconds: 900, exitBufferM: 0 });
    expect(z?.automations.clock_in?.enabled).toBe(true);
  });

  it('rejects malformed rows instead of throwing', () => {
    expect(parseZone({ ...row, latitude: 'x' })).toBeNull();
    expect(parseZone({ ...row, latitude: 91 })).toBeNull();
    expect(parseZone({ ...row, radius_meters: 0 })).toBeNull();
    expect(parseZone({ ...row, shape: 'polygon', polygon: [[0, 0], [1, 1]] })).toBeNull();
    expect(parseZone({ ...row, shape: 'polygon', polygon: [[0, 0], [1, 1], ['a', 2]] })).toBeNull();
    expect(parseZone({ ...row, id: undefined })).toBeNull();
  });

  it('parses a polygon and falls back for unknown types', () => {
    const z = parseZone({ ...row, shape: 'polygon', geofence_type: 'weird', polygon: SQUARE });
    expect(z?.shape).toBe('polygon');
    expect(z?.type).toBe('customer_site');
    expect(z?.polygon).toHaveLength(4);
  });

  it('normalizes automations and ignores unknown / disabled keys', () => {
    expect(normalizeAutomations(null)).toEqual({});
    expect(normalizeAutomations({ arrived: { enabled: false }, bogus: { enabled: true }, exit_alert: { enabled: true } })).toEqual({ exit_alert: { enabled: true } });
    expect(normalizeAutomations({ eta_text: { enabled: true, template: '  ' } })).toEqual({ eta_text: { enabled: true } });
    expect(normalizeAutomations({ eta_text: { enabled: true, template: 'x'.repeat(500) } }).eta_text?.template).toHaveLength(320);
  });
});

describe('stepZones', () => {
  it('confirms an enter only after the dwell and reports the FIRST inside fix as the time', () => {
    const z = circle();
    const s1 = stepZones(fix(0, at(0.0005)), [z], {});
    expect(s1.transitions).toHaveLength(0);
    expect(s1.state.z1).toEqual({ in: false, pe: 0, cold: true });
    const s2 = stepZones(fix(61_000, at(0.0004)), [z], s1.state);
    expect(s2.transitions).toEqual([{ zoneId: 'z1', kind: 'enter', at: 0, distanceM: expect.any(Number), coldStart: true }]);
    expect(s2.state.z1).toEqual({ in: true });
  });

  it('cancels a drive-by shorter than the dwell', () => {
    const z = circle();
    const s1 = stepZones(fix(0, at(0.0005)), [z], {});
    const s2 = stepZones(fix(20_000, at(0.01)), [z], s1.state);
    expect(s2.transitions).toHaveLength(0);
    expect(s2.state.z1).toEqual({ in: false });
  });

  it('enters immediately when dwell is 0', () => {
    const r = stepZones(fix(5, HOME), [circle({ dwellSeconds: 0 })], {});
    expect(r.transitions).toHaveLength(1);
  });

  it('is not a cold start when the vehicle was seen outside first, even with a dwell', () => {
    const z = circle();
    const out = stepZones(fix(0, at(0.01)), [z], {});
    const p1 = stepZones(fix(10_000, HOME), [z], out.state);
    const p2 = stepZones(fix(75_000, HOME), [z], p1.state);
    expect(p2.transitions[0]).toMatchObject({ kind: 'enter', at: 10_000, coldStart: false });
  });

  it('a drive-by that cancels the pending enter clears the cold flag', () => {
    const z = circle();
    const p1 = stepZones(fix(0, HOME), [z], {});
    const p2 = stepZones(fix(10_000, at(0.01)), [z], p1.state);
    expect(p2.state.z1).toEqual({ in: false });
  });

  it('is not a cold start when the vehicle was seen outside first (no dwell)', () => {
    const z = circle({ dwellSeconds: 0 });
    const out = stepZones(fix(0, at(0.01)), [z], {});
    const inn = stepZones(fix(60_000, HOME), [z], out.state);
    expect(inn.transitions[0].coldStart).toBe(false);
  });

  it('does not exit at the edge (hysteresis) and exits only after the confirm time beyond the buffer', () => {
    const z = circle({ dwellSeconds: 0 });
    let st: ZoneStateMap = stepZones(fix(0, HOME), [z], {}).state;
    // ~165 m: outside radius 150 but within radius + 30 buffer
    const edge = stepZones(fix(1_000, at(0.0015)), [z], st);
    expect(edge.transitions).toHaveLength(0);
    expect(edge.state.z1.px).toBeUndefined();
    // ~333 m: beyond the buffer, starts the confirm timer
    const far1 = stepZones(fix(2_000, at(0.003)), [z], edge.state);
    expect(far1.transitions).toHaveLength(0);
    expect(far1.state.z1.px).toBe(2_000);
    const far2 = stepZones(fix(2_000 + EXIT_CONFIRM_MS, at(0.003)), [z], far1.state);
    expect(far2.transitions).toEqual([{ zoneId: 'z1', kind: 'exit', at: 2_000, distanceM: expect.any(Number), coldStart: false }]);
    expect(far2.state.z1).toEqual({ in: false });
  });

  it('a single outlier fix far away does not produce an exit', () => {
    const z = circle({ dwellSeconds: 0 });
    let st = stepZones(fix(0, HOME), [z], {}).state;
    st = stepZones(fix(1_000, at(0.05)), [z], st).state; // GPS glitch
    const back = stepZones(fix(30_000, HOME), [z], st);
    expect(back.transitions).toHaveLength(0);
    expect(back.state.z1).toEqual({ in: true });
  });

  it('works for polygons', () => {
    const z = square({ dwellSeconds: 0, exitBufferM: 10 });
    let r = stepZones(fix(0, at(0.01)), [z], {});
    r = stepZones(fix(10_000, HOME), [z], r.state);
    expect(r.transitions.map((t) => t.kind)).toEqual(['enter']);
    r = stepZones(fix(20_000, at(0.01)), [z], r.state);
    r = stepZones(fix(20_000 + EXIT_CONFIRM_MS, at(0.01)), [z], r.state);
    expect(r.transitions.map((t) => t.kind)).toEqual(['exit']);
  });

  it('tracks several zones independently and drops state for deleted zones', () => {
    const a = circle({ id: 'a', dwellSeconds: 0 });
    const b = circle({ id: 'b', lat: HOME.lat + 0.05, dwellSeconds: 0 });
    const r = stepZones(fix(0, HOME), [a, b], { gone: { in: true } });
    expect(r.transitions.map((t) => t.zoneId)).toEqual(['a']);
    expect(Object.keys(r.state).sort()).toEqual(['a', 'b']);
  });

  it('overlapping zones both fire', () => {
    const a = circle({ id: 'a', dwellSeconds: 0 });
    const b = circle({ id: 'b', radiusM: 400, dwellSeconds: 0 });
    expect(stepZones(fix(0, HOME), [a, b], {}).transitions).toHaveLength(2);
  });
});

describe('planActions', () => {
  const now = 1_000_000_000;
  const enter = (o: Partial<ZoneTransition> = {}): ZoneTransition => ({ zoneId: 'z1', kind: 'enter', at: now - 1000, distanceM: 10, coldStart: false, ...o });
  const exit = (o: Partial<ZoneTransition> = {}): ZoneTransition => enter({ kind: 'exit', ...o });
  const all = { arrived: { enabled: true }, clock_in: { enabled: true }, eta_text: { enabled: true }, exit_alert: { enabled: true } };

  it('plans enter actions in order and ignores exit_alert on enter', () => {
    expect(planActions(circle({ automations: all }), enter(), now).map((a) => a.kind)).toEqual(['arrived', 'clock_in', 'eta_text']);
  });

  it('plans only the exit alert on exit', () => {
    expect(planActions(circle({ automations: all }), exit(), now)).toEqual([{ kind: 'exit_alert' }]);
  });

  it('plans nothing when no automation is enabled', () => {
    expect(planActions(circle(), enter(), now)).toEqual([]);
  });

  it('skips the ETA text on a cold start but still clocks in', () => {
    const plan = planActions(circle({ automations: all }), enter({ coldStart: true }), now);
    expect(plan.find((a) => a.kind === 'eta_text')?.skip).toBe('already_inside');
    expect(plan.find((a) => a.kind === 'clock_in')?.skip).toBeUndefined();
  });

  it('skips everything for stale (replayed) transitions', () => {
    const plan = planActions(circle({ automations: all }), enter({ at: now - STALE_ACTION_MS - 1 }), now);
    expect(plan.every((a) => a.skip === 'stale_event')).toBe(true);
    expect(planActions(circle({ automations: all }), exit({ at: now - STALE_ACTION_MS - 1 }), now)[0].skip).toBe('stale_event');
  });
});

describe('pickZoneJob', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const job = (id: string, dLat: number, minFromNow: number | null, status = 'scheduled'): ZoneJobCandidate => ({
    id, lat: HOME.lat + dLat, lng: HOME.lng, scheduledMs: minFromNow === null ? null : now + minFromNow * 60_000, status,
  });

  it('prefers the zone linked job', () => {
    expect(pickZoneJob(circle({ jobId: 'b' }), [job('a', 0, 0), job('b', 0.5, 0)], now)?.id).toBe('b');
    expect(pickZoneJob(circle({ jobId: 'missing' }), [job('a', 0, 0)], now)).toBeNull();
  });

  it('otherwise picks the job inside the zone closest in time', () => {
    const jobs = [job('far', 0.5, 0), job('later', 0.0002, 180), job('soon', 0.0003, 10)];
    expect(pickZoneJob(circle(), jobs, now)?.id).toBe('soon');
  });

  it('returns null when no job is inside', () => {
    expect(pickZoneJob(circle(), [job('far', 0.5, 0)], now)).toBeNull();
  });

  it('puts unscheduled jobs last', () => {
    expect(pickZoneJob(circle(), [job('none', 0.0001, null), job('sched', 0.0002, 500)], now)?.id).toBe('sched');
  });
});

describe('ETA text', () => {
  it('estimates conservatively and clamps', () => {
    expect(estimateEtaMinutes(0, null)).toBe(1);
    expect(estimateEtaMinutes(5_000, 0)).toBe(Math.round((5_000 * 1.3) / (18 * 26.8224))); // speed floor 18 mph
    expect(estimateEtaMinutes(5_000, 120)).toBe(Math.round((5_000 * 1.3) / (45 * 26.8224))); // speed cap 45 mph
    expect(estimateEtaMinutes(10_000_000, 30)).toBe(180);
    expect(estimateEtaMinutes(5_000, Number.NaN)).toBeGreaterThan(0);
  });

  it('formats minutes', () => {
    expect(formatEtaMinutes(12)).toBe('12 min');
    expect(formatEtaMinutes(60)).toBe('1 h');
    expect(formatEtaMinutes(95)).toBe('1 h 35 min');
  });

  const vars = { customer: 'Maria', tech: 'Alex', company: 'Acme HVAC', eta: '12 min', link: 'Track live: https://x.co/t/1' };

  it('renders the default template', () => {
    expect(renderEtaMessage(undefined, vars)).toBe('Hi Maria, Alex from Acme HVAC is about 12 min away. Track live: https://x.co/t/1');
  });

  it('removes unknown placeholders and tidies spacing when the link is empty', () => {
    expect(renderEtaMessage('Hi {customer}, {eta} out {bogus} .', { ...vars, link: '' })).toBe('Hi Maria, 12 min out.');
    expect(renderEtaMessage('{tech} is close. {link}', { ...vars, link: '' })).toBe('Alex is close.');
  });

  it('caps the message at 320 characters', () => {
    expect(renderEtaMessage('x'.repeat(1000), vars)).toHaveLength(320);
  });

  it('never executes placeholder-looking input from customer data as a template', () => {
    expect(renderEtaMessage('Hi {customer}', { ...vars, customer: '{tech}' })).toBe('Hi {tech}');
  });
});
