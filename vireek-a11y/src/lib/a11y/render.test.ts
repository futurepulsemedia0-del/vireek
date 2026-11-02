import { describe, expect, it } from 'vitest';
import { computeRenderState } from './apply';
import { correctionMatrix, toFeColorMatrix } from './colorBlind';
import { DEFAULT_SETTINGS } from './settings';

describe('computeRenderState', () => {
  it('defaults produce no classes and no filter (zero visual change)', () => {
    const r = computeRenderState(DEFAULT_SETTINGS);
    expect(r.classes).toEqual([]);
    expect(r.vars['--a11y-filter']).toBe('none');
  });
  it('contentScale is wired to a class + variable (was dead before)', () => {
    const r = computeRenderState({ ...DEFAULT_SETTINGS, contentScale: 1.2 });
    expect(r.classes).toContain('a11y-zoomed');
    expect(r.vars['--a11y-content-scale']).toBe('1.2');
  });
  it('stopAnimations and reduceMotion are independent', () => {
    expect(computeRenderState({ ...DEFAULT_SETTINGS, stopAnimations: true }).classes).toEqual(['a11y-stop-animations']);
    expect(computeRenderState({ ...DEFAULT_SETTINGS, reduceMotion: true }).classes).toEqual(['a11y-reduce-motion']);
  });
  it('spacing classes only when the user changed that property', () => {
    expect(computeRenderState({ ...DEFAULT_SETTINGS, lineHeight: 1.9 }).classes).toEqual(['a11y-lh']);
    expect(computeRenderState({ ...DEFAULT_SETTINGS, letterSpacing: 0.04 }).classes).toEqual(['a11y-ls']);
    expect(computeRenderState({ ...DEFAULT_SETTINGS, wordSpacing: 0.1 }).classes).toEqual(['a11y-ws']);
  });
  it('new class flags map 1:1', () => {
    expect(computeRenderState({ ...DEFAULT_SETTINGS, simpleFont: true }).classes).toEqual(['a11y-simple-font']);
    expect(computeRenderState({ ...DEFAULT_SETTINGS, largeTargets: true }).classes).toEqual(['a11y-large-targets']);
    expect(computeRenderState({ ...DEFAULT_SETTINGS, focusMode: true }).classes).toEqual(['a11y-focus-mode']);
    expect(computeRenderState({ ...DEFAULT_SETTINGS, magnifier: true, readingMask: true, readingGuide: true }).classes).toEqual([]); // React overlays, no html class
  });
  it('colorBlind filter comes first, then other filters', () => {
    const f = computeRenderState({ ...DEFAULT_SETTINGS, colorBlind: 'deuteranopia', grayscale: true }).vars['--a11y-filter'];
    expect(f).toBe('url(#vk-a11y-cb-deuteranopia) grayscale(1)');
  });
});

describe('color-blind correction matrix', () => {
  for (const mode of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
    it(`${mode}: rows sum to 1 (grays preserved) and is not identity`, () => {
      const m = correctionMatrix(mode);
      m.forEach((row) => expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5));
      expect(m).not.toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    });
  }
  it('feColorMatrix string has 20 numbers', () => {
    expect(toFeColorMatrix(correctionMatrix('protanopia')).split(' ')).toHaveLength(20);
  });
});
