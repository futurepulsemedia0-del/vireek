#!/usr/bin/env node
// scripts/color/codemod-colors.mjs — migrate raw Tailwind palette classes + hex colours to semantic tokens.
//
//   node scripts/color/codemod-colors.mjs            # dry run: prints counts + writes docs/design/COLOR_MIGRATION_REPORT.md
//   node scripts/color/codemod-colors.mjs --write    # applies the edits in place (commit first; review the git diff!)
//
// What it does (per class string literal, so `dark:` pairs and `bg-X text-white` pairings are seen together):
//   1. `text-slate-600 dark:text-slate-300`  -> `text-text-secondary`      (semantic tokens flip by themselves)
//   2. raw palette utilities (bg-red-500/10, text-emerald-600, border-slate-300 …) -> semantic tokens
//   3. `bg-<family> … text-white` -> `text-on-<family>` (guaranteed-contrast pairing)
//   4. bg-white -> bg-bg-secondary, bg-black/N -> bg-overlay/N
//   5. hex colours inside JSX/SVG attributes and `style={{…}}` -> rgb(var(--token))
// Everything it cannot decide safely is LISTED in the report instead of guessed.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hexToRgb, rgbToOklab, rgbToOklch } from './oklch.mjs';
import { buildTheme } from './palette.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRITE = process.argv.includes('--write');
const SKIP_FILE = /(tokens\.generated|\.test\.|\.spec\.|[\\/]TokensPreview|[\\/]DevColorsPage|[\\/]lib[\\/]branding\.ts)/;

// ------------------------------------------------------------------ class mapping
const NEUTRAL = new Set(['slate', 'gray', 'zinc', 'neutral', 'stone']);
const FAM = { red: 'danger', rose: 'danger', orange: 'warning', amber: 'warning', yellow: 'warning', green: 'success', emerald: 'success', lime: 'success', teal: 'success', blue: 'info', sky: 'info', cyan: 'info', indigo: 'accent', violet: 'accent', purple: 'accent', fuchsia: 'accent', pink: 'accent' };
const COLOR_RE = '(slate|gray|zinc|neutral|stone|red|rose|orange|amber|yellow|green|emerald|lime|teal|blue|sky|cyan|indigo|violet|purple|fuchsia|pink)';
const UTIL = 'bg|text|border|ring|outline|divide|from|via|to|fill|stroke|placeholder|decoration|caret|accent|shadow';
const TOKEN_RE = new RegExp(`^((?:[a-z0-9-]+:|\\[[^\\]]+\\]:)*)(!?)(${UTIL})-${COLOR_RE}-(\\d{2,3})(?:/(\\d{1,3}|\\[[\\d.]+\\]))?$`);
const BARE_RE = /^((?:[a-z0-9-]+:|\[[^\]]+\]:)*)(!?)(bg|text|border|ring|divide|from|via|to|fill|stroke)-(white|black)(?:\/(\d{1,3}|\[[\d.]+\]))?$/;
const SCALE_RE = new RegExp(`^((?:[a-z0-9-]+:|\\[[^\\]]+\\]:)*)(!?)(bg|text|border|ring|outline|divide|fill|stroke)-(accent|cta|success|danger|warning|info)-(\\d{2,3})(?:/(\\d{1,3}|\\[[\\d.]+\\]))?$`);

const stats = { classes: 0, dark: 0, onPairs: 0, bare: 0, hex: 0, review: [], leftHex: [] };

