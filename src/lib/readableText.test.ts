import { describe, it, expect } from 'vitest';
import { readableTextColor } from './readableText';

const channel = (v: number): number => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const lum = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
const ratio = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const hex = (r: number, g: number, b: number): string => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

describe('readableTextColor', () => {
  it('picks the obvious ends', () => {
    expect(readableTextColor('#FFFFFF')).toBe('#0F172A');
    expect(readableTextColor('#000000')).toBe('#FFFFFF');
    expect(readableTextColor('#facc15')).toBe('#0F172A');
    expect(readableTextColor('#3448E8')).toBe('#FFFFFF');
  });
  it('accepts 3-digit and un-prefixed hex; falls back to white on garbage', () => {
    expect(readableTextColor('fff')).toBe('#0F172A');
    expect(readableTextColor('#000')).toBe('#FFFFFF');
    expect(readableTextColor('nope')).toBe('#FFFFFF');
    expect(readableTextColor('')).toBe('#FFFFFF');
  });
  it('mid-tone brand colours that white-or-ink cannot serve get black (the former dead zone)', () => {
    expect(readableTextColor('#DC19C3')).toBe('#000000');
    expect(readableTextColor('#F97316')).not.toBe('#FFFFFF'); // white was 2.8:1 under the old 0.4 threshold
  });
  it('guarantees >= 4.5:1 for every colour on a 4096-point RGB grid', () => {
    let worst = Infinity;
    for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 17) {
      const bg = hex(r, g, b);
      worst = Math.min(worst, ratio(bg, readableTextColor(bg)));
    }
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });
});
