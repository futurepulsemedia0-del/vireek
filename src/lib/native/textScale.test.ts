import { describe, expect, it } from 'vitest';
import { clampFontScale } from './textScale';

describe('clampFontScale', () => {
  it('passes normal values through, rounded', () => expect(clampFontScale(1.1234)).toBe(1.12));
  it('clamps extremes', () => {
    expect(clampFontScale(5)).toBe(2);
    expect(clampFontScale(0.2)).toBe(0.85);
  });
  it('falls back to 1 for junk', () => {
    expect(clampFontScale(NaN)).toBe(1);
    expect(clampFontScale('abc')).toBe(1);
    expect(clampFontScale(-3)).toBe(1);
  });
});
