#!/usr/bin/env node
// scripts/color/rebrand-hex.mjs — one-shot colour migration + palette-purity gate.
//
//   node scripts/color/rebrand-hex.mjs            DRY RUN: prints what would change, writes nothing
//   node scripts/color/rebrand-hex.mjs --write    applies the migration
//   node scripts/color/rebrand-hex.mjs --verify   exit 1 if ANY colour literal outside the palette is still in the product
//
// Every legacy literal (#hex, %23hex, rgb()/rgba()) is replaced by a member of the new palette (palette.mjs):
//   1) the 25 legacy TOKEN values map to the same-named new token (e.g. #203AD8 -> accent-text, #FDFCFA -> bg-primary);
//   2) the logo SVGs use explicit per-position rules (they need different roles for the same old hex);
//   3) every other literal keeps its OKLCH lightness (so contrast relationships survive) and takes the nearest member of
//      the family chosen by hue (red/orange/yellow/green/blue/violet -> danger/accent(Clay)/warning/success/info(Sky)/cta(Blurple)).
// White (#FFF) and black (#000) are kept: they are part of the Apple/Stripe/Anthropic systems (and masks use #000).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, buildTheme, FAMILY_NAMES, FAMILY_DEFS, buildScale, NEUTRAL_SCALE } from './palette.mjs';
import { rgbToOklch, hexToRgb, toHex, oklchToRgb, contrast } from './oklch.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const WRITE = process.argv.includes('--write');
const VERIFY = process.argv.includes('--verify');

// ------------------------------------------------------------------ scope
const EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.css', '.html', '.svg', '.json', '.webmanifest', '.xml', '.plist', '.swift', '.kt', '.java', '.gradle']);
// Folders skipped ANYWHERE (build output / VCS) and folders skipped only at the repository ROOT or by exact relative path
// (a nested `reports/` or `ops/` folder inside src/ or supabase/ is real product code and MUST be migrated).
const SKIP_ANYWHERE = new Set(['node_modules', '.git', 'dist', 'build']);
const SKIP_ROOT = new Set(['docs', 'patches', 'reports', 'e2e', 'eval', 'load', 'evidence', 'rc', 'vireek-a11y', 'vireek-docs-phase1', 'ops', 'locales']);
const SKIP_PATH = new Set(['scripts/color', 'scripts/brand-audit']);
const SKIP_REL = new Set(['scripts/brand/check-pwa.mjs', 'src/components/brand/Logo.tsx', 'src/components/brand/LogoConstruction.tsx', 'src/components/brand/BrandLogoGuide.tsx']); // 1st: lists BANNED legacy colours; rest: hand-edited (role-specific logo colours) // lists the BANNED legacy colours on purpose
const SKIP_FILE = /(\.test\.|\.spec\.|tokens\.generated|brand-colors\.ts$|package-lock\.json$|\.min\.)/;

// ------------------------------------------------------------------ the new palette (all derived from palette.mjs)
const themeTok = Object.fromEntries(THEMES.map((t) => [t, Object.fromEntries(Object.entries(buildTheme(t).tok).map(([k, v]) => [k, toHex(v)]))]));
const FAMILY_ANCHORS = { accent: ['#F9774C'], cta: ['#533AFD', '#7E6BFD'], success: ['#34C759', '#30D158'], danger: ['#FF383C', '#FF4245', '#FF2D55', '#FF375F'], warning: ['#FFCC00', '#FFD600'], info: ['#0071E3', '#0091FF'] };
const NEUTRAL_ANCHORS = ['#141413', '#FAF9F5', '#F0EEE6', '#E8E6DC', '#B0AEA5', '#73726C']; // Anthropic Slate / Ivory / surface / Light Gray / Mid Gray / muted
const scales = Object.fromEntries(FAMILY_NAMES.map((n) => [n, [...Object.values(buildScale({ ...FAMILY_DEFS[n] })), ...FAMILY_ANCHORS[n]]]));
const neutralSet = [...Object.values(NEUTRAL_SCALE), ...NEUTRAL_ANCHORS];

// Third-party brand marks must stay byte-for-byte as their owners publish them (Google's "G" may not be recoloured).
const THIRD_PARTY = new Set(['#4285F4', '#EA4335', '#FBBC05', '#34A853']);
const ALLOWED = new Set(['#FFFFFF', '#000000', ...THIRD_PARTY]);
for (const t of THEMES) for (const v of Object.values(themeTok[t])) ALLOWED.add(v);
for (const n of FAMILY_NAMES) for (const v of scales[n]) ALLOWED.add(v);
for (const v of neutralSet) ALLOWED.add(v);