function neutralTarget(u, step, hasDarkBg) {
  const s = +step;
  if (u === 'text' || u === 'decoration' || u === 'caret' || u === 'placeholder') {
    if (hasDarkBg) return s <= 200 ? 'on-inverse' : s <= 500 ? 'on-inverse-muted' : 'text-primary';
    if (s <= 200) return 'on-inverse'; // review: light text without a dark surface in the same string
    if (s <= 500) return 'text-muted';
    if (s <= 600) return 'text-secondary';
    return 'text-primary';
  }
  if (u === 'bg') return s <= 50 ? 'bg-primary' : s <= 200 ? 'bg-tertiary' : s <= 300 ? 'border-strong' : s <= 600 ? 'text-muted' : 'surface-inverse';
  if (u === 'border' || u === 'divide' || u === 'ring' || u === 'outline') return s <= 200 ? 'border' : s <= 500 ? 'border-strong' : hasDarkBg ? 'border-inverse' : 'border-strong';
  if (u === 'fill' || u === 'stroke') return s <= 300 ? 'border-strong' : s <= 500 ? 'text-muted' : 'text-primary';
  if (u === 'from' || u === 'via' || u === 'to') return s <= 200 ? 'bg-primary' : s <= 500 ? 'border-strong' : 'surface-inverse';
  return 'text-secondary';
}
function famTarget(u, fam, step) {
  const s = +step;
  if (u === 'text' || u === 'decoration' || u === 'caret' || u === 'placeholder') return s >= 700 ? `${fam}-strong` : fam; // fam => <fam>-text via textColor
  if (u === 'bg') return s <= 200 ? `${fam}-subtle` : s <= 600 ? fam : `${fam}-strong`;
  if (u === 'border' || u === 'divide' || u === 'ring' || u === 'outline') return s <= 300 ? `${fam}-subtle-border` : s <= 600 ? fam : `${fam}-strong`;
  if (u === 'fill' || u === 'stroke') return fam;
  if (u === 'from' || u === 'via' || u === 'to') return fam; // gradient stops use the fill colour
  return fam;
}
// utilities whose default colour is the *text* variant of a family map to `<fam>` only for text/…; borders etc. use graphic variant via Tailwind config
function mapToken(tok, ctx) {
  let m = TOKEN_RE.exec(tok);
  if (m) {
    const [, variants, bang, u, color, step, alpha] = m;
    const isNeutral = NEUTRAL.has(color);
    const fam = FAM[color];
    let target = isNeutral ? neutralTarget(u, step, ctx.hasDarkBg) : famTarget(u, fam, step);
    if (u === 'bg' && alpha && !isNeutral && +step >= 400 && +step <= 600 && +alpha <= 30) target = `${fam}-subtle`; // tint stays AA-safe (opaque)
    if (u === 'bg' && alpha && isNeutral && +step >= 900) target = 'overlay';
    if (u === 'bg' && alpha && !isNeutral && +alpha <= 30) { /* subtle handled above */ }
    const a = alpha && !(u === 'bg' && target.endsWith('-subtle')) ? `/${alpha}` : '';
    const util = u === 'divide' ? 'divide' : u;
    const out = `${variants}${bang}${util}-${target}${a}`;
    if (isNeutral && (u === 'text') && +step <= 300 && !ctx.hasDarkBg) stats.review.push({ kind: 'light-text-no-dark-bg', tok, to: out });
    stats.classes++;
    return out;
  }
  m = SCALE_RE.exec(tok);
  if (m) {
    const [, variants, bang, u, fam, step, alpha] = m;
    const s = +step;
    let target = s <= 100 ? `${fam}-subtle` : s <= 700 ? fam : `${fam}-strong`;
    if (u === 'bg' && s >= 700) target = `${fam}-hover`;
    if (u === 'bg' && s <= 100) target = `${fam}-subtle`;
    const aNum = alpha ? (alpha.startsWith('[') ? parseFloat(alpha.slice(1, -1)) : +alpha / 100) : 1;
    if (u === 'bg' && alpha && aNum <= 0.3 && !target.endsWith('-subtle')) target = `${fam}-subtle`; // faint tint -> opaque AA-safe tint
    stats.classes++;
    return `${variants}${bang}${u}-${target}${alpha && !target.endsWith('-subtle') ? `/${alpha}` : ''}`;
  }
  m = BARE_RE.exec(tok);
  if (m) {
    const [, variants, bang, u, c, alpha] = m;
    if (u === 'bg' && c === 'white') { stats.bare++; return `${variants}${bang}bg-bg-secondary${alpha ? `/${alpha}` : ''}`; }
    if (u === 'bg' && c === 'black') { stats.bare++; return `${variants}${bang}bg-overlay${alpha ? `/${alpha}` : ''}`; }
    if (u === 'border' && c === 'white') { stats.bare++; return `${variants}${bang}border-on-inverse${alpha ? `/${alpha}` : ''}`; }
    if (u === 'divide' && c === 'white') { stats.bare++; return `${variants}${bang}divide-on-inverse${alpha ? `/${alpha}` : ''}`; }
    return tok; // text-white / text-black handled by pairing step; the rest stays (documented static exception)
  }
  return tok;
}
const splitVariants = (tok) => { const i = tok.search(/[^:\]]+$/); return [tok.slice(0, i), tok.slice(i)]; };

