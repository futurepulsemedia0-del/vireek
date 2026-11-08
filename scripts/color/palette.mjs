// scripts/color/palette.mjs — Vireek "Signal" colour system: SINGLE SOURCE OF TRUTH.
//
// Everything is declared in OKLCH ([L, C, h]) and solved against WCAG 2.2 contrast targets, so a token can
// never silently drift below AA. `npm run tokens:build` turns this file into CSS variables, Tailwind colours,
// TS/Deno hex constants and the docs table; `npm run test` re-verifies every declared pair.
//
// Brand anchors (unchanged from the previous system, so the visual change is near-invisible):
//   cobalt  #203AD8 (light) / #6C82FF (dark)      copper  #D6582A (graphic) / #FF8A5A (dark)
// Copper keeps its meaning: LIVE / URGENT only — never decorative, never a generic CTA.

import { oklchToRgb, contrast, solveL, over, toHex, rgbToOklch } from './oklch.mjs';

export const THEMES = ['light', 'dark', 'light-hc', 'dark-hc'];

// ---------------------------------------------------------------- thresholds
export const MIN = { text: 4.5, textAAA: 7, ui: 3, large: 3 };
// Solver targets carry a safety margin over the AA minimum (rounding to 8-bit, anti-aliasing, compositing).
const T = { text: 4.8, strong: 7.0, ui: 3.3, secondary: 5.6, muted: 4.65, placeholder: 4.6, on: 4.8 };
const HC = { text: 7.0, ui: 4.5, secondary: 7.0, muted: 7.0, placeholder: 7.0, on: 7.0 };

// Peak alpha of the brand radial wash (.bg-gradient-mesh). Was .22/.16 — lowered so secondary text keeps AA
// without darkening the whole neutral ramp. Used by the solver AND emitted into the CSS.
export const MESH_ALPHA = { accent: 0.14, cta: 0.1 };

// ---------------------------------------------------------------- surfaces & neutrals (OKLCH)
const SURFACE = {
  light: { bg1: [0.9913, 0.0029, 84.6], bg2: [1, 0, 0], bg3: [0.9676, 0.0057, 84.6], overlay: [1, 0, 0] },
  dark: { bg1: [0.145, 0.0067, 270.5], bg2: [0.1784, 0.0084, 274.4], bg3: [0.2102, 0.01, 276.6], overlay: [0.245, 0.0105, 277] },
};
const INK = { light: [0.2059, 0.0059, 285.9], dark: [0.9581, 0.0041, 91.4] }; // text-primary
const rgbOf = ([L, C, h]) => oklchToRgb(L, C, h);
const WHITE = [255, 255, 255];
const GRAPHITE = rgbOf([0.2059, 0.0059, 285.9]); // 17 17 1A-ish: the "ink" used on bright fills