// ------------------------------------------------------------------ mapping
const LEGACY_ROLE = {
  '#007B50': 'success-text|light',
  '#090A0D': 'bg-primary|dark',
  '#101115': 'bg-secondary|dark',
  '#168458': 'success-graphic|light',
  '#17171A': 'surface-inverse|light',
  '#17181D': 'bg-tertiary|dark',
  '#203AD8': 'accent-text|light',
  '#24252C': 'border-default|dark',
  '#38BDF8': 'info-text|dark',
  '#4AC78C': 'success-text|dark',
  '#5566E1': 'accent-fill|dark',
  '#56565E': 'text-secondary|light',
  '#6C82FF': 'accent-graphic|dark',
  '#7087FF': 'accent-text|dark',
  '#9A9AA3': 'text-secondary|dark',
  '#9D5B0D': 'warning-text|light',
  '#C83030': 'danger-fill|light',
  '#D6582A': 'cta-graphic|light',
  '#E7E5E0': 'border-default|light',
  '#EBAA46': 'warning-text|dark',
  '#F2F1EE': 'text-primary|dark',
  '#F59E0B': 'warning-fill|light',
  '#F6F4F0': 'bg-tertiary|light',
  '#FDFCFA': 'bg-primary|light',
  '#FF8A5A': 'cta-text|dark',
  // v2 ("Claude-first") token values -> same-named v3 token (so a repo that already ran the v2 migration upgrades in place)
  '#004173': 'viz-seq-2|dark',
  '#005492': 'viz-seq-3|dark',
  '#006020': 'success-strong|light',
  '#0068B1': 'viz-seq-4|dark',
  '#007228': 'success-text|light',
  '#009638': 'success-graphic|light',
  '#082F51': 'viz-seq-1|dark',
  '#0966AC': 'viz-div-1|light',
  '#13273A': 'info-subtle|dark',
  '#141413': 'bg-primary|dark',
  '#152B18': 'success-subtle|dark',
  '#163F65': 'info-subtle-border|dark',
  '#1B4823': 'success-subtle-border|dark',
  '#1C1C1A': 'bg-secondary|dark',
  '#201F1C': 'disabled-bg|dark',
  '#217CCA': 'viz-seq-5|dark',
  '#23223A': 'cta-subtle|dark',
  '#242422': 'bg-tertiary|dark',
  '#253F59': 'viz-seq-9|light',
  '#255480': 'viz-seq-8|light',
  '#265582': 'info-strong|light',
  '#2669A6': 'viz-seq-7|light',
  '#272724': 'surface-inverse|dark',
  '#2C2508': 'warning-subtle|dark',
  '#2D2D2A': 'surface-overlay|dark',
  '#2E2E2C': 'border-default|dark',
  '#2E80C8': 'viz-seq-6|light',
  '#302D2C': 'viz-div-5|dark',
  '#3089EB': 'viz-7|light',
  '#30D158': 'success-text|dark',
  '#346391': 'info-text|light',
  '#34C759': 'success-fill|light',
  '#381C1A': 'danger-subtle|dark',
  '#381D14': 'accent-subtle|dark',
  '#393665': 'cta-subtle-border|dark',
  '#3D4F61': 'viz-div-4|dark',
  '#4097E6': 'viz-seq-5|light',
  '#4176A9': 'viz-4|light',
  '#424241': 'viz-8|light',
  '#4292DC': 'viz-seq-6|dark',
  '#43DE65': 'success-hover|dark',
  '#46D466': 'success-hover|light',
  '#4831D7': 'cta-strong|light',
  '#4A3C00': 'warning-subtle-border|dark',
  '#4E3DE1': 'cta-active|light',
  '#4E7296': 'viz-div-3|dark',
  '#4F3DE2': 'cta-text|light',
  '#5088BF': 'viz-div-2|light',
  '#54EC72': 'success-active|dark',
  '#5586B6': 'info-graphic|light',
  '#5646B6': 'viz-2|light',
  '#56E272': 'success-active|light',
  '#584BEF': 'cta-hover|light',
  '#5BAFFE': 'viz-seq-4|light',
  '#5D5B55': 'text-secondary|light',
  '#5E97CE': 'viz-div-2|dark',
  '#5F463E': 'viz-div-6|dark',
  '#602A27': 'danger-subtle-border|dark',
  '#602C1B': 'accent-subtle-border|dark',
  '#6259FD': 'cta-fill|light',
  '#635BFF': 'cta-graphic|light',
  '#64635E': 'disabled-fg|dark',
  '#65A7E8': 'viz-seq-7|dark',
  '#664F00': 'warning-strong|light',
  '#676660': 'border-inverse|light',
  '#695200': 'viz-5|light',
  '#6A9BCC': 'info-fill|light',
  '#6B0E77': 'viz-6|light',
  '#6C6A65': 'text-muted|light',
  '#6EA4D9': 'viz-2|dark',
  '#76746E': 'border-inverse|dark',
  '#76A7D9': 'info-hover|light',
  '#7ABDFF': 'viz-div-1|dark',
  '#7B7A73': 'border-strong|dark',
  '#7D72E7': 'viz-3|dark',
  '#7E6400': 'warning-text|light',
  '#7E6BFD': 'cta-graphic|dark',
  '#7F6CFE': 'cta-fill|dark',
  '#81B3E5': 'info-text|dark',
  '#82B4E6': 'info-active|light',
  '#82F594': 'viz-4|dark',
  '#83B5E7': 'info-strong|dark',
  '#84AAD1': 'viz-div-3|light',
  '#86847E': 'border-strong|light',
  '#8A7EFF': 'cta-hover|dark',
  '#8BBDEF': 'viz-seq-8|dark',
  '#8EC6FF': 'viz-seq-3|light',
  '#8F3513': 'accent-strong|light',
  '#926050': 'viz-div-7|dark',
  '#93928D': 'disabled-fg|light',
  '#968FFF': 'cta-active|dark',
  '#97968F': 'text-muted|dark',
  '#9F4223': 'accent-text|light',
  '#9F7E00': 'warning-graphic|light',
  '#A14120': 'viz-div-9|light',
  '#A19CFF': 'cta-text|dark',
  '#A44668': 'viz-3|light',
  '#A56D7F': 'viz-5|dark',
  '#A80015': 'danger-strong|light',
  '#A8A6FF': 'cta-strong|dark',
  '#ACAAA1': 'viz-8|dark',
  '#B0AEA5': 'text-secondary|dark',
  '#B3D1F1': 'viz-seq-9|dark',
  '#B86D55': 'viz-div-8|light',
  '#B8CCE2': 'viz-div-4|light',
  '#B90019': 'danger-text|light',
  '#BADBFE': 'info-subtle-border|light',
  '#BB001C': 'danger-active|dark',
  '#BC0019': 'danger-active|light',
  '#BCDDFF': 'viz-seq-2|light',
  '#BEE3C1': 'success-subtle-border|light',
  '#C2CAFF': 'viz-7|dark',
  '#C76747': 'viz-1|light',
  '#C76748': 'accent-graphic|light',
  '#C87B63': 'viz-div-8|dark',
  '#CD9886': 'viz-div-7|light',
  '#CED4FF': 'cta-subtle-border|light',
  '#CF0020': 'danger-hover|dark',
  '#D1001D': 'danger-hover|light',
  '#D97757': 'accent-fill|light',
  '#E01A2B': 'danger-fill|dark',
  '#E1C2B8': 'viz-div-6|light',
  '#E40B24': 'danger-fill|light',
  '#E78363': 'accent-hover|light',
  '#E7D7AB': 'warning-subtle-border|light',
  '#E7F9E8': 'success-subtle|light',
  '#E8E6DC': 'border-default|light',
  '#E8F3FF': 'viz-seq-1|light',
  '#EBF5FF': 'info-subtle|light',
  '#ECEBE7': 'disabled-bg|light',
  '#F0EEE6': 'bg-tertiary|light',
  '#F0F3FF': 'cta-subtle|light',
  '#F2EDEC': 'viz-div-5|light',
  '#F5906F': 'accent-active|light',
  '#F69271': 'accent-text|dark',
  '#F83036': 'danger-graphic|light',
  '#F99473': 'accent-strong|dark',
  '#FAA05D': 'viz-6|dark',
  '#FAF9F5': 'bg-primary|light',
  '#FBF3DD': 'warning-subtle|light',
  '#FCCBBB': 'accent-subtle-border|light',
  '#FDC9C3': 'danger-subtle-border|light',
  '#FF4245': 'danger-graphic|dark',
  '#FF8078': 'danger-text|dark',
  '#FF8E85': 'danger-strong|dark',
  '#FF9877': 'viz-div-9|dark',
  '#FFCC00': 'warning-fill|light',
  '#FFD600': 'warning-text|dark',
  '#FFDC7B': 'warning-hover|light',
  '#FFE686': 'warning-hover|dark',
  '#FFECB7': 'warning-active|light',
  '#FFEFED': 'danger-subtle|light',
  '#FFF0EB': 'accent-subtle|light',
  '#FFF4C9': 'warning-active|dark',
};
// Logo artwork: the same old hex plays different roles, so these files are rewritten by occurrence order.
// letters = Slate (Ivory on dark), tile = Vivid Clay #F9774C, "V" on the tile = Slate, tile dot = Ivory, pulse dot = #D95A2E on light / #F9774C on dark.
const SVG_SEQUENCE = {
  'public/brand/vireek-lockup-horizontal-color.svg': { from: ['#203AD8', '#FFFFFF', '#FF8A5A', '#203AD8', '#C14F26'], v2: ['#D97757', '#141413', '#FAF9F5', '#141413', '#D97757'], to: ['#F9774C', '#141413', '#FAF9F5', '#141413', '#D95A2E'] },
  'public/brand/vireek-lockup-stacked-color.svg': { from: ['#203AD8', '#FFFFFF', '#FF8A5A', '#203AD8', '#C14F26'], v2: ['#D97757', '#141413', '#FAF9F5', '#141413', '#D97757'], to: ['#F9774C', '#141413', '#FAF9F5', '#141413', '#D95A2E'] },
  'public/brand/vireek-symbol-color.svg': { from: ['#203AD8', '#C14F26'], v2: ['#141413', '#D97757'], to: ['#141413', '#D95A2E'] },
  'public/brand/vireek-wordmark-color.svg': { from: ['#203AD8', '#C14F26'], v2: ['#141413', '#D97757'], to: ['#141413', '#D95A2E'] },
  'public/brand/vireek-wordmark-reverse.svg': { from: ['#6C82FF', '#FF8A5A'], v2: ['#FAF9F5', '#D97757'], to: ['#FAF9F5', '#F9774C'] },
  'public/favicon.svg': { from: ['#203AD8', '#FFFFFF', '#FF8A5A'], v2: ['#D97757', '#141413', '#FAF9F5'], to: ['#F9774C', '#141413', '#FAF9F5'] },
};

