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
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'docs', 'patches', 'reports', 'e2e', 'eval', 'load', 'evidence', 'rc', 'vireek-a11y', 'vireek-docs-phase1', 'color', 'brand-audit', 'ops', 'locales']);
const SKIP_REL = new Set(['scripts/brand/check-pwa.mjs', 'src/components/brand/Logo.tsx', 'src/components/brand/LogoConstruction.tsx', 'src/components/brand/BrandLogoGuide.tsx']); // 1st: lists BANNED legacy colours; rest: hand-edited (role-specific logo colours) // lists the BANNED legacy colours on purpose
const SKIP_FILE = /(\.test\.|\.spec\.|tokens\.generated|brand-colors\.ts$|package-lock\.json$|\.min\.)/;

// ------------------------------------------------------------------ the new palette (all derived from palette.mjs)
const themeTok = Object.fromEntries(THEMES.map((t) => [t, Object.fromEntries(Object.entries(buildTheme(t).tok).map(([k, v]) => [k, toHex(v)]))]));
const FAMILY_ANCHORS = { accent: ['#D97757'], cta: ['#635BFF', '#7E6BFD'], success: ['#34C759', '#30D158'], danger: ['#FF383C', '#FF4245'], warning: ['#FFCC00', '#FFD600'], info: ['#6A9BCC'] };
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
};
// Logo artwork: the same old hex plays different roles, so these files are rewritten by occurrence order.
// letters = Slate (Ivory on dark), tile = Clay, "V" on the tile = Slate, pulse dot = Clay (Ivory on the Clay tile).
const SVG_SEQUENCE = {
  'public/brand/vireek-lockup-horizontal-color.svg': { from: ['#203AD8', '#FFFFFF', '#FF8A5A', '#203AD8', '#C14F26'], to: ['#D97757', '#141413', '#FAF9F5', '#141413', '#D97757'] },
  'public/brand/vireek-lockup-stacked-color.svg': { from: ['#203AD8', '#FFFFFF', '#FF8A5A', '#203AD8', '#C14F26'], to: ['#D97757', '#141413', '#FAF9F5', '#141413', '#D97757'] },
  'public/brand/vireek-symbol-color.svg': { from: ['#203AD8', '#C14F26'], to: ['#141413', '#D97757'] },
  'public/brand/vireek-wordmark-color.svg': { from: ['#203AD8', '#C14F26'], to: ['#141413', '#D97757'] },
  'public/brand/vireek-wordmark-reverse.svg': { from: ['#6C82FF', '#FF8A5A'], to: ['#FAF9F5', '#D97757'] },
  'public/favicon.svg': { from: ['#203AD8', '#FFFFFF', '#FF8A5A'], to: ['#D97757', '#141413', '#FAF9F5'] },
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
    if (JSON.stringify(found) !== JSON.stringify(seq.from)) throw new Error(`${rel}: unexpected colour sequence ${found.join(' ')}`);
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
    if (statSync(p).isDirectory()) { if (!SKIP_DIR.has(e)) walk(p); continue; }
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