function transformClassString(str) {
  const toks = str.split(/(\s+)/); // keep whitespace
  const words = toks.map((t, i) => ({ t, i })).filter((x) => x.t.trim());
  const parsed = words.map(({ t }) => TOKEN_RE.exec(t) || BARE_RE.exec(t) || SCALE_RE.exec(t) ? t : null);
  if (!parsed.some(Boolean)) return str;
  const list = words.map((w) => w.t);
  const baseKey = (t) => { const [v, rest] = splitVariants(t); return [v.replace(/dark:/g, ''), rest.replace(/^!/, '')]; };
  // 1) collapse `dark:` palette tokens when a base token with same utility+variants exists
  const drop = new Set();
  const utilOf = (rest) => rest.replace(/^(!?)([a-z]+)-.*$/, '$2');
  list.forEach((t, idx) => {
    const [v, rest] = splitVariants(t);
    if (!/(^|:)dark:/.test(v) && !/^dark:/.test(v)) return;
    if (!(TOKEN_RE.test(t) || BARE_RE.test(t) || SCALE_RE.test(t))) return;
    const [bv] = baseKey(t);
    const hasBase = list.some((o, j) => { if (j === idx) return false; const [ov, orest] = splitVariants(o); return ov === bv && utilOf(orest) === utilOf(rest) && !/dark:/.test(ov); });
    if (hasBase) { drop.add(idx); stats.dark++; }
  });
  const hasDarkBg = list.some((t) => /(^|:)bg-(slate|gray|zinc|neutral|stone)-(7|8|9)\d\d(\/|$)/.test(t) || /(^|:)bg-(black|static-black|surface-inverse)(\/|$)/.test(t));
  const mapped = list.map((t, idx) => (drop.has(idx) ? null : mapToken(t, { hasDarkBg })));
  // 3) pair text colour with a solid family background: whatever dark/white/ink text was written, use the guaranteed `on-<family>`
  const solidFam = new Set();
  mapped.forEach((t) => { if (!t) return; const m = /^(?:[a-z0-9-]+:)*bg-(accent|cta|success|danger|warning|info)(?:-hover|-active)?(?:\/(?:8\d|9\d|100))?$/.exec(t); if (m) solidFam.add(m[1]); });
  const mm = mapped.map((t) => {
    if (t && solidFam.size === 1 && /^(?:[a-z0-9-]+:)*!?text-(white|black|text-primary|text-inverse|on-inverse|static-white|static-black)$/.test(t)) {
      stats.onPairs++;
      return t.replace(/text-(white|black|text-primary|text-inverse|on-inverse|static-white|static-black)$/, `text-on-${[...solidFam][0]}`);
    }
    return t;
  });
  // rebuild: dropped tokens take their preceding whitespace with them (no double spaces / trailing blanks)
  const lead = /^\s*/.exec(str)[0], trail = /\s*$/.exec(str)[0];
  const segs = [];
  let ws = '', wi = 0;
  for (const t of toks) { if (!t.trim()) { ws = t; continue; } const r = mm[wi++]; if (r !== null) segs.push((segs.length ? ws : '') + r); }
  return lead + segs.join('') + (segs.length ? trail : '');
}