// ---------------------------------------------------------------- semantic families
// text/fill/graphic seeds are the brand anchors; the solver only moves lightness (never hue) when needed.
// `on` = text colour used on the family's solid fill, per theme.
const FAMILIES = {
  accent: {
    seed: { light: [0.4562, 0.2377, 267.0], dark: [0.6519, 0.1856, 272.7] },
    fillSeed: { light: [0.4562, 0.2377, 267.0], dark: [0.6519, 0.1856, 272.7] },
    on: { light: 'white', dark: 'white' },
    scale: { anchorStep: 600, anchorL: 0.4562 },
  },
  cta: { // copper — live / urgent only
    seed: { light: [0.6164, 0.1694, 39.2], dark: [0.7531, 0.1554, 42.3] },
    fillSeed: { light: [0.6164, 0.1694, 39.2], dark: [0.7531, 0.1554, 42.3] },
    on: { light: 'white', dark: 'ink' },
    scale: { anchorStep: 500, anchorL: 0.6164 },
  },
  success: {
    seed: { light: [0.5441, 0.1163, 160.2], dark: [0.7449, 0.1408, 159.3] },
    fillSeed: { light: [0.5441, 0.1163, 160.2], dark: [0.7449, 0.1408, 159.3] },
    on: { light: 'white', dark: 'ink' },
    scale: { anchorStep: 600, anchorL: 0.5441 },
  },
  danger: {
    seed: { light: [0.5494, 0.1888, 26.0], dark: [0.6793, 0.1734, 22.9] },
    fillSeed: { light: [0.5494, 0.1888, 26.0], dark: [0.6793, 0.1734, 22.9] },
    on: { light: 'white', dark: 'ink' },
    scale: { anchorStep: 600, anchorL: 0.5494 },
  },
  warning: {
    seed: { light: [0.5454, 0.1185, 62.3], dark: [0.7821, 0.1368, 74.7] },
    fillSeed: { light: [0.7686, 0.1647, 70.1], dark: [0.7821, 0.1368, 74.7] }, // bright amber + ink text
    on: { light: 'ink', dark: 'ink' },
    scale: { anchorStep: 500, anchorL: 0.7686 },
  },
  info: { // NEW semantic colour — hue deliberately distinct from cobalt (267) so info != brand
    seed: { light: [0.5876, 0.1389, 242.0], dark: [0.7535, 0.139, 232.7] },
    fillSeed: { light: [0.5876, 0.1389, 242.0], dark: [0.7535, 0.139, 232.7] },
    on: { light: 'white', dark: 'ink' },
    scale: { anchorStep: 600, anchorL: 0.5876 },
  },
};

// ---------------------------------------------------------------- scales 50–950 (perceptually even lightness)
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const BASE_L = { 50: 0.975, 100: 0.945, 200: 0.895, 300: 0.82, 400: 0.73, 500: 0.64, 600: 0.55, 700: 0.46, 800: 0.38, 900: 0.3, 950: 0.22 };
const chromaCurve = (L) => Math.min(1, 0.25 + 1.1 * (1 - Math.abs(L - 0.62) / 0.5)); // bell around mid-lightness
export function buildScale({ seed, fillSeed, scale }) {
  const [, C, h] = (scale.anchorStep === 500 && fillSeed.light[0] === scale.anchorL ? fillSeed : seed).light;
  const aL = scale.anchorL, bs = BASE_L[scale.anchorStep];
  const out = {};
  for (const s of STEPS) {
    const b = BASE_L[s];
    const L = b >= bs ? aL + ((b - bs) * (0.975 - aL)) / (0.975 - bs) : aL - ((bs - b) * (aL - 0.22)) / (bs - 0.22);
    const c = s === scale.anchorStep ? C : C * Math.max(0.08, chromaCurve(L)) * 0.9;
    out[s] = toHex(oklchToRgb(L, c, h));
  }
  return out;
}
export const NEUTRAL_SCALE = (() => {
  const out = {};
  for (const s of STEPS) out[s] = toHex(oklchToRgb(BASE_L[s] + (s === 50 ? 0.015 : 0), 0.006 + 0.006 * (1 - BASE_L[s]), 85));
  return out;
})();

// ---------------------------------------------------------------- data-viz
// 8 categorical colours found by maximin search (OKLab ΔE under normal + protan + deutan + tritan vision, >=3.3:1 on
// every surface). Result: min pairwise ΔE 0.102 (light) / 0.111 (dark) — see docs/design/COLOR_TOKENS.md.
// Copper hues (≈18–62°) are excluded: copper is reserved for live/urgent. Series 1 is brand cobalt.
// Colour alone can NEVER carry meaning: charts must also use VIZ_PATTERNS + VIZ_MARKERS + direct labels.
const VIZ_CAT_OKLCH = {
  light: [[0.58, 0.16, 270], [0.48, 0.12, 282], [0.34, 0.2, 288], [0.34, 0.16, 336], [0.48, 0.12, 354], [0.58, 0.12, 6], [0.4, 0.08, 96], [0.52, 0.12, 102]],
  dark: [[0.64, 0.2, 276], [0.76, 0.12, 216], [0.88, 0.12, 198], [0.8, 0.08, 126], [0.88, 0.16, 102], [0.72, 0.16, 84], [0.64, 0.16, 18], [0.62, 0.12, 318]],
};

