import { beforeEach, describe, expect, it } from 'vitest';
import bootSource from '../../../public/a11y-boot.js?raw';
import { applyToDocument, computeRenderState, MANAGED_CLASSES } from './apply';
import { sanitizeSettings } from './settings';

const root = document.documentElement;
const SAMPLES = [
  { textSize: 1.25, lineHeight: 1.9, letterSpacing: 0.04, wordSpacing: 0.1, highContrast: true, stopAnimations: true },
  { contentScale: 1.2, invertColors: true, grayscale: true, highlightKeyboardFocus: true, hideImages: true },
  { readableFont: true, dyslexiaFont: true, reduceMotion: true, screenReaderMode: true, darkContrast: true },
  { textSize: 99, lineHeight: 'x', highSaturation: true, lowSaturation: true },
];

beforeEach(() => { root.removeAttribute('style'); root.className = ''; localStorage.clear(); });

describe('a11y-boot.js ↔ applyToDocument parity (color-blind excluded)', () => {
  SAMPLES.forEach((raw, i) => {
    it(`sample ${i}`, () => {
      localStorage.setItem('vireek-a11y-settings', JSON.stringify(raw));
      new Function(bootSource)();
      const boot = { classes: MANAGED_CLASSES.filter((c) => root.classList.contains(c)).sort(), vars: Object.fromEntries(Object.keys(computeRenderState(sanitizeSettings({})).vars).map((k) => [k, root.style.getPropertyValue(k)])) };
      root.removeAttribute('style'); root.className = '';
      applyToDocument(sanitizeSettings(raw));
      const react = computeRenderState(sanitizeSettings(raw));
      expect(boot.classes).toEqual([...react.classes].sort());
      expect(boot.vars).toEqual(react.vars);
    });
  });
  it('corrupt JSON does not throw', () => {
    localStorage.setItem('vireek-a11y-settings', '{oops');
    expect(() => new Function(bootSource)()).not.toThrow();
  });
});
