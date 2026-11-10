// @vitest-environment node
import { describe, it, expect } from 'vitest';
import resolveConfig from 'tailwindcss/resolveConfig.js';
import config from '../../tailwind.config.js';
import { TYPE_SCALE, MIN_REM, ROOT_PX, assertScale, toTailwindFontSize, TYPE_UTILITIES } from './type-scale.mjs';

const stock = resolveConfig({ content: [] }).theme.fontSize;
const resolved = resolveConfig(config).theme.fontSize;

describe('type scale — invariants', () => {
  it('has no token below the 12px floor (0.75rem)', () => {
    for (const t of TYPE_SCALE) expect(t.rem * ROOT_PX, t.name).toBeGreaterThanOrEqual(MIN_REM * ROOT_PX);
    expect(MIN_REM * ROOT_PX).toBe(12);
  });
  it('line-height is never smaller than the font size (WCAG 1.4.12 headroom)', () => {
    for (const t of TYPE_SCALE) {
      const lh = String(t.lineHeight).endsWith('rem') ? parseFloat(t.lineHeight) : parseFloat(t.lineHeight) * t.rem;
      expect(lh, t.name).toBeGreaterThanOrEqual(t.rem);
    }
  });
  it('has unique names and aliases, and every role is documented', () => {
    expect(new Set(TYPE_SCALE.map((t) => t.name)).size).toBe(TYPE_SCALE.length);
    expect(new Set(TYPE_SCALE.filter((t) => t.alias).map((t) => t.alias)).size).toBe(TYPE_SCALE.filter((t) => t.alias).length);
    for (const t of TYPE_SCALE) {
      expect(t.role.length, t.name).toBeGreaterThan(5);
      expect(t.guidance.length, t.name).toBeGreaterThan(2);
    }
    expect(TYPE_UTILITIES.map((u) => u.className)).toEqual(expect.arrayContaining(['type-figure', 'type-id', 'type-inline']));
  });
  it('refuses a scale that breaks the floor or reuses a name', () => {
    expect(() => assertScale([{ name: 'x', alias: null, rem: 0.6875, lineHeight: '1rem' }])).toThrow(/below the 12px floor/);
    expect(() => assertScale([{ name: 'x', alias: null, rem: 1, lineHeight: '1.5rem' }, { name: 'x', alias: null, rem: 1, lineHeight: '1.5rem' }])).toThrow(/duplicate/);
    expect(() => assertScale([{ name: 'x', alias: null, rem: 1, lineHeight: '0.5rem' }])).toThrow(/line-height/);
  });
});

describe('type scale — Tailwind integration', () => {
  it('stock aliases are byte-identical to Tailwind defaults (zero visual change for existing text-xs…6xl)', () => {
    for (const k of ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl']) {
      expect(JSON.stringify(resolved[k]), k).toBe(JSON.stringify(stock[k]));
    }
  });
  it('aliases never force weight or tracking (would override inherited values on ~20k call sites)', () => {
    const m = toTailwindFontSize();
    for (const t of TYPE_SCALE.filter((x) => x.alias)) {
      expect(Object.keys(m[t.alias][1]), t.alias).toEqual(['lineHeight']);
    }
  });
  it('every semantic token resolves in the real theme with the documented size', () => {
    for (const t of TYPE_SCALE) expect(resolved[t.name][0], t.name).toBe(`${t.rem}rem`);
  });
  it('no resolved size anywhere in the theme is below 0.75rem', () => {
    for (const [k, v] of Object.entries(resolved)) {
      const size = Array.isArray(v) ? v[0] : v;
      expect(parseFloat(size) * (String(size).endsWith('rem') ? ROOT_PX : 1), k).toBeGreaterThanOrEqual(12);
    }
  });
});
