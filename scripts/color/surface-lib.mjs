// scripts/color/surface-lib.mjs — shared by check-surfaces.mjs (gate) and fix-surfaces.mjs (verified autofix).
// Parses ONE class-string and returns its worst-case WCAG contrast over every theme, every page surface and every
// interaction state it declares (base, hover:, focus:, active:, disabled:, aria-/data- …, responsive prefixes, dark:).
import { THEMES, buildTheme, FAMILY_NAMES, FAMILY_DEFS, buildScale, NEUTRAL_SCALE } from './palette.mjs';
import { contrast, over, hexToRgb } from './oklch.mjs';

export const MIN = 4.5;
export const MIN_ICON = 3; // WCAG 1.4.11 — icon-only containers (square, no text size/weight class) need 3:1, not 4.5:1
export const EXEMPT = /(tokens\.generated|[\\/]test[\\/]|\.test\.|\.spec\.|TokensPreview|DevColorsPage|DevStates)/;

const toks = Object.fromEntries(THEMES.map((t) => [t, buildTheme(t).tok]));
const scales = Object.fromEntries(FAMILY_NAMES.map((f) => [f, Object.fromEntries(Object.entries(buildScale({ ...FAMILY_DEFS[f] })).map(([k, v]) => [k, hexToRgb(v)]))]));
const graphite = Object.fromEntries(Object.entries(NEUTRAL_SCALE).map(([k, v]) => [k, hexToRgb(v)]));
const SURFACES = ['bg-primary', 'bg-secondary', 'bg-tertiary', 'surface-overlay'];
const RESPONSIVE = new Set(['sm', 'md', 'lg', 'xl', '2xl']);

/** Resolve a colour NAME (what follows the utility prefix) to an RGB triple for a theme, or null if unknown. */
function resolve(util, name, theme) {
  const tok = toks[theme];
  const isText = util === 'text';
  let m;
  if ((m = name.match(/^(accent|cta|success|danger|warning|info)-(\d{2,3})$/))) return scales[m[1]]?.[m[2]] ?? null;
  if ((m = name.match(/^graphite-(\d{2,3})$/))) return graphite[m[1]] ?? null;
  if (FAMILY_NAMES.includes(name)) return tok[`${name}-${isText ? 'text' : 'fill'}`] ?? null;
  if (name === 'white') return [255, 255, 255];
  if (name === 'black') return [0, 0, 0];
  if (name === 'transparent' || name === 'current') return null;
  return tok[name] ?? null;
}

