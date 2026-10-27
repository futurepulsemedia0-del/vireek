import { describe, expect, it } from 'vitest';
import {
  addOpening, addRoom, addWall, buildThumbPath, docTotals, emptyDoc, formatArea, formatLength, hitTest,
  historyCommit, historyInit, historyRedo, historyUndo, parseLength, parseSketchDoc, polygonArea, pt,
  removeElement, safeThumbPath, setWallLength, snapPoint,
} from './siteSketch';

const square = [pt(0, 0), pt(4000, 0), pt(4000, 3000), pt(0, 3000)];

describe('formatting and parsing', () => {
  it('formats imperial to the nearest half inch', () => {
    expect(formatLength(3810, 'imperial')).toBe("12' 6\"");
    expect(formatLength(3822.7, 'imperial')).toBe("12' 6½\"");
    expect(formatLength(3048, 'imperial')).toBe("10'");
    expect(formatLength(12.7, 'imperial')).toBe('½"');
  });
  it('formats metric', () => {
    expect(formatLength(850, 'metric')).toBe('850 mm');
    expect(formatLength(3200, 'metric')).toBe('3.20 m');
    expect(formatArea(12_000_000, 'metric')).toBe('12.00 m²');
    expect(formatArea(92_903.04, 'imperial')).toBe('1.0 sq ft');
  });
  it.each([
    ["12'6\"", 'imperial', 3810],
    ["12' 6 1/2\"", 'imperial', 3823],
    ['12ft 6in', 'imperial', 3810],
    ['150"', 'imperial', 3810],
    ['3,2 m', 'metric', 3200],
    ['320cm', 'metric', 3200],
    ['12', 'imperial', 3658],
    ['3.2', 'metric', 3200],
    ['abc', 'imperial', null],
    ['0', 'imperial', null],
    ['', 'metric', null],
  ] as const)('parses %s', (input, unit, expected) => {
    expect(parseLength(input, unit)).toBe(expected);
  });
});

describe('rooms, walls and measurements', () => {
  it('computes area and builds walls around a room without duplicates', () => {
    expect(polygonArea(square)).toBe(12_000_000);
    const { doc, id } = addRoom(emptyDoc(), square);
    expect(id).toBeTruthy();
    expect(doc.walls).toHaveLength(4);
    expect(addRoom(doc, square, 'Again').doc.walls).toHaveLength(4);
    expect(docTotals(doc).floorAreaMm2).toBe(12_000_000);
  });
  it('rejects degenerate rooms and zero-length walls', () => {
    const base = emptyDoc();
    expect(addRoom(base, [pt(0, 0), pt(10, 0)]).id).toBeNull();
    expect(addWall(base, pt(0, 0), pt(2, 0))).toBe(base);
  });
  it('retyping a wall length moves connected corners and the room', () => {
    const { doc } = addRoom(emptyDoc(), square);
    const next = setWallLength(doc, doc.walls[0].id, 5000);
    expect(next.walls[0].b.x).toBe(5000);
    expect(next.walls[1].a.x).toBe(5000);
    expect(next.rooms[0].points[1].x).toBe(5000);
  });
  it('keeps openings inside their wall and removes them with the wall', () => {
    const { doc } = addRoom(emptyDoc(), square);
    const wall = doc.walls[0];
    const placed = addOpening(doc, wall.id, 0.01, 'door');
    expect(placed.doc.openings[0].t).toBeGreaterThan(0.1);
    expect(removeElement(placed.doc, { kind: 'wall', id: wall.id }).openings).toHaveLength(0);
  });
  it('hit-tests rooms and walls', () => {
    const { doc } = addRoom(emptyDoc(), square);
    expect(hitTest(doc, pt(2000, 1500), 50)?.kind).toBe('room');
    expect(hitTest(doc, pt(2000, 10), 50)?.kind).toBe('wall');
    expect(hitTest(doc, pt(9000, 9000), 50)).toBeNull();
  });
});

describe('snapping, history, sanitising', () => {
  it('snaps to vertices first, then ortho, then grid', () => {
    expect(snapPoint(pt(1010, 990), { gridMm: 100, vertices: [pt(1000, 1000)], radiusMm: 30 }).kind).toBe('vertex');
    expect(snapPoint(pt(2000, 40), { gridMm: 100, vertices: [], radiusMm: 5, anchor: pt(0, 0), ortho: true }).pt.y).toBe(0);
    expect(snapPoint(pt(149, 151), { gridMm: 100, vertices: [], radiusMm: 5 }).pt).toEqual({ x: 100, y: 200 });
  });
  it('undoes and redoes', () => {
    const { doc } = addRoom(emptyDoc(), square);
    let h = historyCommit(historyInit(emptyDoc()), doc);
    h = historyUndo(h);
    expect(h.present.walls).toHaveLength(0);
    h = historyRedo(h);
    expect(h.present.walls).toHaveLength(4);
  });
  it('drops malformed data from untrusted JSON', () => {
    const bad = parseSketchDoc({ unit: 'metric', walls: [{ id: 'a', a: { x: 1, y: 2 }, b: { x: 'x', y: 1 } }], openings: [{ wall_id: 'zz' }] });
    expect(bad.walls).toHaveLength(0);
    expect(bad.openings).toHaveLength(0);
    expect(bad.unit).toBe('metric');
    expect(parseSketchDoc(null).walls).toEqual([]);
  });
  it('only accepts plain path data as a thumbnail', () => {
    const { doc } = addRoom(emptyDoc(), square);
    expect(buildThumbPath(doc)).toMatch(/^M/);
    expect(safeThumbPath('M1 1 L2 2')).toBe('M1 1 L2 2');
    expect(safeThumbPath('M1 1 <script>')).toBeNull();
  });
});
