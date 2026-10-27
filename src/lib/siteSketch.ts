/**
 * Site sketch & measure — pure model and geometry (no I/O, no React).
 * Every coordinate is an integer number of millimetres; units are display-only.
 */

export type UnitSystem = 'imperial' | 'metric';
export interface Pt { x: number; y: number }
export interface SketchWall { id: string; a: Pt; b: Pt }
export interface SketchRoom { id: string; name: string; points: Pt[] }
export interface SketchDimension { id: string; a: Pt; b: Pt }
export interface SketchOpening { id: string; wall_id: string; t: number; kind: 'door' | 'window'; width_mm: number }
export interface SketchNote { id: string; at: Pt; text: string }
export interface SketchDoc {
  v: 1;
  unit: UnitSystem;
  ceiling_height_mm: number;
  walls: SketchWall[];
  rooms: SketchRoom[];
  dimensions: SketchDimension[];
  openings: SketchOpening[];
  notes: SketchNote[];
}
export type SketchElementKind = 'wall' | 'room' | 'dimension' | 'opening' | 'note';
export type SketchSelection = { kind: SketchElementKind; id: string } | null;

export const LIMITS = { walls: 400, rooms: 60, dimensions: 200, openings: 200, notes: 100 } as const;
export const COORD_MAX = 1_000_000; // 1 km
export const MIN_SEGMENT_MM = 10;
export const DEFAULT_CEILING_MM = 2438; // 8 ft
export const MM_PER_INCH = 25.4;
export const MM_PER_FOOT = 304.8;
const SQMM_PER_SQFT = 92_903.04;

// ------------------------------------------------------------------
// Ids / basics
// ------------------------------------------------------------------

export function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
const uid = () => newId().slice(0, 8);
const rnd = (n: number) => Math.round(n);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export const pt = (x: number, y: number): Pt => ({ x: rnd(clamp(x, -COORD_MAX, COORD_MAX)), y: rnd(clamp(y, -COORD_MAX, COORD_MAX)) });
export const samePt = (a: Pt, b: Pt, tol = 1) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
export const wallLength = (w: { a: Pt; b: Pt }) => dist(w.a, w.b);

export function emptyDoc(unit: UnitSystem = 'imperial'): SketchDoc {
  return { v: 1, unit, ceiling_height_mm: DEFAULT_CEILING_MM, walls: [], rooms: [], dimensions: [], openings: [], notes: [] };
}

export function isDocEmpty(doc: SketchDoc): boolean {
  return !doc.walls.length && !doc.rooms.length && !doc.dimensions.length && !doc.openings.length && !doc.notes.length;
}

// ------------------------------------------------------------------
// Sanitising untrusted JSON (loaded from the database / local draft)
// ------------------------------------------------------------------

function asPt(v: unknown): Pt | null {
  if (!v || typeof v !== 'object') return null;
  const { x, y } = v as { x?: unknown; y?: unknown };
  return isNum(x) && isNum(y) ? pt(x, y) : null;
}

export function parseSketchDoc(raw: unknown, fallbackUnit: UnitSystem = 'imperial'): SketchDoc {
  const base = emptyDoc(fallbackUnit);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const used = new Set<string>();
  const idOf = (v: unknown) => {
    let id = typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : uid();
    while (used.has(id)) id = uid();
    used.add(id);
    return id;
  };
  const list = (v: unknown, max: number): Record<string, unknown>[] =>
    Array.isArray(v) ? (v.slice(0, max).filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];

  const doc: SketchDoc = {
    v: 1,
    unit: r.unit === 'metric' ? 'metric' : r.unit === 'imperial' ? 'imperial' : fallbackUnit,
    ceiling_height_mm: isNum(r.ceiling_height_mm) ? rnd(clamp(r.ceiling_height_mm, 1500, 6000)) : DEFAULT_CEILING_MM,
    walls: [],
    rooms: [],
    dimensions: [],
    openings: [],
    notes: [],
  };
  for (const w of list(r.walls, LIMITS.walls)) {
    const a = asPt(w.a);
    const b = asPt(w.b);
    if (a && b) doc.walls.push({ id: idOf(w.id), a, b });
  }
  for (const rm of list(r.rooms, LIMITS.rooms)) {
    const pts = (Array.isArray(rm.points) ? rm.points.slice(0, 200).map(asPt) : []).filter((p): p is Pt => !!p);
    if (pts.length >= 3) doc.rooms.push({ id: idOf(rm.id), name: typeof rm.name === 'string' ? rm.name.slice(0, 60) : 'Room', points: pts });
  }
  for (const d of list(r.dimensions, LIMITS.dimensions)) {
    const a = asPt(d.a);
    const b = asPt(d.b);
    if (a && b) doc.dimensions.push({ id: idOf(d.id), a, b });
  }
  const wallIds = new Set(doc.walls.map((w) => w.id));
  for (const o of list(r.openings, LIMITS.openings)) {
    if (typeof o.wall_id !== 'string' || !wallIds.has(o.wall_id)) continue;
    doc.openings.push({
      id: idOf(o.id),
      wall_id: o.wall_id,
      t: isNum(o.t) ? clamp(o.t, 0, 1) : 0.5,
      kind: o.kind === 'window' ? 'window' : 'door',
      width_mm: isNum(o.width_mm) ? rnd(clamp(o.width_mm, 300, 5000)) : 900,
    });
  }
  for (const n of list(r.notes, LIMITS.notes)) {
    const at = asPt(n.at);
    if (at) doc.notes.push({ id: idOf(n.id), at, text: typeof n.text === 'string' ? n.text.slice(0, 200) : '' });
  }
  return doc;
}

