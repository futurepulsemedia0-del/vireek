// scripts/color/palette.mjs — Vireek "Signal" colour system: SINGLE SOURCE OF TRUTH.
//
// Everything is declared in OKLCH ([L, C, h]) and solved against WCAG 2.2 contrast targets, so a token can
// never silently drift below AA. `npm run tokens:build` turns this file into CSS variables, Tailwind colours,
// TS/Deno hex constants and the docs table; `npm run test` re-verifies every declared pair.
//
// "Claude-first" brand system. Every seed below is a published colour of one of three reference systems:
//   ANTHROPIC (dominant): Slate #141413, Ivory #FAF9F5, Light Gray #E8E6DC, Mid Gray #B0AEA5, Clay #D97757, Sky #6A9BCC,
//                         Sage #788C5D (+ extracted surface #F0EEE6)       -> neutrals, brand accent (Clay), info (Sky), data-viz
//   APPLE (second):       system Green #34C759/#30D158, Red #FF383C/#FF4245, Yellow #FFCC00/#FFD600 (+ teal/pink/brown in charts)
//                         -> status colours (success / danger / warning)
//   STRIPE (third):       Blurple #635BFF, Lilac #7E6BFD                         -> the "live / AI signal" family (`cta`)
// No other hue is allowed anywhere in the product. Clay = brand/primary action; Blurple (cta) = LIVE / AI signal only.

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
  light: { bg1: [0.981775, 0.005392, 95.0986], bg2: [1, 0, 0], bg3: [0.948457, 0.010853, 95.1664], overlay: [1, 0, 0] }, // Ivory #FAF9F5 / white / #F0EEE6
  dark: { bg1: [0.190839, 0.001983, 106.5859], bg2: [0.225, 0.0032, 106], bg3: [0.26, 0.004, 104], overlay: [0.295, 0.0045, 102] }, // Slate #141413 + warm steps
};
const INK = { light: [0.190839, 0.001983, 106.5859], dark: [0.981775, 0.005392, 95.0986] }; // text-primary: Slate / Ivory
const rgbOf = ([L, C, h]) => oklchToRgb(L, C, h);
const WHITE = [255, 255, 255];
const GRAPHITE = rgbOf([0.190839, 0.001983, 106.5859]); // Anthropic Slate #141413: the "ink" used on bright fills

// ---------------------------------------------------------------- semantic families
// text/fill/graphic seeds are the brand anchors; the solver only moves lightness (never hue) when needed.
// `on` = text colour used on the family's solid fill, per theme.
const FAMILIES = {
  accent: { // Anthropic CLAY #D97757 — brand + primary action
    seed: { light: [0.67242, 0.13084, 38.7559], dark: [0.67242, 0.13084, 38.7559] },
    fillSeed: { light: [0.67242, 0.13084, 38.7559], dark: [0.67242, 0.13084, 38.7559] },
    on: { light: 'ink', dark: 'ink' }, // Slate on Clay = 5.9:1 (the report's measured pairing) -> the fill stays EXACTLY #D97757
    scale: { anchorStep: 500, anchorL: 0.67242 },
  },
  cta: { // Stripe BLURPLE #635BFF (light) / LILAC #7E6BFD (dark) — live / AI signal only
    seed: { light: [0.57843, 0.234615, 278.2909], dark: [0.622379, 0.208774, 284.4749] },
    fillSeed: { light: [0.57843, 0.234615, 278.2909], dark: [0.622379, 0.208774, 284.4749] },
    on: { light: 'white', dark: 'ink' },
    scale: { anchorStep: 500, anchorL: 0.57843 },
  },
  success: { // Apple system GREEN #34C759 / #30D158
    seed: { light: [0.730324, 0.194381, 147.4439], dark: [0.755551, 0.208246, 146.9836] },
    fillSeed: { light: [0.730324, 0.194381, 147.4439], dark: [0.755551, 0.208246, 146.9836] },
    on: { light: 'ink', dark: 'ink' },
    scale: { anchorStep: 500, anchorL: 0.730324 },
  },
  danger: { // Apple system RED #FF383C / #FF4245
    seed: { light: [0.653197, 0.232821, 25.7394], dark: [0.662002, 0.224599, 25.1223] },
    fillSeed: { light: [0.653197, 0.232821, 25.7394], dark: [0.662002, 0.224599, 25.1223] },
    on: { light: 'white', dark: 'white' }, // white-on-red = the expected destructive look; fill is deepened to pass 4.8:1 AND to separate from Clay for deuteranopes (dE 0.023 -> 0.089)
    scale: { anchorStep: 500, anchorL: 0.653197 },
  },
  warning: { // Apple system YELLOW #FFCC00 / #FFD600 (text is solved darker into a gold; the fill stays the exact yellow)
    seed: { light: [0.865209, 0.176828, 90.3816], dark: [0.884795, 0.181642, 94.8972] },
    fillSeed: { light: [0.865209, 0.176828, 90.3816], dark: [0.884795, 0.181642, 94.8972] },
    on: { light: 'ink', dark: 'ink' },
    scale: { anchorStep: 500, anchorL: 0.865209 },
  },
  info: { // Anthropic SKY #6A9BCC
    seed: { light: [0.674177, 0.09015, 249.2918], dark: [0.674177, 0.09015, 249.2918] },
    fillSeed: { light: [0.674177, 0.09015, 249.2918], dark: [0.674177, 0.09015, 249.2918] },
    on: { light: 'ink', dark: 'ink' },
    scale: { anchorStep: 500, anchorL: 0.674177 },
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
  for (const s of STEPS) out[s] = toHex(oklchToRgb(BASE_L[s] + (s === 50 ? 0.015 : 0), 0.006 + 0.006 * (1 - BASE_L[s]), 97));
  return out;
})();

