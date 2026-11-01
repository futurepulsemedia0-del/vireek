// Tiny WCAG / colour-vision helpers for the /dev/colors page (the CI gate lives in scripts/color/oklch.mjs).
export type RGB = [number, number, number];
export const hexToRgb = (hex: string): RGB => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
};
const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const delin = (v: number) => { const x = Math.min(1, Math.max(0, v)); return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)); };
export const luminance = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function contrast(a: RGB, b: RGB): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export type Vision = 'normal' | 'protanopia' | 'deuteranopia' | 'tritanopia' | 'grayscale';
const M: Record<Exclude<Vision, 'normal' | 'grayscale'>, number[][]> = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
export function simulate(rgb: RGB, kind: Vision): RGB {
  if (kind === 'normal') return rgb;
  if (kind === 'grayscale') { const y = delin(luminance(rgb)); return [y, y, y]; }
  const l = rgb.map(lin);
  return M[kind].map((r) => delin(r[0] * l[0] + r[1] * l[1] + r[2] * l[2])) as RGB;
}
export const rgbCss = (c: RGB) => `rgb(${c[0]} ${c[1]} ${c[2]})`;
