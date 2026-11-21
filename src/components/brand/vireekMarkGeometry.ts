/**
 * Pure geometry for the animated Vireek mark (thread → V → network).
 * No DOM, no React: everything here is deterministic and unit-tested.
 * All shapes share exactly ANCHORS points so any shape can morph into any other.
 */
export type Pt = [number, number];
export type ShapeName = 'thread' | 'wave' | 'loop' | 'spiral' | 'v';

export const VIEW_W = 260;
export const VIEW_H = 240;
export const ANCHORS = 10;

/** Order of the click-triggered morph. 'thread' is home; the sequence always returns to it. */
export const SEQUENCE: readonly Exclude<ShapeName, 'v'>[] = ['thread', 'wave', 'loop', 'spiral'];

const r1 = (n: number): number => Math.round(n * 10) / 10;

function buildV(): Pt[] {
  const left = [0, 1, 2, 3].map((k): Pt => [46 + (74 * k) / 4, 50 + (146 * k) / 4]);
  const right = [1, 2, 3, 4].map((k): Pt => [120 + (74 * k) / 4, 196 - (146 * k) / 4]);
  // The vertex is doubled on purpose: the zero-length segment keeps the V's corner sharp.
  return [...left, [120, 196], [120, 196], ...right];
}

function buildWave(): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < ANCHORS; i++) out.push([34 + (i * 192) / 9, 122 - 46 * Math.sin((i / 9) * Math.PI * 3)]);
  return out;
}

function buildSpiral(): Pt[] {
  const out: Pt[] = [];
  const end = -Math.PI / 4;
  const step = (1.625 * 2 * Math.PI) / 9;
  for (let i = 0; i < ANCHORS; i++) {
    const a = end - (9 - i) * step;
    const r = 8 + (i * 76) / 9;
    out.push([120 + r * Math.cos(a), 124 + r * Math.sin(a)]);
  }
  return out;
}

export const SHAPES: Readonly<Record<ShapeName, readonly Pt[]>> = {
  // curl (0–5), then a V with a doubled vertex (6,7), ending on the node (9)
  thread: [[36, 86], [44, 46], [80, 32], [96, 66], [68, 92], [50, 62], [120, 198], [120, 198], [158, 126], [196, 54]],
  wave: buildWave(),
  loop: [[38, 178], [64, 154], [94, 118], [130, 82], [170, 60], [208, 80], [198, 118], [158, 114], [150, 78], [184, 42]],
  spiral: buildSpiral(),
  v: buildV(),
};

/** Network around the node at home: [dx, dy, radius, tone]. */
export const NET: readonly (readonly [number, number, number, 'k' | 'i' | 'o'])[] = [
  [-34, -20, 5, 'k'],
  [4, -40, 5.5, 'i'],
  [36, -16, 5, 'o'],
  [38, 26, 6, 'i'],
];
export const NET_LINKS: readonly (readonly [number, number])[] = [[0, 1], [1, 2], [2, 3]];

export const copyPts = (p: readonly Pt[]): Pt[] => p.map((q): Pt => [q[0], q[1]]);

/** Smooth path through every anchor (uniform Catmull-Rom → cubic Bézier). Doubled anchors stay sharp. */
export function pathFor(p: readonly Pt[]): string {
  const n = p.length;
  const g = (i: number): Pt => p[Math.max(0, Math.min(n - 1, i))];
  let d = `M${r1(p[0][0])} ${r1(p[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const a = g(i - 1);
    const b = g(i);
    const c = g(i + 1);
    const e = g(i + 2);
    if (b[0] === c[0] && b[1] === c[1]) {
      d += `C${r1(b[0])} ${r1(b[1])} ${r1(c[0])} ${r1(c[1])} ${r1(c[0])} ${r1(c[1])}`;
      continue;
    }
    d += `C${r1(b[0] + (c[0] - a[0]) / 6)} ${r1(b[1] + (c[1] - a[1]) / 6)} ${r1(c[0] - (e[0] - b[0]) / 6)} ${r1(c[1] - (e[1] - b[1]) / 6)} ${r1(c[0])} ${r1(c[1])}`;
  }
  return d;
}

export const easeInOutCubic = (u: number): number => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

/** out = from + (to − from) · e, in place. */
export function mix(out: Pt[], from: readonly Pt[], to: readonly Pt[], e: number): void {
  for (let i = 0; i < out.length; i++) {
    out[i][0] = from[i][0] + (to[i][0] - from[i][0]) * e;
    out[i][1] = from[i][1] + (to[i][1] - from[i][1]) * e;
  }
}

/** Frame-rate independent smoothing of `lag` toward `target` (the indigo trailing echo). */
export function follow(lag: Pt[], target: readonly Pt[], dtSec: number, tauSec: number): void {
  const k = 1 - Math.exp(-dtSec / tauSec);
  for (let i = 0; i < lag.length; i++) {
    lag[i][0] += (target[i][0] - lag[i][0]) * k;
    lag[i][1] += (target[i][1] - lag[i][1]) * k;
  }
}