// The previous brand-blue lineage (cobalt / indigo / the old default blue) was the PRIMARY colour -> it becomes the new primary, Clay.
const FORCE_FAMILY = { '#2563EB': 'accent', '#3448E8': 'accent', '#8FA0FB': 'accent', '#1F3AD8': 'accent', '#7C8CFF': 'accent' };
const familyOf = (h) => (h >= 345 || h < 32 ? 'danger' : h < 70 ? 'accent' : h < 108 ? 'warning' : h < 195 ? 'success' : h < 270 ? 'info' : 'cta');
const nearest = (set, L, C) => set.reduce((best, hx) => {
  const [l, c] = rgbToOklch(hexToRgb(hx)); const d = Math.abs(l - L) + 0.15 * Math.abs(c - C);
  return d < best.d ? { hx, d } : best;
}, { hx: set[0], d: 9 }).hx;

const cache = new Map();
export function mapHex(hex6) {
  const h = hex6.toUpperCase();
  if (cache.has(h)) return cache.get(h);
  let out;
  if (h === '#FFFFFF' || h === '#000000' || THIRD_PARTY.has(h)) out = h;
  else if (ALLOWED.has(h) && !LEGACY_ROLE[h]) out = h; // already a member of the new palette
  else if (LEGACY_ROLE[h]) { const [role, theme] = LEGACY_ROLE[h].split('|'); out = themeTok[theme][role]; }
  else {
    const [L, C, hue] = rgbToOklch(hexToRgb(h));
    const slateGrey = C < 0.055 && hue >= 235 && hue <= 285; // Tailwind "slate"-style blue greys are neutrals
    out = FORCE_FAMILY[h] ? nearest(scales[FORCE_FAMILY[h]], L, C) : C < 0.02 || slateGrey ? nearest(neutralSet, L, C) : nearest(scales[familyOf(hue)], L, C);
  }
  cache.set(h, out); return out;
}

