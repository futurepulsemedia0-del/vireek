// scripts/color/oklch.mjs — dependency-free colour maths (OKLCH <-> sRGB, WCAG contrast, CVD simulation).
// Shared by the palette generator, the CI contrast gate and the /dev/colors page.

const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const toLinear = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const fromLinear = (v) => { v = clamp01(v); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055); };

/** sRGB [0-255] -> OKLab */
export function rgbToOklab([r, g, b]) {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
/** OKLab -> linear sRGB (unclamped) */
export function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
export const rgbToOklch = (rgb) => {
  const [L, a, b] = rgbToOklab(rgb);
  const C = Math.hypot(a, b);
  return [L, C, C < 1e-4 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
};
const inGamut = (lin) => lin.every((v) => v >= -0.0005 && v <= 1.0005);
/** OKLCH -> sRGB integer triple; chroma is reduced (not clipped) until in gamut so hue/lightness stay true. */
export function oklchToRgb(L, C, h) {
  const rad = (h * Math.PI) / 180;
  let lo = 0, hi = C, c = C;
  if (!inGamut(oklabToLinear([L, C * Math.cos(rad), C * Math.sin(rad)]))) {
    for (let i = 0; i < 24; i++) {
      c = (lo + hi) / 2;
      if (inGamut(oklabToLinear([L, c * Math.cos(rad), c * Math.sin(rad)]))) lo = c; else hi = c;
    }
    c = lo;
  }
  return oklabToLinear([L, c * Math.cos(rad), c * Math.sin(rad)]).map((v) => Math.round(fromLinear(v)));
}
export const luminance = ([r, g, b]) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
export function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** Composite fg (alpha) over bg — used for tinted/translucent surfaces. */
export const over = (fg, alpha, bg) => fg.map((v, i) => Math.round(v * alpha + bg[i] * (1 - alpha)));
export const toHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
export const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
};
export const deltaE = (p, q) => { const a = rgbToOklab(p), b = rgbToOklab(q); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); };

/** Machado et al. 2009 (severity 1.0) matrices, applied in linear sRGB. */
export const CVD = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
export function simulate(rgb, kind) {
  if (kind === 'grayscale') { const y = Math.round(fromLinear(luminance(rgb))); return [y, y, y]; }
  const lin = rgb.map(toLinear), M = CVD[kind];
  return M.map((row) => Math.round(fromLinear(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])));
}

/**
 * Find the lightness (same hue/chroma, gamut-safe) nearest `seedL` whose contrast against EVERY
 * background in `bgs` is >= target. Walks darker (dir=-1) or lighter (dir=+1).
 */
export function solveL(seedL, C, h, bgs, target, dir) {
  const ok = (L) => { const rgb = oklchToRgb(L, C, h); return bgs.every((b) => contrast(rgb, b) >= target); };
  if (ok(seedL)) return seedL;
  let lo = seedL, hi = dir < 0 ? 0 : 1;
  if (!ok(hi)) throw new Error(`unreachable contrast ${target} for h=${h}`);
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; }
  return hi;
}
