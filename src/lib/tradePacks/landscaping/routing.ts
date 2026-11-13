/**
 * Landscaping pack — crew route ordering and day-of re-routing (pure).
 *
 * Builds on the shared framework planner (`planRouteDay`: nearest-neighbour + workday capacity) and adds
 * what a landscaping day needs:
 *   - stops that are already DONE / SKIPPED / IN PROGRESS never move (history is not rewritten);
 *   - only the remaining stops are re-planned, starting from where the crew actually is;
 *   - overflow (no longer fits the workday) is returned, never silently dropped;
 *   - manual drag-and-drop ordering is validated with the same rules the database RPC enforces.
 */

import { planRouteDay, type GeoPoint, type PlanStop, type RoutePlan } from '../framework.ts';

export type StopState = 'planned' | 'in_progress' | 'done' | 'skipped';

export interface DayStop {
  id: string;
  lat: number | null;
  lng: number | null;
  minutes: number;
  state: StopState;
}

export interface RerouteOptions {
  /** Where the crew starts (yard) when nothing is done yet. */
  start?: GeoPoint | null;
  /** Minutes of the workday already used (drive + work) by finished stops. */
  elapsedMinutes?: number;
  workdayMinutes: number;
  speedKmh: number;
}

export interface RerouteResult {
  /** Full ordering: finished stops first (original order), the in-progress stop, then the re-planned remainder. */
  order: string[];
  /** Plan for the remainder only (drive minutes / offsets are relative to “now”). */
  plan: RoutePlan;
  /** Stops that no longer fit today; the dispatcher moves them to another day. */
  overflow: string[];
  /** True when the order differs from the order passed in. */
  changed: boolean;
}

const geo = (s: DayStop): GeoPoint | null => (s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null);

/**
 * Re-plan the unfinished part of a day. Deterministic: same input ⇒ same output (ties keep input order),
 * so pressing “Re-route” twice never reshuffles.
 */
export function rerouteDay(stops: readonly DayStop[], opts: RerouteOptions): RerouteResult {
  const locked = stops.filter((s) => s.state === 'done' || s.state === 'skipped');
  const active = stops.find((s) => s.state === 'in_progress');
  const rest = stops.filter((s) => s.state === 'planned');

  // Where is the crew now? Last place with coordinates among finished / in-progress stops, else the yard.
  let here: GeoPoint | null = opts.start ?? null;
  for (const s of [...locked, ...(active ? [active] : [])]) here = geo(s) ?? here;

  const used = Math.max(0, opts.elapsedMinutes ?? 0) + (active ? active.minutes : 0);
  const plan = planRouteDay(
    rest.map<PlanStop>((s) => ({ id: s.id, lat: s.lat, lng: s.lng, minutes: s.minutes })),
    { start: here, workdayMinutes: Math.max(0, opts.workdayMinutes - used), speedKmh: opts.speedKmh },
  );

  const order = [...locked.map((s) => s.id), ...(active ? [active.id] : []), ...plan.stops.map((s) => s.id), ...plan.overflow.map((s) => s.id)];
  const before = stops.map((s) => s.id);
  return { order, plan, overflow: plan.overflow.map((s) => s.id), changed: order.some((id, i) => id !== before[i]) };
}

/** Errors for a manual order; empty = valid. Mirrors landscape_reorder_day() in SQL. */
export function validateManualOrder(current: readonly DayStop[], proposedIds: readonly string[]): string[] {
  const errors: string[] = [];
  const ids = new Set(current.map((s) => s.id));
  if (proposedIds.length !== current.length || new Set(proposedIds).size !== proposedIds.length || proposedIds.some((id) => !ids.has(id))) {
    return ['The new order must list every stop of the day exactly once'];
  }
  // Finished and in-progress stops must keep their positions at the head, in their original order.
  const fixed = current.filter((s) => s.state !== 'planned').map((s) => s.id);
  if (fixed.some((id, i) => proposedIds[i] !== id)) errors.push('Stops that are done, skipped or in progress cannot be moved');
  return errors;
}