// ------------------------------------------------------------------ white/black text on a solid status fill
// Clay (the new accent fill) + white text is only 3.1:1, so every `bg-<family> … text-white|black` pair that the repo's own
// lint rule flags becomes `text-on-<family>` (the solver-verified on-colour: Slate on Clay = 5.9:1).
const ON_FILL = /\bbg-(?:accent|cta|success|danger|warning|info)(?:-hover|-active)?\b(?![-/])[^"'`\n]*\btext-(?:white|black)\b|\btext-(?:white|black)\b[^"'`\n]*\bbg-(?:accent|cta|success|danger|warning|info)(?:-hover|-active)?\b(?![-/])/g;
function fixOnFill(text) {
  let n = 0;
  const out = text.replace(ON_FILL, (m) => { const fam = /\bbg-(accent|cta|success|danger|warning|info)/.exec(m)[1]; n++; return m.replace(/\btext-(?:white|black)\b/, `text-on-${fam}`); });
  return { out, n };
}

// ------------------------------------------------------------------ white text on a SCALE step (bg-success-500 text-white …)
// Palette anchors (step 500 = the exact brand colours) are bright; white on them fails 4.5:1. Where white fails and black passes,
// the text becomes `text-static-black`. Both checks use the real generated hex of that step.
const LEGACY_FAMILY = { red: 'danger', rose: 'danger', pink: 'danger', orange: 'accent', amber: 'warning', yellow: 'warning', lime: 'success', green: 'success', emerald: 'success', teal: 'success', cyan: 'info', sky: 'info', blue: 'info', indigo: 'cta', violet: 'cta', purple: 'cta', fuchsia: 'cta' };
const NEUTRAL_NAMES = ['slate', 'gray', 'zinc', 'neutral', 'stone', 'graphite'];
const scaleHex = (name, step) => {
  if (NEUTRAL_NAMES.includes(name)) return NEUTRAL_SCALE[step];
  const fam = FAMILY_NAMES.includes(name) ? name : LEGACY_FAMILY[name];
  return fam ? buildScale({ ...FAMILY_DEFS[fam] })[step] : null;
};
const SC = '(accent|cta|success|danger|warning|info|slate|gray|zinc|neutral|stone|graphite|red|rose|pink|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia)-(50|100|200|300|400|500|600|700|800|900|950)';
const ON_SCALE = new RegExp(`\\bbg-${SC}\\b(?![-/])[^"'\`\\n]*\\btext-white\\b|\\btext-white\\b[^"'\`\\n]*\\bbg-${SC}\\b(?![-/])`, 'g');
function fixOnScale(text) {
  let n = 0;
  const out = text.replace(ON_SCALE, (m, a1, a2, a3, a4) => {
    const name = a1 ?? a3, step = a2 ?? a4, hex = scaleHex(name, step);
    if (!hex) return m;
    const white = contrast(hexToRgb('#FFFFFF'), hexToRgb(hex)), black = contrast(hexToRgb('#000000'), hexToRgb(hex));
    if (white >= 4.5 || black < 4.5) return m;
    n++; return m.replace(/\btext-white\b/, 'text-static-black');
  });
  return { out, n };
}

// ------------------------------------------------------------------ rewriting
const HEX = /(?<![0-9A-Za-z&])(#|%23)([0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9A-Za-z])/g;
const HEX3 = /(?<=[:\s(,'"])#([0-9a-fA-F]{3})(?=[;\s)},'"])/g; // strict: avoids ids / fragments such as href="#add"
const RGBFN = /\b(rgba?)\(\s*(\d{1,3})(\s*,\s*|\s+)(\d{1,3})(\s*,\s*|\s+)(\d{1,3})(?=[\s,)/])/g;
const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs)$/;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;
const keepCase = (orig, hx) => (/[a-f]/.test(orig) && !/[A-F]/.test(orig) ? hx.toLowerCase() : hx);

function rewrite(text, rel) {
  let n = 0;
  if (SVG_SEQUENCE[rel]) {
    const seq = SVG_SEQUENCE[rel]; let i = 0;
    const found = [...text.matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) => m[0].toUpperCase());
    if (JSON.stringify(found) === JSON.stringify(seq.to)) return { text, n: 0 }; // already migrated (idempotent)
    if (JSON.stringify(found) !== JSON.stringify(seq.from) && JSON.stringify(found) !== JSON.stringify(seq.v2)) throw new Error(`${rel}: unexpected colour sequence ${found.join(' ')}`);
    return { text: text.replace(/#[0-9A-Fa-f]{6}/g, () => { n++; return seq.to[i++]; }), n };
  }
  const colour = (chunk) => {
    let t = chunk.replace(HEX, (m, pre, hex) => { const out = mapHex('#' + hex.slice(0, 6)); n++; return pre + keepCase(hex, out.slice(1)) + hex.slice(6); });
    t = t.replace(HEX3, (m, hex) => { const full = '#' + hex.split('').map((c) => c + c).join(''); if (/^#(FFF|000)/i.test('#' + hex) && (hex.toLowerCase() === 'fff' || hex === '000')) return m; const out = mapHex(full); n++; return keepCase(hex, out); });
    return t.replace(RGBFN, (m, fn, r, s1, g, s2, b) => {
      const [R, G, B] = [r, g, b].map(Number); if (R > 255 || G > 255 || B > 255) return m;
      if (R === 255 && G === 255 && B === 255 || R === 0 && G === 0 && B === 0) return m;
      const [nr, ng, nb] = hexToRgb(mapHex(toHex([R, G, B]))); n++; return `${fn}(${nr}${s1}${ng}${s2}${nb}`;
    });
  };
  // Code files: comment-only lines are documentation (examples such as "#abc") — never rewritten, never flagged.
  let t = CODE_FILE.test(rel) ? text.split('\n').map((l) => (COMMENT_LINE.test(l) ? l : colour(l))).join('\n') : colour(text);
  if (/^src\/.*\.tsx?$/.test(rel)) { const f = fixOnFill(t); t = f.out; n += f.n; const g = fixOnScale(t); t = g.out; n += g.n; }
  return { text: t, n };
}

// ------------------------------------------------------------------ walk
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) { const rel = relative(ROOT, p).split(sep).join('/'); if (!SKIP_ANYWHERE.has(e) && !(d === ROOT && SKIP_ROOT.has(e)) && !SKIP_PATH.has(rel)) walk(p); continue; }
    if (EXT.has(extname(e).toLowerCase()) && !SKIP_FILE.test(p) && !SKIP_REL.has(relative(ROOT, p).split(sep).join('/')) && basename(p) !== 'rebrand-hex.mjs') files.push(p);
  }
})(ROOT);

if (VERIFY) {
  const bad = new Map();
  for (const f of files) {
    const rel = relative(ROOT, f).split(sep).join('/'); const raw = readFileSync(f, 'utf8');
    const t = CODE_FILE.test(rel) ? raw.split('\n').filter((l) => !COMMENT_LINE.test(l)).join('\n') : raw;
    for (const m of t.matchAll(HEX)) { const h = ('#' + m[2].slice(0, 6)).toUpperCase(); if (!ALLOWED.has(h)) { const a = bad.get(h) ?? []; a.push(rel); bad.set(h, a); } }
    for (const m of t.matchAll(RGBFN)) { const h = toHex([+m[2], +m[4], +m[6]]); if (!ALLOWED.has(h)) { const a = bad.get(h) ?? []; a.push(rel); bad.set(h, a); } }
  }
  if (!bad.size) { console.log(`✔ palette purity: every colour literal in ${files.length} files belongs to the Vireek palette.`); process.exit(0); }
  console.error(`✘ ${bad.size} colour value(s) outside the palette:`);
  for (const [h, a] of bad) console.error(`  ${h}  ${[...new Set(a)].slice(0, 4).join(', ')}${new Set(a).size > 4 ? ' …' : ''}`);
  process.exit(1);
}

let changedFiles = 0, total = 0; const table = new Map();
for (const f of files) {
  const rel = relative(ROOT, f).split(sep).join('/'); const src = readFileSync(f, 'utf8');
  const { text, n } = rewrite(src, rel);
  if (text === src) continue;
  changedFiles++; total += n;
  for (const m of src.matchAll(HEX)) { const from = ('#' + m[2].slice(0, 6)).toUpperCase(); table.set(from, (table.get(from) ?? 0) + 1); }
  if (WRITE) writeFileSync(f, text);
  else console.log(`  ~ ${rel}  (${n})`);
}
console.log(`\n${WRITE ? 'WROTE' : 'DRY RUN —'} ${changedFiles} file(s), ${total} literal(s).${WRITE ? '' : '  Re-run with --write to apply.'}`);
if (!WRITE) { console.log('\nlegacy -> new (top 25 by frequency):'); for (const [h, c] of [...table].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${h} x${c}  ->  ${mapHex(h)}`); }
if (WRITE) console.log('Next: npm run tokens:build && node scripts/color/rebrand-hex.mjs --verify');
