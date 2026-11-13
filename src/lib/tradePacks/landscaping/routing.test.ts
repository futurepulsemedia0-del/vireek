import { describe, it, expect } from 'vitest';
import { rerouteDay, validateManualOrder, moveStop, redistributeStops, equipmentConflicts, timeline, type DayStop } from './routing.ts';

// Stops along a line east of the yard (lng grows ⇒ farther). 0.1° lng ≈ 8 km at 40°N.
const s = (id: string, lng: number, state: DayStop['state'] = 'planned', minutes = 30): DayStop => ({ id, lat: 40, lng, minutes, state });
const yard = { lat: 40, lng: 0 };
const opts = { start: yard, workdayMinutes: 480, speedKmh: 40 };

describe('landscaping routing: day-of re-route', () => {
  it('orders planned stops nearest-first from the yard', () => {
    const r = rerouteDay([s('far', 0.3), s('near', 0.1), s('mid', 0.2)], opts);
    expect(r.order).toEqual(['near', 'mid', 'far']);
    expect(r.changed).toBe(true);
  });
  it('is stable: re-routing an already optimal order changes nothing, twice', () => {
    const once = rerouteDay([s('far', 0.3), s('near', 0.1), s('mid', 0.2)], opts);
    const again = rerouteDay(once.order.map((id) => s(id, { near: 0.1, mid: 0.2, far: 0.3 }[id] as number)), opts);
    expect(again.order).toEqual(once.order);
    expect(again.changed).toBe(false);
  });
  it('never moves finished or in-progress stops and plans from where the crew is', () => {
    const stops = [s('d1', 0.3, 'done'), s('sk', 0.25, 'skipped'), s('now', 0.28, 'in_progress'), s('a', 0.0), s('b', 0.27), s('c', 0.9)];
    const r = rerouteDay(stops, opts);
    expect(r.order.slice(0, 3)).toEqual(['d1', 'sk', 'now']);
    expect(r.order.slice(3)).toEqual(['b', 'a', 'c']); // nearest to the in-progress stop (0.28) first
  });
  it('a weather-skipped stop leaves the plan and the rest closes the gap', () => {
    const r = rerouteDay([s('a', 0.1), s('b', 0.2, 'skipped'), s('c', 0.25)], opts);
    expect(r.order).toEqual(['b', 'c', 'a']); // finished stop first, then nearest to where the crew is
    expect(r.order.length).toBe(3);
  });
  it('returns overflow instead of dropping stops when the day is full', () => {
    const r = rerouteDay([s('a', 0.1, 'planned', 200), s('b', 0.2, 'planned', 200), s('c', 0.3, 'planned', 200)], { ...opts, workdayMinutes: 450 });
    expect(r.overflow.length).toBeGreaterThan(0);
    expect([...r.order].sort()).toEqual(['a', 'b', 'c']);
  });
  it('stops without coordinates are kept (no crash)', () => {
    const r = rerouteDay([{ id: 'x', lat: null, lng: null, minutes: 20, state: 'planned' }, s('a', 0.1)], opts);
    expect([...r.order].sort()).toEqual(['a', 'x']);
  });
});

describe('landscaping routing: manual re-order', () => {
  const day = [s('d', 0.1, 'done'), s('p', 0.2, 'in_progress'), s('a', 0.3), s('b', 0.4), s('c', 0.5)];
  it('moves a planned stop but never before locked stops', () => {
    expect(moveStop(day, 'c', 2)).toEqual(['d', 'p', 'c', 'a', 'b']);
    expect(() => moveStop(day, 'c', 1)).toThrow(/Invalid position/);
    expect(() => moveStop(day, 'd', 4)).toThrow(/Only planned/);
    expect(() => moveStop(day, 'zzz', 2)).toThrow(/not found/);
  });
  it('validates proposed orders: same set, no duplicates, locked prefix intact', () => {
    expect(validateManualOrder(day, ['d', 'p', 'b', 'a', 'c'])).toEqual([]);
    expect(validateManualOrder(day, ['d', 'p', 'b', 'a'])[0]).toMatch(/every stop/);
    expect(validateManualOrder(day, ['d', 'p', 'b', 'b', 'c'])[0]).toMatch(/every stop/);
    expect(validateManualOrder(day, ['p', 'd', 'a', 'b', 'c'])[0]).toMatch(/cannot be moved/);
    expect(validateManualOrder(day, ['d', 'p', 'a', 'b', 'EVIL'])[0]).toMatch(/every stop/);
  });
  it('timeline accumulates drive + work minutes', () => {
    const t = timeline([s('a', 0.1), s('b', 0.1)], ['a', 'b'], { start: yard, speedKmh: 40 });
    expect(t[0].startOffsetMinutes).toBe(t[0].driveMinutes);
    expect(t[1].startOffsetMinutes).toBe(t[0].startOffsetMinutes + 30 + t[1].driveMinutes);
  });
});

describe('landscaping routing: crew absence + equipment', () => {
  it('gives stops to the nearest crew with capacity; reports leftovers', () => {
    const crews = [
      { id: 'east', capacityMinutes: 60, usedMinutes: 0, lastPoint: { lat: 40, lng: 0.5 } },
      { id: 'west', capacityMinutes: 480, usedMinutes: 0, lastPoint: { lat: 40, lng: -0.5 } },
    ];
    const r = redistributeStops([s('e1', 0.45), s('e2', 0.46), s('e3', 0.47), s('w1', -0.4, 'done')], crews);
    expect(r.assignments).toEqual([{ stopId: 'e1', crewId: 'east' }, { stopId: 'e2', crewId: 'east' }, { stopId: 'e3', crewId: 'west' }]);
    expect(r.unassigned).toEqual([]);
    expect(redistributeStops([s('x', 0.1, 'planned', 600)], crews).unassigned).toEqual(['x']);
  });
  it('detects an asset booked on two crews the same day', () => {
    const c = equipmentConflicts([{ crewId: 'a', assetKind: 'vehicle', assetId: 'v1' }, { crewId: 'b', assetKind: 'vehicle', assetId: 'v1' }, { crewId: 'a', assetKind: 'tool', assetId: 'v1' }, { crewId: 'a', assetKind: 'vehicle', assetId: 'v1' }]);
    expect(c).toEqual([{ assetKind: 'vehicle', assetId: 'v1', crewIds: ['a', 'b'] }]);
  });
});
