// scripts/color/contrast.test.mjs — CI gate for the colour system (runs with `npm test`).
// Fails the build when: any declared fg/bg pair drops below its WCAG threshold in ANY theme (light, dark,
// light-HC, dark-HC), generated files drift from palette.mjs, a referenced CSS variable does not exist, or the
// browser/native surfaces (theme-color, manifest, Capacitor) stop matching the brand tokens.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, buildTheme, declaredPairs } from './palette.mjs';
import { tailwindTheme } from './tailwind-colors.mjs';
import { contrast, toHex, simulate, deltaE, rgbToOklab } from './oklch.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const css = read('src/styles/tokens.generated.css');

describe.each(THEMES)('contrast gate — %s', (theme) => {
  const pairs = declaredPairs(theme);
  it('has pairs', () => expect(pairs.length).toBeGreaterThan(100));
  it.each(pairs.map((p) => [`${p.fg} on ${p.bg} (${p.label}) >= ${p.min}`, p]))('%s', (_n, p) => {
    expect(contrast(p.fgRgb, p.bgRgb)).toBeGreaterThanOrEqual(p.min);
  });
});

describe('brand anchors stay put (the change must stay near-invisible)', () => {
  const L = buildTheme('light').tok, D = buildTheme('dark').tok;
  it('cobalt', () => { expect(toHex(L['accent-text'])).toBe('#203AD8'); expect(toHex(L['accent-fill'])).toBe('#203AD8'); });
  it('copper graphic (light) and copper fill (dark)', () => { expect(toHex(L['cta-graphic'])).toBe('#D6582A'); expect(toHex(D['cta-fill'])).toBe('#FF8A5A'); });
  it('control borders are >= 3:1 on every surface', () => {
    for (const k of ['bg-primary', 'bg-secondary', 'bg-tertiary']) {
      expect(contrast(L['border-strong'], L[k])).toBeGreaterThanOrEqual(3);
      expect(contrast(D['border-strong'], D[k])).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('generated artefacts are in sync with palette.mjs', () => {
  it('every token of every theme appears verbatim in tokens.generated.css', () => {
    for (const t of THEMES) for (const [k, v] of Object.entries(buildTheme(t).tok)) expect(css).toContain(`--${k}: ${v.join(' ')};`);
  });
  it('TS constants match', () => {
    const ts = read('src/styles/tokens.generated.ts');
    expect(ts).toContain(`"bg-primary": "${toHex(buildTheme('light').tok['bg-primary'])}"`);
  });
});

describe('every CSS variable that is referenced exists', () => {
  const defined = new Set([...css.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]));
  const indexCss = read('src/index.css');
  for (const m of indexCss.matchAll(/--([a-z0-9-]+):/g)) defined.add(m[1]);
  it('tailwind theme only references defined variables', () => {
    const used = new Set([...JSON.stringify(tailwindTheme).matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]));
    for (const u of used) expect(defined.has(u), `--${u} missing`).toBe(true);
  });
  it('src/ only uses rgb(var(--token)) with defined tokens', () => {
    const bad = [];
    (function walk(d) {
      for (const e of readdirSync(d)) {
        const f = join(d, e);
        if (statSync(f).isDirectory()) { if (e !== 'node_modules') walk(f); continue; }
        if (!['.ts', '.tsx', '.css'].includes(extname(e)) || /tokens\.generated/.test(f)) continue;
        for (const m of readFileSync(f, 'utf8').matchAll(/rgba?\(\s*var\(--([a-z0-9-]*[a-z0-9])\)/g)) if (!defined.has(m[1])) bad.push(`${f.replace(ROOT, '')}: --${m[1]}`);
      }
    })(join(ROOT, 'src'));
    expect(bad).toEqual([]);
  });
});

describe('browser / native surfaces match the brand tokens', () => {
  const lightBg = toHex(buildTheme('light').tok['bg-primary']);
  const darkBg = toHex(buildTheme('dark').tok['bg-primary']);
  it('index.html theme-color (default = light page surface) + inline script values', () => {
    const html = read('index.html');
    expect(html).toMatch(new RegExp(`<meta name="theme-color" content="${lightBg}"`, 'i'));
    expect(html.toUpperCase()).toContain(darkBg);
  });
  it('web manifest', () => {
    const m = JSON.parse(read('public/site.webmanifest'));
    expect(m.theme_color.toUpperCase()).toBe(lightBg);
    expect(m.background_color.toUpperCase()).toBe(lightBg);
  });
  it('Capacitor splash/background use the dark surface', () => {
    const c = read('capacitor.config.ts').toUpperCase();
    expect(c).not.toContain('#000000');
    expect(c).toContain(darkBg);
  });
});

describe('data-viz', () => {
  for (const t of ['light', 'dark']) {
    const tok = buildTheme(t).tok;
    const cols = [...Array(8)].map((_, i) => tok[`viz-${i + 1}`]);
    it(`${t}: 8 categorical colours stay distinguishable under protan/deutan/tritan vision (ΔE >= 0.09)`, () => {
      for (const kind of [null, 'protanopia', 'deuteranopia', 'tritanopia']) {
        const s = kind ? cols.map((c) => simulate(c, kind)) : cols;
        for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) expect(deltaE(s[i], s[j]), `${kind ?? 'normal'} ${i + 1}/${j + 1}`).toBeGreaterThanOrEqual(0.09);
      }
    });
    it(`${t}: sequential scale is monotonic in lightness (grayscale-safe)`, () => {
      const Ls = [...Array(9)].map((_, i) => rgbToOklab(tok[`viz-seq-${i + 1}`])[0]);
      const dir = Math.sign(Ls[8] - Ls[0]);
      for (let i = 1; i < 9; i++) expect((Ls[i] - Ls[i - 1]) * dir).toBeGreaterThan(0);
    });
  }
});

describe.each(THEMES)('text hierarchy — %s', (theme) => {
  const tok = buildTheme(theme).tok;
  const hc = theme.endsWith('-hc');
  const surfaces = ['bg-primary', 'bg-secondary', 'bg-tertiary', 'surface-overlay'];
  const AA = hc ? 7 : 4.5;
  it.each(['text-secondary', 'text-muted', 'text-placeholder'])('%s meets AA on every neutral surface', (t) => {
    for (const s of surfaces) expect(contrast(tok[t], tok[s]), `${t} on ${s}`).toBeGreaterThanOrEqual(AA);
  });
  it('graphic-muted (icons) meets 3:1 on every neutral surface', () => {
    for (const s of surfaces) expect(contrast(tok['graphic-muted'], tok[s]), `graphic-muted on ${s}`).toBeGreaterThanOrEqual(hc ? 4.5 : 3);
  });
  it('hierarchy is carried by the tokens: primary > secondary > muted >= placeholder', () => {
    const c = (t: string) => contrast(tok[t], tok['bg-primary']);
    expect(c('text-primary')).toBeGreaterThan(c('text-secondary'));
    expect(c('text-secondary')).toBeGreaterThan(c('text-muted'));
    expect(c('text-muted')).toBeGreaterThanOrEqual(c('text-placeholder'));
  });
  it('text-disabled is declared as EXEMPT (no AA claim) and is the only token allowed below AA', () => {
    const p = declaredPairs(theme).filter((x) => x.fg === 'text-disabled');
    expect(p).toHaveLength(1);
    expect(p[0].min).toBe(1);
    expect(p[0].label).toContain('EXEMPT');
  });
  it('every declared text-* / *-text pair is >= its minimum (no silent alpha)', () => {
    for (const p of declaredPairs(theme).filter((x) => /^(text-|.*-text$)/.test(x.fg) && x.fg !== 'text-disabled')) expect(contrast(p.fgRgb, p.bgRgb), `${p.fg} on ${p.bg}`).toBeGreaterThanOrEqual(p.min);
  });
});