// ------------------------------------------------------------------
// Geometry
// ------------------------------------------------------------------

export function polygonArea(points: Pt[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
}

export function polygonPerimeter(points: Pt[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) s += dist(points[i], points[(i + 1) % points.length]);
  return s;
}

export function polygonCentroid(points: Pt[]): Pt {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    const f = p.x * q.y - q.x * p.y;
    a += f;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-6) {
    const n = Math.max(1, points.length);
    return { x: points.reduce((s, p) => s + p.x, 0) / n, y: points.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function projectOnSegment(p: Pt, a: Pt, b: Pt): { t: number; d: number; pt: Pt } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  const q = { x: a.x + dx * t, y: a.y + dy * t };
  return { t, d: dist(p, q), pt: q };
}

export function openingCenter(doc: SketchDoc, op: SketchOpening): Pt | null {
  const w = doc.walls.find((x) => x.id === op.wall_id);
  return w ? { x: w.a.x + (w.b.x - w.a.x) * op.t, y: w.a.y + (w.b.y - w.a.y) * op.t } : null;
}

export interface SketchTotals {
  roomCount: number;
  floorAreaMm2: number;
  roomPerimeterMm: number;
  wallLengthMm: number;
  grossWallAreaMm2: number;
  doorCount: number;
  windowCount: number;
}

export function docTotals(doc: SketchDoc): SketchTotals {
  const floorAreaMm2 = doc.rooms.reduce((s, r) => s + polygonArea(r.points), 0);
  const roomPerimeterMm = doc.rooms.reduce((s, r) => s + polygonPerimeter(r.points), 0);
  const wallLengthMm = doc.walls.reduce((s, w) => s + wallLength(w), 0);
  return {
    roomCount: doc.rooms.length,
    floorAreaMm2,
    roomPerimeterMm,
    wallLengthMm,
    grossWallAreaMm2: roomPerimeterMm * doc.ceiling_height_mm,
    doorCount: doc.openings.filter((o) => o.kind === 'door').length,
    windowCount: doc.openings.filter((o) => o.kind === 'window').length,
  };
}

export function boundsOf(doc: SketchDoc): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const pts: Pt[] = [
    ...doc.walls.flatMap((w) => [w.a, w.b]),
    ...doc.rooms.flatMap((r) => r.points),
    ...doc.dimensions.flatMap((d) => [d.a, d.b]),
    ...doc.notes.map((n) => n.at),
  ];
  if (!pts.length) return null;
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxX: Math.max(...pts.map((p) => p.x)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
}

// ------------------------------------------------------------------
// Formatting & parsing
// ------------------------------------------------------------------

export function formatLength(mm: number, unit: UnitSystem): string {
  if (!isNum(mm) || mm < 0) return '—';
  if (unit === 'metric') {
    if (mm < 1000) return `${rnd(mm)} mm`;
    return `${(mm / 1000).toFixed(2)} m`;
  }
  const halves = rnd((mm / MM_PER_INCH) * 2);
  const feet = Math.floor(halves / 24);
  const remHalves = halves % 24;
  const whole = Math.floor(remHalves / 2);
  const inchStr = remHalves === 0 ? '' : `${whole === 0 && remHalves % 2 === 1 ? '' : whole}${remHalves % 2 === 1 ? '½' : ''}`;
  if (feet === 0) return remHalves === 0 ? '0"' : `${inchStr}"`;
  return remHalves === 0 ? `${feet}'` : `${feet}' ${inchStr}"`;
}

export function formatArea(mm2: number, unit: UnitSystem): string {
  if (!isNum(mm2) || mm2 < 0) return '—';
  if (unit === 'metric') return `${(mm2 / 1_000_000).toFixed(2)} m²`;
  return `${(mm2 / SQMM_PER_SQFT).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} sq ft`;
}

/**
 * Parses what a technician types after reading a tape. Accepts 12'6", 12' 6 1/2", 12ft 6in, 12.5ft,
 * 150in, 150", 3.2m, 3,2 m, 320cm, 3200mm. A bare number is feet (imperial) or metres (metric).
 * Returns millimetres, or null when invalid / out of range.
 */
export function parseLength(input: string, unit: UnitSystem): number | null {
  let s = input.trim().toLowerCase().replace(/[′’]/g, "'").replace(/[″”]/g, '"').replace(/\s+/g, ' ');
  if (!s) return null;
  if (!s.includes('.') && /^\d+,\d+(\s*[a-z]+)?$/.test(s)) s = s.replace(',', '.');
  const NUM = '(\\d+(?:\\.\\d+)?)';
  let mm: number | null = null;
  let m: RegExpMatchArray | null;

  if ((m = s.match(new RegExp(`^${NUM}\\s*(mm|cm|m)$`)))) {
    mm = Number(m[1]) * (m[2] === 'mm' ? 1 : m[2] === 'cm' ? 10 : 1000);
  } else if ((m = s.match(new RegExp(`^${NUM}\\s*(?:'|ft|feet|foot)\\s*(?:${NUM}(?:\\s+(\\d+)\\/(\\d+))?\\s*(?:"|in|inch|inches)?)?$`)))) {
    const feet = Number(m[1]);
    let inches = m[2] ? Number(m[2]) : 0;
    if (m[3] && m[4]) {
      const den = Number(m[4]);
      if (den === 0) return null;
      inches += Number(m[3]) / den;
    }
    mm = feet * MM_PER_FOOT + inches * MM_PER_INCH;
  } else if ((m = s.match(new RegExp(`^${NUM}(?:\\s+(\\d+)\\/(\\d+))?\\s*(?:"|in|inch|inches)$`)))) {
    let inches = Number(m[1]);
    if (m[2] && m[3]) {
      const den = Number(m[3]);
      if (den === 0) return null;
      inches += Number(m[2]) / den;
    }
    mm = inches * MM_PER_INCH;
  } else if ((m = s.match(new RegExp(`^${NUM}$`)))) {
    mm = Number(m[1]) * (unit === 'metric' ? 1000 : MM_PER_FOOT);
  }
  if (mm === null || !Number.isFinite(mm)) return null;
  mm = rnd(mm);
  return mm >= MIN_SEGMENT_MM && mm <= COORD_MAX ? mm : null;
}

// ------------------------------------------------------------------
// Snapping & hit testing
// ------------------------------------------------------------------

export interface SnapOptions { gridMm: number; vertices: Pt[]; radiusMm: number; anchor?: Pt | null; ortho?: boolean }
export type SnapKind = 'vertex' | 'ortho' | 'grid' | 'none';

export function snapPoint(p: Pt, o: SnapOptions): { pt: Pt; kind: SnapKind } {
  let best: Pt | null = null;
  let bestD = o.radiusMm;
  for (const v of o.vertices) {
    const d = dist(p, v);
    if (d <= bestD) {
      best = v;
      bestD = d;
    }
  }
  if (best) return { pt: { x: best.x, y: best.y }, kind: 'vertex' };

  const g = (n: number) => (o.gridMm > 0 ? Math.round(n / o.gridMm) * o.gridMm : n);
  if (o.ortho && o.anchor) {
    const dx = p.x - o.anchor.x;
    const dy = p.y - o.anchor.y;
    const ang = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
    const tol = 6;
    if (ang <= tol || ang >= 180 - tol) return { pt: pt(g(p.x), o.anchor.y), kind: 'ortho' };
    if (Math.abs(ang - 90) <= tol) return { pt: pt(o.anchor.x, g(p.y)), kind: 'ortho' };
  }
  if (o.gridMm > 0) return { pt: pt(g(p.x), g(p.y)), kind: 'grid' };
  return { pt: pt(p.x, p.y), kind: 'none' };
}

export function allVertices(doc: SketchDoc): Pt[] {
  return [...doc.walls.flatMap((w) => [w.a, w.b]), ...doc.rooms.flatMap((r) => r.points), ...doc.dimensions.flatMap((d) => [d.a, d.b])];
}

export function hitTest(doc: SketchDoc, p: Pt, tolMm: number): SketchSelection {
  for (const n of doc.notes) if (dist(p, n.at) <= tolMm * 1.5) return { kind: 'note', id: n.id };
  for (const o of doc.openings) {
    const c = openingCenter(doc, o);
    if (c && dist(p, c) <= Math.max(tolMm, o.width_mm / 2)) return { kind: 'opening', id: o.id };
  }
  let bestWall: { id: string; d: number } | null = null;
  for (const w of doc.walls) {
    const d = projectOnSegment(p, w.a, w.b).d;
    if (d <= tolMm && (!bestWall || d < bestWall.d)) bestWall = { id: w.id, d };
  }
  if (bestWall) return { kind: 'wall', id: bestWall.id };
  for (const dm of doc.dimensions) if (projectOnSegment(p, dm.a, dm.b).d <= tolMm) return { kind: 'dimension', id: dm.id };
  let bestRoom: { id: string; area: number } | null = null;
  for (const r of doc.rooms) {
    if (pointInPolygon(p, r.points)) {
      const area = polygonArea(r.points);
      if (!bestRoom || area < bestRoom.area) bestRoom = { id: r.id, area };
    }
  }
  return bestRoom ? { kind: 'room', id: bestRoom.id } : null;
}

/** Draggable handle points for the selected element. */
export function handlesFor(doc: SketchDoc, sel: SketchSelection): Pt[] {
  if (!sel) return [];
  if (sel.kind === 'wall') {
    const w = doc.walls.find((x) => x.id === sel.id);
    return w ? [w.a, w.b] : [];
  }
  if (sel.kind === 'dimension') {
    const d = doc.dimensions.find((x) => x.id === sel.id);
    return d ? [d.a, d.b] : [];
  }
  if (sel.kind === 'room') return doc.rooms.find((x) => x.id === sel.id)?.points ?? [];
  if (sel.kind === 'note') {
    const n = doc.notes.find((x) => x.id === sel.id);
    return n ? [n.at] : [];
  }
  const o = doc.openings.find((x) => x.id === sel.id);
  const c = o ? openingCenter(doc, o) : null;
  return c ? [c] : [];
}

// ------------------------------------------------------------------
// Edits (immutable; return the SAME doc reference when nothing changed)
// ------------------------------------------------------------------

export function moveVertex(doc: SketchDoc, from: Pt, to: Pt): SketchDoc {
  const target = pt(to.x, to.y);
  if (samePt(from, target, 0)) return doc;
  const mv = (p: Pt) => (samePt(p, from) ? target : p);
  return {
    ...doc,
    walls: doc.walls.map((w) => ({ ...w, a: mv(w.a), b: mv(w.b) })),
    rooms: doc.rooms.map((r) => ({ ...r, points: r.points.map(mv) })),
    dimensions: doc.dimensions.map((d) => ({ ...d, a: mv(d.a), b: mv(d.b) })),
  };
}

export function setWallLength(doc: SketchDoc, id: string, lengthMm: number): SketchDoc {
  const w = doc.walls.find((x) => x.id === id);
  if (!w || !isNum(lengthMm) || lengthMm < MIN_SEGMENT_MM || lengthMm > COORD_MAX) return doc;
  const len = wallLength(w);
  const ux = len < 1 ? 1 : (w.b.x - w.a.x) / len;
  const uy = len < 1 ? 0 : (w.b.y - w.a.y) / len;
  const nb = pt(w.a.x + ux * lengthMm, w.a.y + uy * lengthMm);
  if (len < 1) return { ...doc, walls: doc.walls.map((x) => (x.id === id ? { ...x, b: nb } : x)) };
  const next = moveVertex(doc, w.b, nb);
  return clampOpenings(next);
}

function clampOpenings(doc: SketchDoc): SketchDoc {
  let changed = false;
  const openings = doc.openings.map((o) => {
    const w = doc.walls.find((x) => x.id === o.wall_id);
    if (!w) return o;
    const len = Math.max(1, wallLength(w));
    const half = o.width_mm / 2 / len;
    const t = half >= 0.5 ? 0.5 : clamp(o.t, half, 1 - half);
    if (t === o.t) return o;
    changed = true;
    return { ...o, t };
  });
  return changed ? { ...doc, openings } : doc;
}

export function addWall(doc: SketchDoc, a: Pt, b: Pt): SketchDoc {
  if (doc.walls.length >= LIMITS.walls || dist(a, b) < MIN_SEGMENT_MM) return doc;
  const dup = doc.walls.some((w) => (samePt(w.a, a) && samePt(w.b, b)) || (samePt(w.a, b) && samePt(w.b, a)));
  if (dup) return doc;
  return { ...doc, walls: [...doc.walls, { id: uid(), a: pt(a.x, a.y), b: pt(b.x, b.y) }] };
}

export function addDimension(doc: SketchDoc, a: Pt, b: Pt): SketchDoc {
  if (doc.dimensions.length >= LIMITS.dimensions || dist(a, b) < MIN_SEGMENT_MM) return doc;
  return { ...doc, dimensions: [...doc.dimensions, { id: uid(), a: pt(a.x, a.y), b: pt(b.x, b.y) }] };
}

/** Adds the room polygon AND the wall segments around it (skipping walls that already exist). */
export function addRoom(doc: SketchDoc, points: Pt[], name?: string): { doc: SketchDoc; id: string | null } {
  const pts: Pt[] = [];
  for (const p of points) if (!pts.length || !samePt(pts[pts.length - 1], p)) pts.push(pt(p.x, p.y));
  if (pts.length > 1 && samePt(pts[0], pts[pts.length - 1])) pts.pop();
  if (pts.length < 3 || polygonArea(pts) < 100 || doc.rooms.length >= LIMITS.rooms) return { doc, id: null };
  let next = doc;
  for (let i = 0; i < pts.length; i++) next = addWall(next, pts[i], pts[(i + 1) % pts.length]);
  const id = uid();
  next = { ...next, rooms: [...next.rooms, { id, name: (name ?? `Room ${doc.rooms.length + 1}`).slice(0, 60), points: pts }] };
  return { doc: next, id };
}

export function defaultOpeningWidth(kind: 'door' | 'window'): number {
  return kind === 'door' ? 914 : 1219;
}

export function addOpening(doc: SketchDoc, wallId: string, tClick: number, kind: 'door' | 'window'): { doc: SketchDoc; id: string | null } {
  const w = doc.walls.find((x) => x.id === wallId);
  if (!w || doc.openings.length >= LIMITS.openings) return { doc, id: null };
  const len = wallLength(w);
  if (len < 400) return { doc, id: null };
  const width = Math.min(defaultOpeningWidth(kind), Math.floor(len * 0.8));
  const half = width / 2 / len;
  const t = clamp(tClick, half, 1 - half);
  const id = uid();
  return { doc: { ...doc, openings: [...doc.openings, { id, wall_id: wallId, t, kind, width_mm: width }] }, id };
}

export function addNote(doc: SketchDoc, at: Pt, text = 'Note'): { doc: SketchDoc; id: string | null } {
  if (doc.notes.length >= LIMITS.notes) return { doc, id: null };
  const id = uid();
  return { doc: { ...doc, notes: [...doc.notes, { id, at: pt(at.x, at.y), text }] }, id };
}

export function removeElement(doc: SketchDoc, sel: SketchSelection): SketchDoc {
  if (!sel) return doc;
  switch (sel.kind) {
    case 'wall':
      return { ...doc, walls: doc.walls.filter((w) => w.id !== sel.id), openings: doc.openings.filter((o) => o.wall_id !== sel.id) };
    case 'room':
      return { ...doc, rooms: doc.rooms.filter((r) => r.id !== sel.id) };
    case 'dimension':
      return { ...doc, dimensions: doc.dimensions.filter((d) => d.id !== sel.id) };
    case 'opening':
      return { ...doc, openings: doc.openings.filter((o) => o.id !== sel.id) };
    case 'note':
      return { ...doc, notes: doc.notes.filter((n) => n.id !== sel.id) };
  }
}

export function updateRoomName(doc: SketchDoc, id: string, name: string): SketchDoc {
  return { ...doc, rooms: doc.rooms.map((r) => (r.id === id ? { ...r, name: name.slice(0, 60) } : r)) };
}
export function updateNoteText(doc: SketchDoc, id: string, text: string): SketchDoc {
  return { ...doc, notes: doc.notes.map((n) => (n.id === id ? { ...n, text: text.slice(0, 200) } : n)) };
}
export function setOpeningKind(doc: SketchDoc, id: string, kind: 'door' | 'window'): SketchDoc {
  return { ...doc, openings: doc.openings.map((o) => (o.id === id ? { ...o, kind } : o)) };
}
export function setOpeningWidth(doc: SketchDoc, id: string, widthMm: number): SketchDoc {
  const o = doc.openings.find((x) => x.id === id);
  const w = o && doc.walls.find((x) => x.id === o.wall_id);
  if (!o || !w || !isNum(widthMm)) return doc;
  const width = rnd(clamp(widthMm, 300, Math.min(5000, Math.floor(wallLength(w)))));
  return clampOpenings({ ...doc, openings: doc.openings.map((x) => (x.id === id ? { ...x, width_mm: width } : x)) });
}
export function moveOpening(doc: SketchDoc, id: string, p: Pt): SketchDoc {
  const o = doc.openings.find((x) => x.id === id);
  const w = o && doc.walls.find((x) => x.id === o.wall_id);
  if (!o || !w) return doc;
  return clampOpenings({ ...doc, openings: doc.openings.map((x) => (x.id === id ? { ...x, t: projectOnSegment(p, w.a, w.b).t } : x)) });
}
export function moveNote(doc: SketchDoc, id: string, p: Pt): SketchDoc {
  return { ...doc, notes: doc.notes.map((n) => (n.id === id ? { ...n, at: pt(p.x, p.y) } : n)) };
}
export function setUnit(doc: SketchDoc, unit: UnitSystem): SketchDoc {
  return doc.unit === unit ? doc : { ...doc, unit };
}
export function setCeilingHeight(doc: SketchDoc, mm: number): SketchDoc {
  return isNum(mm) ? { ...doc, ceiling_height_mm: rnd(clamp(mm, 1500, 6000)) } : doc;
}

// ------------------------------------------------------------------
// Undo / redo
// ------------------------------------------------------------------

export interface History { past: SketchDoc[]; present: SketchDoc; future: SketchDoc[] }
export const HISTORY_LIMIT = 100;
export const historyInit = (doc: SketchDoc): History => ({ past: [], present: doc, future: [] });
export function historyCommit(h: History, next: SketchDoc): History {
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [] };
}
export function historyUndo(h: History): History {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}
export function historyRedo(h: History): History {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: h.future[0], future: h.future.slice(1) };
}

// ------------------------------------------------------------------
// Thumbnail (tiny SVG path stored next to the sketch for list cards)
// ------------------------------------------------------------------

export function buildThumbPath(doc: SketchDoc): string | null {
  const segs = doc.walls.slice(0, 200).map((w) => [w.a, w.b] as const);
  if (!segs.length) return null;
  const xs = segs.flatMap(([a, b]) => [a.x, b.x]);
  const ys = segs.flatMap(([a, b]) => [a.y, b.y]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(...xs) - minX;
  const h = Math.max(...ys) - minY;
  const scale = 88 / Math.max(w, h, 1);
  const ox = 6 + (88 - w * scale) / 2;
  const oy = 6 + (88 - h * scale) / 2;
  const f = (p: Pt) => `${((p.x - minX) * scale + ox).toFixed(1)} ${((p.y - minY) * scale + oy).toFixed(1)}`;
  const d = segs.map(([a, b]) => `M${f(a)} L${f(b)}`).join(' ');
  return d.length <= 7500 ? d : null;
}

/** Only ever render a stored thumbnail if it is plain path data. */
export function safeThumbPath(s: string | null | undefined): string | null {
  return s && s.length <= 8000 && /^[ML0-9.\s-]+$/.test(s) ? s : null;
}