// ---------------------------------------------------------------- the solver
function surfaces(mode) {
  const s = SURFACE[mode];
  return { bg1: rgbOf(s.bg1), bg2: rgbOf(s.bg2), bg3: rgbOf(s.bg3), overlay: rgbOf(s.overlay) };
}

/** Build every token (rgb triple) for one theme. */
export function buildTheme(theme) {
  const mode = theme.startsWith('dark') ? 'dark' : 'light';
  const hc = theme.endsWith('-hc');
  const dir = mode === 'light' ? -1 : +1; // direction that INCREASES contrast against the page
  const tgt = hc ? HC : T;
  const S = surfaces(mode);
  const surf = [S.bg1, S.bg2, S.bg3, S.overlay];
  const tok = {};
  const meta = {}; // documentation: purpose

  // surfaces (high-contrast: pure extremes)
  if (hc) {
    const b = mode === 'light' ? WHITE : [0, 0, 0];
    tok['bg-primary'] = b; tok['bg-secondary'] = b;
    tok['bg-tertiary'] = mode === 'light' ? [240, 240, 240] : [20, 20, 20];
    tok['surface-overlay'] = mode === 'light' ? WHITE : [12, 12, 12];
  } else {
    tok['bg-primary'] = S.bg1; tok['bg-secondary'] = S.bg2; tok['bg-tertiary'] = S.bg3; tok['surface-overlay'] = S.overlay;
  }
  const SF = [tok['bg-primary'], tok['bg-secondary'], tok['bg-tertiary'], tok['surface-overlay']];

  // text
  tok['text-primary'] = hc ? (mode === 'light' ? [0, 0, 0] : WHITE) : rgbOf(INK[mode]);
  const nL = mode === 'light' ? 285.9 : 286;
  // brand radial wash worst case (bg-gradient-mesh pools at full strength) must not reduce secondary/muted text
  const POOLS = Object.entries(MESH_ALPHA).map(([f, a]) => [a, f]).map(([a, f]) => {
    const [L, C, h] = FAMILIES[f].fillSeed[mode];
    return over(oklchToRgb(L, C, h), a, tok['bg-primary']);
  });
  const solveNeutral = (seedL, C, target) => oklchToRgb(solveL(seedL, C, nL, [...SF, ...POOLS], target, dir), C, nL);
  tok['text-secondary'] = solveNeutral(mode === 'light' ? 0.5169 : 0.6891, mode === 'light' ? 0.014 : 0.013, tgt.secondary);
  tok['text-muted'] = oklchToRgb(solveL(mode === 'light' ? 0.6 : 0.62, 0.012, nL, SF, tgt.muted, dir), 0.012, nL); // never place muted text over .bg-gradient-mesh
  tok['text-placeholder'] = oklchToRgb(solveL(mode === 'light' ? 0.64 : 0.58, 0.012, nL, SF, tgt.placeholder, dir), 0.012, nL); // informational placeholder: AA on every neutral surface
  tok['graphic-muted'] = oklchToRgb(solveL(mode === 'light' ? 0.68 : 0.52, 0.01, nL, SF, tgt.ui, dir), 0.01, nL); // neutral icon/glyph colour (non-text, >= 3:1, WCAG 1.4.11)
  tok['text-inverse'] = mode === 'light' ? rgbOf(SURFACE.light.bg1) : rgbOf(SURFACE.dark.bg1);

  // borders: tier 1 decorative (exempt), tier 2 control borders >= 3:1 (WCAG 1.4.11)
  tok['border-default'] = hc ? solveNeutral(mode === 'light' ? 0.6 : 0.5, 0.01, 4.5) : rgbOf(mode === 'light' ? [0.9221, 0.0071, 88.6] : [0.2664, 0.0131, 279]);
  tok['border-strong'] = oklchToRgb(solveL(mode === 'light' ? 0.7 : 0.5, 0.01, 85, SF, hc ? 4.5 : 3.2, dir), 0.01, 85);

  // always-dark "inverse" panel (marketing dark sections / code blocks) — identical meaning in both themes
  const inv = rgbOf(mode === 'light' ? INK.light : [0.245, 0.0105, 277]);
  tok['surface-inverse'] = inv;
  tok['on-inverse'] = rgbOf([0.96, 0.004, 90]);
  tok['on-inverse-muted'] = oklchToRgb(solveL(0.72, 0.012, 286, [inv], hc ? 7 : 5.2, +1), 0.012, 286);
  tok['border-inverse'] = oklchToRgb(solveL(0.45, 0.01, 286, [inv], 3.2, +1), 0.01, 286);

  // families
  const subtleOf = (f) => oklchToRgb(mode === 'light' ? 0.965 : 0.265, mode === 'light' ? 0.03 : 0.045, f.seed[mode][2]);
  for (const [name, f] of Object.entries(FAMILIES)) {
    const [sL, sC, sh] = f.seed[mode];
    const [fL, fC, fh] = f.fillSeed[mode];
    const subtle = subtleOf(f);
    const surfPlusSubtle = [...SF, subtle];
    const text = oklchToRgb(solveL(sL, sC, sh, surfPlusSubtle, tgt.text, dir), sC, sh);
    const strong = oklchToRgb(solveL(sL, sC, sh, [subtle], hc ? 10 : T.strong, dir), sC, sh);
    const graphic = oklchToRgb(solveL(fL, fC, fh, SF, tgt.ui, dir), fC, fh);
    const onIsWhite = f.on[mode] === 'white';
    const on = onIsWhite ? WHITE : GRAPHITE;
    const fill = oklchToRgb(solveL(fL, fC, fh, [on], tgt.on, onIsWhite ? -1 : +1), fC, fh);
    const fillL = rgbToOklch(fill)[0];
    const shift = onIsWhite ? -1 : +1; // hover/active move AWAY from the `on` colour => contrast only grows
    tok[`${name}-fill`] = fill;
    tok[`on-${name}`] = on;
    tok[`${name}-text`] = text;
    tok[`${name}-graphic`] = graphic;
    tok[`${name}-subtle`] = subtle;
    tok[`${name}-subtle-border`] = oklchToRgb(mode === 'light' ? 0.88 : 0.36, mode === 'light' ? 0.06 : 0.08, sh);
    tok[`${name}-strong`] = strong;
    tok[`${name}-hover`] = oklchToRgb(fillL + 0.04 * shift, fC, fh);
    tok[`${name}-active`] = oklchToRgb(fillL + 0.08 * shift, fC, fh);
  }
  if (hc) { // high-contrast: collapse on-colours to pure extremes and re-solve
    for (const name of Object.keys(FAMILIES)) {
      const f = FAMILIES[name];
      const [fL, fC, fh] = f.fillSeed[mode];
      const on = f.on[mode] === 'white' ? WHITE : [0, 0, 0];
      tok[`on-${name}`] = on;
      tok[`${name}-fill`] = oklchToRgb(solveL(fL, fC, fh, [on], 7, on === WHITE ? -1 : +1), fC, fh);
    }
  }

    // brand gradient (cobalt → copper). ONE on-colour has to clear BOTH ends, and in dark mode the light copper fill
  // (cta-fill, graphite text) can never share a text colour with cobalt — so the copper END is solved darker until white passes.
  // sRGB interpolation of two colours that each clear the target is never lighter than the lighter end (luminance is convex).
  {
    const [cL, cC, ch] = FAMILIES.cta.fillSeed[mode];
    tok['brand-from'] = tok['accent-fill'];
    tok['brand-to'] = oklchToRgb(solveL(cL, cC, ch, [WHITE], tgt.on, -1), cC, ch);
    tok['on-brand'] = WHITE;
  }

  // legacy aliases (kept so every existing `rgb(var(--accent-primary))` keeps working)
  tok['accent-primary'] = tok['accent-text'];
  tok['accent-secondary'] = tok['cta-graphic'];
  tok['success'] = tok['success-text'];
  tok['danger'] = tok['danger-text'];
  tok['warning'] = tok['warning-text'];
  // aliases referenced by existing code that previously pointed at NON-EXISTENT variables (silently invalid colours)
  tok['accent'] = tok['accent-graphic'];
  tok['border'] = tok['border-default'];
  tok['success-500'] = tok['success-graphic'];

  // interaction + system
  tok['focus-ring'] = tok['accent-text'];
  tok['selection-bg'] = tok['accent-subtle-border'];
  tok['selection-fg'] = tok['text-primary'];
  tok['disabled-bg'] = oklchToRgb(mode === 'light' ? 0.94 : 0.24, 0.006, 85);
  tok['disabled-fg'] = oklchToRgb(mode === 'light' ? 0.66 : 0.5, 0.008, 85);
  tok['text-disabled'] = tok['disabled-fg']; // EXEMPT from contrast (WCAG 1.4.3: inactive components) — never use for readable content
  tok['overlay'] = mode === 'light' ? [9, 10, 13] : [0, 0, 0];
  tok['static-white'] = WHITE;
  tok['static-black'] = [0, 0, 0];

  // glass: opaque-enough surface so text passes over the WORST backdrop (pure white or pure black)
  const glassBase = tok['bg-secondary'];
  let alpha = 0.6;
  for (; alpha < 1; alpha += 0.02) {
    const worst = [WHITE, [0, 0, 0]].flatMap((bd) => [over(glassBase, alpha, bd)]);
    if (worst.every((g) => contrast(tok['text-primary'], g) >= 7 && contrast(tok['text-secondary'], g) >= 4.5)) break;
  }
  tok['glass-bg'] = glassBase;
  meta.glassAlpha = Math.min(1, Math.round(alpha * 100) / 100);

  // data-viz: categorical (pre-optimised), sequential (monotonic lightness => grayscale-safe), diverging (accent <-> gold)
  VIZ_CAT_OKLCH[mode].forEach(([L, C, h], i) => { tok[`viz-${i + 1}`] = oklchToRgb(L, C, h); });
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const L = mode === 'light' ? 0.96 - t * 0.6 : 0.3 + t * 0.55;
    tok[`viz-seq-${i + 1}`] = oklchToRgb(L, 0.2 * Math.sin(Math.PI * (0.15 + 0.75 * t)) + 0.02, 267);
  }
  for (let i = 0; i < 9; i++) {
    const d = (i - 4) / 4; // -1 .. +1 ; centre is neutral, ends are saturated and darker (light) / lighter (dark)
    tok[`viz-div-${i + 1}`] = oklchToRgb(mode === 'light' ? 0.95 - Math.abs(d) * 0.45 : 0.3 + Math.abs(d) * 0.48, 0.15 * Math.abs(d) + 0.005, d < 0 ? 267 : 85);
  }
  return { tok, meta, mode, hc };
}