const UTIL_RE = /^(bg|text|from|via|to)-(.+?)(?:\/(\d{1,3}))?$/;
const SIZE_RE = /^(xs|sm|base|lg|xl|[2-9]xl|center|left|right|start|end|justify|wrap|nowrap|balance|pretty|ellipsis|clip|\[.*)$/;

/** -> { classes: [{variants:[…non-dark], dark, util, name, alpha, order}], gradient, icon, skipped } */
export function parseLiteral(str) {
  const classes = []; let gradient = false, skipped = 0, hasTextSize = false, square = false;
  const dims = {};
  str.split(/\s+/).filter(Boolean).forEach((raw, order) => {
    const parts = raw.split(':'); const core = parts.pop();
    const dark = parts.includes('dark'); const variants = parts.filter((p) => p !== 'dark');
    if (/^bg-gradient-to-/.test(core)) { gradient = true; return; }
    let m;
    if (!variants.length && !dark) {
      if ((m = core.match(/^(?:text-(?:xs|sm|base|lg|xl|[2-9]xl|\[.*\])|font-[a-z]+)$/))) hasTextSize = true;
      if ((m = core.match(/^([hw])-(\d+(?:\.\d+)?)$/))) dims[m[1]] = m[2];
      if ((m = core.match(/^size-(\d+(?:\.\d+)?)$/))) { dims.h = m[1]; dims.w = m[1]; }
    }
    m = core.match(UTIL_RE);
    if (!m) return;
    const [, util, name, a] = m;
    if (util === 'text' && SIZE_RE.test(name)) return;
    if (name.startsWith('[')) { skipped++; return; }
    classes.push({ variants, dark, util, name, alpha: a === undefined ? 1 : +a / 100, order });
  });
  square = dims.h !== undefined && dims.h === dims.w;
  return { classes, gradient, skipped, icon: square && !hasTextSize };
}

const isDark = (t) => t.startsWith('dark');

function scenariosOf(p) {
  const keys = [...new Set(p.classes.flatMap((c) => c.variants))];
  const resp = keys.filter((k) => RESPONSIVE.has(k));
  const states = keys.filter((k) => !RESPONSIVE.has(k));
  const out = [[]];
  for (const k of states) out.push([k]);
  if (resp.length) { out.push(resp); for (const k of states) out.push([...resp, k]); }
  return out;
}

/** Effective class per util for a scenario/theme: more specific (more variants, dark) wins; ties by source order. */
function effective(p, scenario, theme) {
  const eff = {};
  const applicable = p.classes.filter((c) => c.variants.every((v) => scenario.includes(v)) && (!c.dark || isDark(theme)));
  applicable.sort((a, b) => (a.variants.length + (a.dark ? 1 : 0)) - (b.variants.length + (b.dark ? 1 : 0)) || a.order - b.order);
  for (const c of applicable) eff[c.util] = c;
  return eff;
}

/** Worst-case contrast of one parsed literal; null if it has no analysable fg/bg pair. -> {ratio,min,theme,fg,bg,kind,scenario} */
export function evaluate(p) {
  let worst = null;
  const min = p.icon ? MIN_ICON : MIN;
  for (const scenario of scenariosOf(p)) for (const theme of THEMES) {
    const eff = effective(p, scenario, theme);
    const tx = eff.text; if (!tx) continue;
    const stops = p.gradient ? ['from', 'via', 'to'].map((k) => eff[k]).filter(Boolean) : [eff.bg].filter(Boolean);
    if (!stops.length) continue;
    const fg0 = resolve('text', tx.name, theme); if (!fg0) continue;
    // explicit static-* backgrounds are media overlays (video / photo / dark sheet): their backdrop is the media, assumed dark
    const staticBg = stops.every((s) => s.name.startsWith('static-'));
    const backdrops = staticBg ? [toks[theme]['static-black']] : SURFACES.map((s) => toks[theme][s]);
    const opaque = stops.every((s) => s.alpha === 1);
    for (const bd of backdrops) {
      const bgs = stops.map((s) => { const c = resolve('bg', s.name, theme); return c ? over(c, s.alpha, bd) : null; });
      if (bgs.some((b) => !b)) continue;
      for (const bg of bgs) {
        const fg = tx.alpha < 1 ? over(fg0, tx.alpha, bg) : fg0;
        const r = contrast(fg, bg);
        if (!worst || r - min < worst.ratio - worst.min) worst = { ratio: r, min, theme, fg: tx.name, bg: stops.map((s) => `${s.name}${s.alpha < 1 ? '/' + Math.round(s.alpha * 100) : ''}`).join('→'), kind: p.gradient ? 'gradient' : opaque ? 'opaque' : 'translucent', scenario: scenario.join('+') || 'base' };
      }
    }
  }
  return worst;
}
export const fails = (w) => !!w && w.ratio < w.min - 1e-9;

/** Template literal → every combination of its `${…}` branches (ternaries / && / maps), capped. Cross-branch pairs become visible. */
export function expandTemplate(tpl) {
  const exprs = []; let base = '';
  for (let i = 0; i < tpl.length; i++) {
    if (tpl[i] === '$' && tpl[i + 1] === '{') {
      let depth = 1, j = i + 2;
      while (j < tpl.length && depth) { if (tpl[j] === '{') depth++; else if (tpl[j] === '}') depth--; j++; }
      const inner = tpl.slice(i + 2, j - 1);
      const alts = [...inner.matchAll(/(['"])((?:(?!\1).)*)\1/g)].map((m) => m[2]);
      exprs.push(alts.length ? ['', ...alts] : ['']);
      base += ' '; i = j - 1;
    } else base += tpl[i];
  }
  let combos = [base];
  for (const alts of exprs) {
    if (combos.length * alts.length > 64) break;
    combos = combos.flatMap((c) => alts.map((a) => `${c} ${a}`));
  }
  return combos;
}
