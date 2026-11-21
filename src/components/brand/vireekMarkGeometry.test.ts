import { describe, expect, it } from 'vitest';
import {
  ANCHORS,
  SEQUENCE,
  SHAPES,
  copyPts,
  easeInOutCubic,
  follow,
  mix,
  pathFor,
  type ShapeName,
} from './vireekMarkGeometry';

const NAMES = Object.keys(SHAPES) as ShapeName[];

describe('vireekMarkGeometry', () => {
  it.each(NAMES)('%s has exactly ANCHORS finite points inside the viewBox margin', (name) => {
    const pts = SHAPES[name];
    expect(pts).toHaveLength(ANCHORS);
    for (const [x, y] of pts) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      expect(x).toBeGreaterThan(-20);
      expect(x).toBeLessThan(280);
      expect(y).toBeGreaterThan(-20);
      expect(y).toBeLessThan(260);
    }
  });

  it('the sequence starts at home and only uses known shapes', () => {
    expect(SEQUENCE[0]).toBe('thread');
    for (const s of SEQUENCE) expect(SHAPES[s]).toBeDefined();
  });

  it.each(NAMES)('%s produces a valid path with no NaN', (name) => {
    const d = pathFor(SHAPES[name]);
    expect(d.startsWith('M')).toBe(true);
    expect(d).not.toMatch(/NaN|undefined|Infinity/);
    expect((d.match(/C/g) ?? []).length).toBe(ANCHORS - 1);
  });

  it('keeps the V vertex sharp (doubled anchor emits a degenerate segment)', () => {
    expect(pathFor(SHAPES.v)).toContain('C120 196 120 196 120 196');
    expect(pathFor(SHAPES.thread)).toContain('C120 198 120 198 120 198');
  });

  it('every shape ends on the node anchor used for the dot', () => {
    expect(SHAPES.v[9]).toEqual([194, 50]);
    expect(SHAPES.thread[9]).toEqual([196, 54]);
  });

  it('ease is 0→1, monotone and symmetric', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
    let prev = -1;
    for (let u = 0; u <= 1; u += 0.05) {
      const e = easeInOutCubic(u);
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
  });

  it('mix hits both endpoints exactly and never mutates its inputs', () => {
    const from = copyPts(SHAPES.thread);
    const to = copyPts(SHAPES.wave);
    const snapshotFrom = JSON.stringify(from);
    const snapshotTo = JSON.stringify(to);
    const out = copyPts(from);
    mix(out, from, to, 0);
    expect(out).toEqual(from);
    mix(out, from, to, 1);
    expect(out).toEqual(to);
    expect(JSON.stringify(from)).toBe(snapshotFrom);
    expect(JSON.stringify(to)).toBe(snapshotTo);
  });

  it('follow converges to the target and is frame-rate independent', () => {
    const target = copyPts(SHAPES.loop);
    const a = copyPts(SHAPES.thread);
    const b = copyPts(SHAPES.thread);
    for (let i = 0; i < 60; i++) follow(a, target, 1 / 60, 0.12);
    for (let i = 0; i < 30; i++) follow(b, target, 1 / 30, 0.12);
    for (let i = 0; i < ANCHORS; i++) {
      expect(a[i][0]).toBeCloseTo(b[i][0], 6);
      expect(a[i][1]).toBeCloseTo(b[i][1], 6);
    }
    for (let i = 0; i < 600; i++) follow(a, target, 1 / 60, 0.12);
    for (let i = 0; i < ANCHORS; i++) expect(a[i][0]).toBeCloseTo(target[i][0], 3);
  });
});