/**
 * Every foreground/background pair the product is allowed to use. Each entry is asserted in CI.
 * min: 4.5 text (AA), 7 for AAA-targeted body text, 3 for UI/graphics/large text.
 */
export function declaredPairs(theme) {
  const { tok, meta } = buildTheme(theme);
  const hc = theme.endsWith('-hc');
  const P = [];
  const add = (fg, bg, min, label) => P.push({ fg, bg, min, label, fgRgb: tok[fg] ?? fg, bgRgb: tok[bg] ?? bg });
  const surfaces = ['bg-primary', 'bg-secondary', 'bg-tertiary', 'surface-overlay'];
  for (const s of surfaces) {
    add('text-primary', s, hc ? 7 : 7, 'body text (AAA)');
    add('text-secondary', s, hc ? 7 : 4.5, 'secondary text');
    add('text-muted', s, hc ? 7 : 4.5, 'muted text');
    add('text-placeholder', s, hc ? 7 : 4.5, 'placeholder text (informational)');
    add('graphic-muted', s, hc ? 4.5 : 3, 'neutral icon / glyph (1.4.11)');
    add('border-strong', s, hc ? 4.5 : 3, 'control border (1.4.11)');
    add('focus-ring', s, 3, 'focus indicator (2.4.11)');
    for (const f of Object.keys(FAMILIES)) {
      add(`${f}-text`, s, hc ? 7 : 4.5, `${f} text`);
      add(`${f}-graphic`, s, hc ? 4.5 : 3, `${f} icon / graphic`);
    }
    for (let i = 1; i <= 8; i++) add(`viz-${i}`, s, 3, `chart series ${i}`);
  }
  add('text-disabled', 'disabled-bg', 1, 'EXEMPT: inactive component (WCAG 1.4.3) — no AA claim, never for readable content');
  add('text-inverse', 'text-primary', 7, 'text on ink panel');
  add('on-inverse', 'surface-inverse', 7, 'text on inverse panel');
  add('on-inverse-muted', 'surface-inverse', hc ? 7 : 4.5, 'muted text on inverse panel');
  add('border-inverse', 'surface-inverse', 3, 'border on inverse panel');
  add('text-primary', 'selection-bg', 7, 'selected text');
  for (const f of Object.keys(FAMILIES)) {
    add(`on-${f}`, `${f}-fill`, hc ? 7 : 4.5, `text on ${f} fill`);
    add(`on-${f}`, `${f}-hover`, 4.5, `text on ${f} hover`);
    add(`on-${f}`, `${f}-active`, 4.5, `text on ${f} active`);
    add(`${f}-strong`, `${f}-subtle`, 7, `${f} text on its tint (AAA)`);
    add(`${f}-text`, `${f}-subtle`, hc ? 7 : 4.5, `${f} text on its tint`);
    add('text-primary', `${f}-subtle`, 7, `body text on ${f} tint`);
    add('text-secondary', `${f}-subtle`, 4.5, `secondary text on ${f} tint`);
  }
  add('on-brand', 'brand-from', hc ? 7 : 4.5, 'text on brand gradient (start)');
  add('on-brand', 'brand-to', hc ? 7 : 4.5, 'text on brand gradient (end)');
  // High-contrast: a white-7:1 fill is necessarily dark, so its edge vs a black page can't also reach 3:1 — the label (7:1) carries identification, as for every other *-fill.
  if (!hc) for (const s of surfaces) { add('brand-from', s, 3, 'brand gradient start vs page (1.4.11)'); add('brand-to', s, 3, 'brand gradient end vs page (1.4.11)'); }
  // translucent / composited surfaces
  const ink = tok['text-primary'], sec = tok['text-secondary'];
  for (const bd of [WHITE, [0, 0, 0]]) {
    const g = over(tok['glass-bg'], meta.glassAlpha, bd);
    P.push({ fg: 'text-primary', bg: `glass over ${toHex(bd)}`, min: 7, label: 'glass surface', fgRgb: ink, bgRgb: g });
    P.push({ fg: 'text-secondary', bg: `glass over ${toHex(bd)}`, min: 4.5, label: 'glass surface', fgRgb: sec, bgRgb: g });
  }
  // brand radial wash (bg-gradient-mesh): worst case = fully-opaque pool centre over bg-primary
  for (const [pool, a] of [['accent-graphic', MESH_ALPHA.accent], ['cta-graphic', MESH_ALPHA.cta]]) {
    const c = over(tok[pool], a, tok['bg-primary']);
    for (const t of ['text-primary', 'text-secondary', 'accent-text']) {
      P.push({ fg: t, bg: `mesh(${pool}@${a})`, min: t === 'text-primary' ? 7 : 4.5, label: 'text over brand gradient', fgRgb: tok[t], bgRgb: c });
    }
  }
  return P;
}

export const FAMILY_NAMES = Object.keys(FAMILIES);
export const FAMILY_DEFS = FAMILIES;
export { rgbOf, toHex };