/** Move one stop to a new index; returns the new id order. Throws if the stop is locked or the index is invalid. */
export function moveStop(current: readonly DayStop[], id: string, toIndex: number): string[] {
  const from = current.findIndex((s) => s.id === id);
  if (from < 0) throw new Error('Stop not found');
  if (current[from].state !== 'planned') throw new Error('Only planned stops can be moved');
  const lockedCount = current.filter((s) => s.state !== 'planned').length;
  if (!Number.isInteger(toIndex) || toIndex < lockedCount || toIndex >= current.length) throw new Error('Invalid position');
  const ids = current.map((s) => s.id);
  ids.splice(from, 1);
  ids.splice(toIndex, 0, id);
  return ids;
}

/** Wall-clock start offsets (minutes from route start) for a given order, using straight-line drive estimates. */
export function timeline(stops: readonly DayStop[], order: readonly string[], opts: { start?: GeoPoint | null; speedKmh: number }): Array<{ id: string; startOffsetMinutes: number; driveMinutes: number }> {
  const byId = new Map(stops.map((s) => [s.id, s]));
  const out: Array<{ id: string; startOffsetMinutes: number; driveMinutes: number }> = [];
  let t = 0;
  let prev: GeoPoint | null = opts.start ?? null;
  for (const id of order) {
    const s = byId.get(id);
    if (!s) continue;
    const here = geo(s);
    let drive = 0;
    if (prev && here) {
      const R = 6371;
      const rad = (x: number) => (x * Math.PI) / 180;
      const h = Math.sin(rad(here.lat - prev.lat) / 2) ** 2 + Math.cos(rad(prev.lat)) * Math.cos(rad(here.lat)) * Math.sin(rad(here.lng - prev.lng) / 2) ** 2;
      drive = Math.round(((2 * R * Math.asin(Math.min(1, Math.sqrt(h)))) / Math.max(1, opts.speedKmh)) * 60);
    }
    t += drive;
    out.push({ id, startOffsetMinutes: t, driveMinutes: drive });
    t += s.minutes;
    if (here) prev = here;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Crew availability + equipment                                        */
/* ------------------------------------------------------------------ */

export interface CrewLoad {
  id: string;
  capacityMinutes: number;
  usedMinutes: number;
  /** Last known position (end of its route) for the nearest-crew choice. */
  lastPoint: GeoPoint | null;
}

export interface Redistribution {
  assignments: Array<{ stopId: string; crewId: string }>;
  unassigned: string[];
}

function distKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const rad = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A crew is out (breakdown, sick day): give each of its planned stops to the nearest other crew that still
 * has capacity; stops nobody can absorb are returned as `unassigned` for the dispatcher. Deterministic.
 */
export function redistributeStops(stops: readonly DayStop[], crews: readonly CrewLoad[]): Redistribution {
  const load = new Map(crews.map((c) => [c.id, { ...c }]));
  const assignments: Redistribution['assignments'] = [];
  const unassigned: string[] = [];
  for (const s of stops.filter((x) => x.state === 'planned')) {
    const p = geo(s);
    let best: { id: string; d: number } | null = null;
    for (const c of [...load.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (c.usedMinutes + s.minutes > c.capacityMinutes) continue;
      const d = p && c.lastPoint ? distKm(p, c.lastPoint) : 1e6 + c.usedMinutes; // unknown geometry ⇒ least-loaded
      if (!best || d < best.d) best = { id: c.id, d };
    }
    if (!best) {
      unassigned.push(s.id);
      continue;
    }
    const chosen = load.get(best.id) as CrewLoad;
    chosen.usedMinutes += s.minutes;
    if (p) chosen.lastPoint = p;
    assignments.push({ stopId: s.id, crewId: best.id });
  }
  return { assignments, unassigned };
}

export interface EquipmentAssignment {
  crewId: string;
  assetKind: 'vehicle' | 'tool';
  assetId: string;
}

/** Assets assigned to more than one crew for the same day. Mirrors the UNIQUE constraint in SQL. */
export function equipmentConflicts(assignments: readonly EquipmentAssignment[]): Array<{ assetKind: string; assetId: string; crewIds: string[] }> {
  const map = new Map<string, Set<string>>();
  for (const a of assignments) {
    const k = `${a.assetKind}:${a.assetId}`;
    (map.get(k) ?? map.set(k, new Set()).get(k)!).add(a.crewId);
  }
  return [...map.entries()]
    .filter(([, crews]) => crews.size > 1)
    .map(([k, crews]) => ({ assetKind: k.split(':')[0], assetId: k.slice(k.indexOf(':') + 1), crewIds: [...crews].sort() }));
}
