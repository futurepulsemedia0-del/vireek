/**
 * Vireek document design tokens — the single source of truth for every
 * generated PDF. Pure module: no DOM, no jsPDF, no app imports.
 */

export type Rgb = [number, number, number];

export const PAGE_SIZES = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 },
} as const;
export type PageSizeName = keyof typeof PAGE_SIZES;

export const MARGIN = 48;
/** Space kept clear at the bottom of every page for the running footer. */
export const FOOTER_RESERVE = 64;

export const INK: Rgb = [23, 23, 23];
export const MUTED: Rgb = [96, 96, 106];
export const LINE: Rgb = [220, 220, 228];
export const ZEBRA: Rgb = [247, 247, 250];
export const HEAD_FILL: Rgb = [240, 240, 245];
export const SUCCESS: Rgb = [22, 120, 80];
export const DANGER: Rgb = [185, 45, 45];

/** Type scale in pt. Body copy never goes below 9pt; legal/footer text is 8pt. */
export const TYPE = { display: 26, h1: 16, h2: 11, body: 10, small: 9, micro: 8 } as const;
export const LEADING = 1.32;

const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

/** WCAG 2.x relative luminance. */
export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, 1..21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: Rgb = [255, 255, 255];
const mix = (c: Rgb, t: number): Rgb => [
  Math.round(c[0] * (1 - t)),
  Math.round(c[1] * (1 - t)),
  Math.round(c[2] * (1 - t)),
];

/**
 * White-label colours are chosen by customers and can be unreadable as text
 * (pale yellow, light green…). Darkens `c` toward black, keeping its hue, until
 * it reaches `min` contrast on `bg`. Returns `c` unchanged when already fine.
 */
export function readableOn(c: Rgb, bg: Rgb = WHITE, min = 4.5): Rgb {
  if (contrastRatio(c, bg) >= min) return c;
  for (let t = 0.02; t <= 1.0001; t += 0.02) {
    const m = mix(c, t);
    if (contrastRatio(m, bg) >= min) return m;
  }
  return [0, 0, 0];
}

/** Black or white — whichever reads better on `bg` (for text on a brand band). */
export function onColor(bg: Rgb): Rgb {
  return contrastRatio([255, 255, 255], bg) >= contrastRatio([0, 0, 0], bg) ? [255, 255, 255] : [0, 0, 0];
}