// ------------------------------------------------------------------ hex -> token (JSX/SVG attrs + style objects only)
const LIGHT = buildTheme('light').tok;
const CAND = ['accent-graphic', 'cta-graphic', 'success-graphic', 'danger-graphic', 'warning-graphic', 'info-graphic', 'text-primary', 'text-secondary', 'text-muted', 'border-default', 'border-strong', 'bg-primary', 'bg-secondary', 'bg-tertiary'];
function hexToToken(hex) {
  const up = hex.toUpperCase();
  if (up === '#FFF' || up === '#FFFFFF') return 'static-white';
  if (up === '#000' || up === '#000000') return 'static-black';
  const rgb = hexToRgb(hex);
  const [L, C] = rgbToOklch(rgb);
  const lab = rgbToOklab(rgb);
  let best = null, bd = 9;
  for (const c of CAND) {
    if (C > 0.05 && !/graphic$/.test(c)) continue; // chromatic colours only map to chromatic tokens
    if (C <= 0.05 && /graphic$/.test(c)) continue;
    const l2 = rgbToOklab(LIGHT[c]);
    const d = Math.hypot(lab[0] - l2[0], lab[1] - l2[1], lab[2] - l2[2]);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}
const HEX = '#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\\b';
const ATTR_RE = new RegExp(`\\b(fill|stroke|stopColor|floodColor|color)=(["'])(${HEX})\\2`, 'g');
const STYLE_PROP_RE = new RegExp(`\\b(color|backgroundColor|borderColor|fill|stroke|background|borderTopColor|borderBottomColor)(\\s*:\\s*)(["'])(${HEX})\\3`, 'g');
function repl(hex) {
  const tok = hexToToken(hex.slice(0, 7).length === 7 || hex.length === 4 ? hex.slice(0, hex.length === 9 ? 7 : undefined) : hex);
  const a = hex.length === 9 ? (parseInt(hex.slice(7), 16) / 255).toFixed(2) : null;
  stats.hex++;
  return `rgb(var(--${tok})${a ? ` / ${a}` : ''})`;
}
function transformHex(text) {
  text = text.replace(ATTR_RE, (_m, p, q, hex) => `${p}=${q}${repl(hex)}${q}`);
  return text.split('\n').map((line) => (/style=\{\{/.test(line) ? line.replace(STYLE_PROP_RE, (_m, p, sep2, q, hex) => `${p}${sep2}${q}${repl(hex)}${q}`) : line)).join('\n');
}

// ------------------------------------------------------------------ driver
// A "class run" = maximal whitespace-separated sequence of class-like tokens (stops at quotes, ${, {, }, =, commas …).
// Token-run scanning (instead of quote matching) is immune to stray apostrophes in JSX prose.
const RUN_RE = /[A-Za-z0-9_:[\]\/.%!#()-]+(?:\s+[A-Za-z0-9_:[\]\/.%!#()-]+)*/g;
const HAS_CANDIDATE = /(-(slate|gray|zinc|neutral|stone|red|rose|orange|amber|yellow|green|emerald|lime|teal|blue|sky|cyan|indigo|violet|purple|fuchsia|pink|accent|cta|success|danger|warning|info)-\d{2,3}|(bg|border|divide)-(white|black)|(?<![\w-])text-(white|black)(?![\w-]))/;
// Latent typos found by the audit: these class names never existed in tailwind.config.js, so they silently did nothing.
const TYPOS = [[/\bborder-border-primary\b/g, 'border-border'], [/\bdivide-border-primary\b/g, 'divide-border'], [/\bbg-accent-secondary\b/g, 'bg-cta']];
// Repeated literal patterns with a token equivalent (found by the re-measure audit)
const LITERAL_RULES = [
  [/accent-\[var\(--[a-z-]+,#[0-9a-fA-F]{6}\)\]/g, 'accent-accent'],
  [/rgba\(255,255,255,0\.14\), transparent 45%/g, 'rgb(var(--static-white) / 0.14), transparent 45%'],
];
function transformFile(text) {
  for (const [re, to] of TYPOS) text = text.replace(re, to);
  for (const [re, to] of LITERAL_RULES) text = text.replace(re, to);
  let out = text.replace(RUN_RE, (run) => (HAS_CANDIDATE.test(run) && run.length < 4000 ? transformClassString(run) : run));
  out = transformHex(out);
  return out;
}
function walk(dir, fn) {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e), s = statSync(f);
    if (s.isDirectory()) { if (e === 'node_modules' || e === 'dist') continue; walk(f, fn); } else if (['.ts', '.tsx', '.jsx', '.js'].includes(extname(e))) fn(f);
  }
}
let changedFiles = 0;
const leftovers = {};
walk(join(ROOT, 'src'), (f) => {
  const rel = relative(ROOT, f).split(sep).join('/');
  if (SKIP_FILE.test(rel)) return;
  const text = readFileSync(f, 'utf8');
  const next = transformFile(text);
  if (next !== text) { changedFiles++; if (WRITE) writeFileSync(f, next); }
  const src = next;
  src.split('\n').forEach((line, i) => {
    const hexes = line.match(new RegExp(HEX, 'g'));
    if (hexes && !/^\s*(\/\/|\*)/.test(line)) (leftovers[rel] ??= []).push(`${i + 1}: ${line.trim().slice(0, 110)}`);
    if (new RegExp(`(bg|text|border|ring|from|to|via|fill|stroke|divide|outline|placeholder)-${COLOR_RE}-\\d{2,3}`).test(line)) (leftovers[rel] ??= []).push(`${i + 1}: ${line.trim().slice(0, 110)} [raw class not auto-migrated]`);
  });
});
const leftoverCount = Object.values(leftovers).reduce((a, b) => a + b.length, 0);
let md = `# Colour migration report\n\nMode: ${WRITE ? '**WRITE**' : 'dry-run'}\n\n| Metric | Count |\n|---|---|\n| files changed | ${changedFiles} |\n| raw palette classes migrated | ${stats.classes} |\n| redundant \`dark:\` palette classes removed | ${stats.dark} |\n| \`text-white\` → \`text-on-<family>\` pairings | ${stats.onPairs} |\n| bg-white / bg-black / border-white → tokens | ${stats.bare} |\n| hex → \`rgb(var(--token))\` | ${stats.hex} |\n| lines still containing hex / raw classes (manual) | ${leftoverCount} |\n\n`;
md += `## Review: light text with no dark surface in the same class string (${stats.review.length})\nThese became \`text-on-inverse\`; confirm the parent really is a dark/inverse surface.\n\n`;
for (const r of stats.review.slice(0, 200)) md += `- \`${r.tok}\` → \`${r.to}\`\n`;
md += `\n## Needs manual decision (canvas/map/chart/email/data colours — CSS variables cannot be used)\n`;
for (const [f, ls] of Object.entries(leftovers)) md += `\n### ${f}\n${ls.map((l) => `- ${l}`).join('\n')}\n`;
mkdirSync(join(ROOT, 'docs/design'), { recursive: true });
writeFileSync(join(ROOT, 'docs/design/COLOR_MIGRATION_REPORT.md'), md);
console.log(`${WRITE ? 'WROTE' : 'DRY RUN'}: files=${changedFiles} classes=${stats.classes} darkPairsRemoved=${stats.dark} onPairs=${stats.onPairs} bare=${stats.bare} hex=${stats.hex} leftoverLines=${leftoverCount}`);
