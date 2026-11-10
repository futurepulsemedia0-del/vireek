// @vitest-environment node
// Compiles REAL CSS through Tailwind with this repo's config and asserts on what would ship.
import { describe, it, expect, beforeAll } from 'vitest';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import config from '../../tailwind.config.js';
import { TYPE_SCALE, TYPE_UTILITIES } from './type-scale.mjs';

const STOCK = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl'];
const classes = [
  ...TYPE_SCALE.map((t) => `text-${t.name}`),
  ...STOCK.map((k) => `text-${k}`),
  ...TYPE_UTILITIES.map((u) => u.className),
  'py-row', 'gap-dense', 'min-h-target', 'font-mono',
];

async function compile(content) {
  const res = await postcss([tailwindcss({ ...config, content: [{ raw: content.join(' ') }] })]).process('@tailwind base;@tailwind components;@tailwind utilities;', { from: undefined });
  return res.css;
}
const rule = (css, cls) => css.match(new RegExp(`\\.${cls.replace(/[.\\[\\]]/g, '\\$&')}\\s*\\{[^}]*\\}`))?.[0].replace(/\s+/g, ' ');
const px = (v) => { const m = String(v).match(/^([0-9.]+)(rem|px)$/); return m ? parseFloat(m[1]) * (m[2] === 'rem' ? 16 : 1) : NaN; };

let css;
beforeAll(async () => { css = await compile(classes); }, 30000);

describe('compiled Tailwind output', () => {
  it('every semantic token compiles to its documented size and line-height', () => {
    for (const t of TYPE_SCALE) {
      const r = rule(css, `text-${t.name}`);
      expect(r, t.name).toBeTruthy();
      expect(r).toContain(`font-size: ${t.rem}rem`);
      expect(r).toContain(`line-height: ${t.lineHeight}`);
      if (t.weight) expect(r).toContain(`font-weight: ${t.weight}`);
    }
  });
  it('NO absolute font-size anywhere in the output is below 12px (floor holds for the whole base + utilities layer)', () => {
    const sizes = [...css.matchAll(/font-size:\s*([^;}]+)/g)].map((m) => m[1].trim()).filter((v) => /^[0-9.]+(rem|px)$/.test(v));
    expect(sizes.length).toBeGreaterThan(15);
    for (const v of sizes) expect(px(v), v).toBeGreaterThanOrEqual(12);
  });
  it('relative base rules are floored: small / sub / sup', () => {
    expect(css).toMatch(/small\s*\{[^}]*font-size:\s*max\(80%,\s*0\.75rem\)/);
    expect(css).toMatch(/sub,\s*sup\s*\{[^}]*font-size:\s*max\(75%,\s*0\.75rem\)/);
  });
  it('figure / id / inline utilities do what the scale documents', () => {
    expect(rule(css, 'type-figure')).toMatch(/lining-nums tabular-nums/);
    expect(rule(css, 'type-figure')).toContain('letter-spacing: 0');
    const id = rule(css, 'type-id');
    expect(id).toMatch(/monospace/);
    expect(id).toContain('direction: ltr');
    expect(id).toContain('unicode-bidi: isolate');
    expect(id).toMatch(/slashed-zero/);
    expect(rule(css, 'type-inline')).toContain('max(0.9em, 0.75rem)');
  });
  it('fa/ar reset letter-spacing (cursive joining) with specificity above any tracking-* utility', () => {
    expect(css).toMatch(/html:lang\(fa\) \*,\s*html:lang\(ar\) \*\s*\{[^}]*letter-spacing:\s*0/);
  });
  it('compact density changes SPACING variables only and keeps targets >= 2rem (WCAG 2.5.8 needs 24px)', () => {
    const block = css.match(/:root\[data-density="compact"\]\s*\{[^}]*\}/)[0];
    expect(block).not.toMatch(/font|text|line-height/);
    const target = parseFloat(block.match(/--density-target:\s*([0-9.]+)rem/)[1]) * 16;
    expect(target).toBeGreaterThanOrEqual(24);
    expect(rule(css, 'py-row')).toContain('var(--density-row-y');
  });
  it('CONTROL: the check can fail — an arbitrary 11px class compiles to 11px and is caught', async () => {
    const bad = await compile(['text-[11px]']);
    const sizes = [...bad.matchAll(/font-size:\s*([0-9.]+px)/g)].map((m) => px(m[1]));
    expect(Math.min(...sizes)).toBe(11);
  });
});