// ---------------------------------------------------------------- data-viz
// 8 categorical colours: hue + chroma are inherited from published colours of the three reference brands (Anthropic Clay /
// Sky / Kraft / Fig / Mid Gray, Apple Blue / Purple / Cyan / Yellow / Brown, Stripe Blurple / Lilac / Navy-range); lightness was
// then optimised by maximin search (OKLab ΔE under normal + protan + deutan + tritan vision, >=3:1 on every surface).
// Constraints: chroma <= 0.17 and no near-black / near-white series (aesthetic evenness). Result: min pairwise ΔE 0.093 (light) / 0.094 (dark); gate is 0.09.
// Series 1 is always brand Clay. Colour alone can NEVER carry meaning: charts must also use VIZ_PATTERNS + VIZ_MARKERS + direct labels.
const VIZ_CAT_OKLCH = {
  light: [[0.62, 0.1308, 38.76], [0.4748, 0.17, 284.47], [0.5258, 0.1294, 359.65], [0.5512, 0.098, 249.29], [0.4509, 0.1403, 90.38], [0.3852, 0.17, 322.51], [0.627, 0.17, 254.09], [0.38, 0.002, 106.59]],
  dark: [[0.6724, 0.1308, 38.76], [0.7011, 0.0971, 249.29], [0.6189, 0.17, 284.47], [0.88, 0.17, 147.44], [0.6, 0.0746, 359.65], [0.784, 0.1356, 55.72], [0.8513, 0.17, 278.29], [0.7386, 0.0129, 96.48]],
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
  const nL = 98; // Anthropic neutrals are warm (hue ~96-107)
  // brand radial wash worst case (bg-gradient-mesh pools at full strength) must not reduce secondary/muted text
  const POOLS = Object.entries(MESH_ALPHA).map(([f, a]) => [a, f]).map(([a, f]) => {
    const [L, C, h] = FAMILIES[f].fillSeed[mode];
    return over(oklchToRgb(L, C, h), a, tok['bg-primary']);
  });
  const solveNeutral = (seedL, C, target) => oklchToRgb(solveL(seedL, C, nL, [...SF, ...POOLS], target, dir), C, nL);
  tok['text-secondary'] = solveNeutral(mode === 'light' ? 0.5 : 0.749863, mode === 'light' ? 0.011 : 0.012863, tgt.secondary);
  tok['text-muted'] = oklchToRgb(solveL(mode === 'light' ? 0.551 : 0.62, 0.009, nL, SF, tgt.muted, dir), 0.009, nL); // never place muted text over .bg-gradient-mesh
  tok['text-placeholder'] = oklchToRgb(solveL(mode === 'light' ? 0.64 : 0.58, 0.012, nL, SF, tgt.placeholder, dir), 0.012, nL); // informational placeholder: AA on every neutral surface
  tok['graphic-muted'] = oklchToRgb(solveL(mode === 'light' ? 0.68 : 0.52, 0.01, nL, SF, tgt.ui, dir), 0.01, nL); // neutral icon/glyph colour (non-text, >= 3:1, WCAG 1.4.11)
  tok['text-inverse'] = mode === 'light' ? rgbOf(SURFACE.light.bg1) : rgbOf(SURFACE.dark.bg1);

  // borders: tier 1 decorative (exempt), tier 2 control borders >= 3:1 (WCAG 1.4.11)
  tok['border-default'] = hc ? solveNeutral(mode === 'light' ? 0.6 : 0.5, 0.01, 4.5) : rgbOf(mode === 'light' ? [0.923736, 0.013538, 97.4518] : [0.3, 0.004, 100]);
  tok['border-strong'] = oklchToRgb(solveL(mode === 'light' ? 0.7 : 0.5, 0.01, 97, SF, hc ? 4.5 : 3.2, dir), 0.01, 97);

  // always-dark "inverse" panel (marketing dark sections / code blocks) — identical meaning in both themes
  const inv = rgbOf(mode === 'light' ? INK.light : [0.27, 0.004, 104]);
  tok['surface-inverse'] = inv;
  tok['on-inverse'] = rgbOf([0.981775, 0.005392, 95.0986]);
  tok['on-inverse-muted'] = oklchToRgb(solveL(0.749863, 0.012863, 96.4777, [inv], hc ? 7 : 5.2, +1), 0.012863, 96.4777);
  tok['border-inverse'] = oklchToRgb(solveL(0.45, 0.01, 98, [inv], 3.2, +1), 0.01, 98);

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

  // brand gradient (Clay -> Blurple). ONE on-colour must clear BOTH ends:
  //   light themes: white text on both ends, each end deepened (hue kept) until white passes 4.8:1 (7:1 in HC);
  //   dark themes : Slate text on both ends, each end kept at its exact brand colour (Clay / Lilac) or lightened until Slate passes.
  // (White on exact Clay is only 3.1:1, so the light gradient cannot use the plain accent fill.)
  {
    const onInk = mode === 'dark';
    const onRgb = onInk ? (hc ? [0, 0, 0] : GRAPHITE) : WHITE;
    const end = (fam) => { const [L, C, h] = FAMILIES[fam].fillSeed[mode]; return oklchToRgb(solveL(L, C, h, [onRgb], tgt.on, onInk ? +1 : -1), C, h); };
    tok['brand-from'] = end('accent');
    tok['brand-to'] = end('cta');
    tok['on-brand'] = onRgb;
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
  tok['disabled-bg'] = oklchToRgb(mode === 'light' ? 0.94 : 0.24, 0.006, 97);
  tok['disabled-fg'] = oklchToRgb(mode === 'light' ? 0.66 : 0.5, 0.008, 97);
  tok['text-disabled'] = tok['disabled-fg']; // EXEMPT from contrast (WCAG 1.4.3: inactive components) — never use for readable content
  tok['overlay'] = mode === 'light' ? [20, 20, 19] : [0, 0, 0]; // light scrim = Slate
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
    tok[`viz-seq-${i + 1}`] = oklchToRgb(L, 0.13 * Math.sin(Math.PI * (0.15 + 0.75 * t)) + 0.015, 249.2918);
  }
  for (let i = 0; i < 9; i++) {
    const d = (i - 4) / 4; // -1 .. +1 ; centre is neutral, ends are saturated and darker (light) / lighter (dark)
    tok[`viz-div-${i + 1}`] = oklchToRgb(mode === 'light' ? 0.95 - Math.abs(d) * 0.45 : 0.3 + Math.abs(d) * 0.48, 0.13 * Math.abs(d) + 0.005, d < 0 ? 249.2918 : 38.7559);
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
  // High-contrast: a 7:1 fill is necessarily dark (light) / light (dark), so its edge vs the page can't also reach 3:1 — the label (7:1) carries identification, as for every other *-fill.
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
