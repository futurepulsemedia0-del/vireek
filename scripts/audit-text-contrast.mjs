#!/usr/bin/env node
// scripts/audit-text-contrast.mjs — Phase 0: MEASURE low-contrast "alpha text" in src/.
// Read-only. Source of truth for colours = scripts/color/palette.mjs (same solver the app is built from).
// Usage: node scripts/audit-text-contrast.mjs [--out reports/text-contrast]
// Output: <out>/summary.md, <out>/by-file.md, <out>/records.csv  (+ short console summary)
//
// Method (static, no browser): every string literal in src/**/*.{ts,tsx,jsx} is split into class tokens.
//   kind "text-alpha": text-<color>/<alpha>        kind "opacity": opacity-<1..99>
// Surface: bg-* in the SAME class string (dark: variant wins in dark) composited over bg-primary;
//   otherwise worst case of bg-primary / bg-secondary / bg-tertiary. Ancestor backgrounds are NOT traced
//   (needs a real DOM -> Phase 3 axe scans). Gradients/images/unknown-surface white text = "unverifiable".
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTheme } from './color/palette.mjs';
import { tailwindTheme } from './color/tailwind-colors.mjs';
import { contrast, over, hexToRgb, toHex } from './color/oklch.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argOut = process.argv.indexOf('--out');
const OUT = join(ROOT, argOut > 0 ? process.argv[argOut + 1] : 'reports/text-contrast');
const MODES = ['light', 'dark'];
const TOK = Object.fromEntries(MODES.map((m) => [m, buildTheme(m).tok]));
const SIZE_NAMES = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl', 'eyebrow']);
const PX = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128, eyebrow: 12 };

// ---------- Tailwind colour lookup (generated theme + white/black) ----------
const flat = (o, p = '', out = {}) => {
  for (const [k, v] of Object.entries(o)) {
    const key = k === 'DEFAULT' ? p : p ? `${p}-${k}` : k;
    if (v && typeof v === 'object') flat(v, key, out); else out[key] = v;
  }
  return out;
};
const COLORS = flat(tailwindTheme.colors), TEXT_COLORS = flat(tailwindTheme.textColor);
function resolveColor(name, mode, kind) {
  if (name === 'white') return [255, 255, 255];
  if (name === 'black') return [0, 0, 0];
  const v = (kind === 'text' ? TEXT_COLORS[name] ?? COLORS[name] : COLORS[name]);
  if (typeof v !== 'string') return null;
  const m = v.match(/var\(--([a-z0-9-]+)\)/);
  if (m) return TOK[mode][m[1]] ?? null;
  return v.startsWith('#') ? hexToRgb(v) : null;
}

// ---------- string-literal scanner ----------
function literalRanges(src) {
  const out = []; const n = src.length; let i = 0;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"') {
      const multi = c === '"' && /=\s*$/.test(src.slice(Math.max(0, i - 4), i)); // JSX attr may span lines
      let j = i + 1;
      while (j < n && src[j] !== c && (multi || src[j] !== '\n')) { if (src[j] === '\\') j++; j++; }
      if (src[j] === c) { out.push([i + 1, j]); i = j + 1; } else i++;
      continue;
    }
    if (c === '`') {
      let j = i + 1, depth = 0;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (depth === 0 && ch === '`') break;
        if (ch === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && ch === '}') { depth--; j++; continue; }
        if (depth > 0 && ch === '`') { const k = src.indexOf('`', j + 1); j = k < 0 ? n : k + 1; continue; }
        j++;
      }
      out.push([i + 1, j]); i = j + 1; continue;
    }
    i++;
  }
  return out;
}

// ---------- token parsing ----------
const TOKEN = /[A-Za-z0-9_\-:/\[\].!%#()&>*=@,]+/g;
const ALPHA_RE = /^(?<pre>(?:[^\s:]+:)*)!?(?<util>text-[a-z][a-z0-9-]*)\/(?<a>\d{1,3}|\[[0-9.]+\])$/;
const OPACITY_RE = /^(?<pre>(?:[^\s:]+:)*)!?opacity-(?<a>\d{1,3})$/;
const alphaOf = (s) => (s.startsWith('[') ? Number(s.slice(1, -1)) : Number(s) / 100);
const unpref = (t) => t.replace(/^(?:[^\s:]+:)*!?/, '');
const hasPre = (t) => /:/.test(t.replace(/\[[^\]]*\]/g, ''));

function classInfo(tokens) {
  let px = null, bold = false, gradient = false;
  for (const t of tokens) {
    const plain = !hasPre(t);
    if (plain) {
      const m = t.match(/^text-(?:\[(\d+(?:\.\d+)?)px\]|(.+))$/);
      if (m && m[1]) px = Number(m[1]); else if (m && SIZE_NAMES.has(m[2])) px = PX[m[2]];
      if (/^font-(bold|extrabold|black)$/.test(t)) bold = true;
    }
    if (/^(bg-gradient|bg-\[url|bg-\[image|bg-cover|bg-mesh|bg-linear|bg-radial|from-|backdrop-blur|bg-gradient-mesh)/.test(unpref(t)) || /gradient-mesh/.test(t)) gradient = true;
  }
  return { px, bold, gradient, large: px != null && (px >= 24 || (px >= 18.66 && bold)) };
}
function surfaces(tokens, mode) {
  const pick = (dark) => tokens.filter((t) => {
    const m = t.match(/^(dark:)?bg-([a-z][a-z0-9-]*)(?:\/(\d{1,3}))?$/);
    return m && !!m[1] === dark && resolveColor(m[2], mode, 'bg');
  });
  const cand = mode === 'dark' && pick(true).length ? pick(true) : pick(false);
  const page = TOK[mode]['bg-primary'];
  if (cand.length) {
    const m = cand[cand.length - 1].match(/^(?:dark:)?bg-([a-z][a-z0-9-]*)(?:\/(\d{1,3}))?$/);
    const c = resolveColor(m[1], mode, 'bg');
    return { list: [m[2] ? over(c, Number(m[2]) / 100, page) : c], known: true };
  }
  return { list: ['bg-primary', 'bg-secondary', 'bg-tertiary'].map((k) => TOK[mode][k]), known: false };
}
function tagInfo(src, idx) {
  const back = src.lastIndexOf('<', idx);
  if (back < 0 || idx - back > 900) return null;
  const head = src.slice(back, idx);
  const nm = head.match(/^<([A-Za-z][\w.]*)/);
  if (!nm || /(?<!=)>/.test(head)) return null;
  const end = src.indexOf('>', idx);
  const attrs = src.slice(back, end < 0 || end - idx > 900 ? idx : end + 1);
  const after = src.slice(end + 1, end + 8).split('<')[0].trim();
  return { name: nm[1], attrs, after };
}

function classify(rec, tokens, src, idx, icons, ti) {
  const pre = rec.pre, str = tokens.join(' ');
  if (rec.alpha === 0 || /\bsr-only\b/.test(str)) return 'incidental';
  if (/(^|:)(disabled|aria-disabled|group-disabled|peer-disabled):|data-\[disabled/.test(pre) || (rec.kind === 'opacity' && /cursor-not-allowed|pointer-events-none/.test(str) && !/hover:|focus/.test(pre))) return 'disabled';
  if (/(^|:)placeholder:/.test(pre)) return 'placeholder';
  const sized = tokens.some((t) => !hasPre(t) && /^(h|w|size)-/.test(t)), texty = tokens.some((t) => !hasPre(t) && /^(text-(xs|sm|base|lg|xl|\dxl|\[\d)|font-)/.test(t));
  if (ti && (icons.has(ti.name) || (/^[A-Z]/.test(ti.name) && sized && !texty))) return 'decorative glyph';
  if (ti && /aria-hidden(?!=\{?\s*false)/.test(ti.attrs) && ti.after.length <= 2 && !/[\p{L}\p{N}]/u.test(ti.after)) return 'decorative glyph';
  return 'meaningful text';
}

// ---------- scan ----------
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const f = join(d, e), s = statSync(f);
    if (s.isDirectory()) { if (!['node_modules', '__tests__', 'test'].includes(e)) walk(f); }
    else if (/\.(tsx?|jsx?)$/.test(e) && !/\.(test|spec|stories)\./.test(e)) files.push(f);
  }
})(join(ROOT, 'src'));

const records = [], unresolved = new Map();
for (const f of files) {
  const src = readFileSync(f, 'utf8'), rel = relative(ROOT, f);
  const nl = []; for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) nl.push(i);
  const lineOf = (i) => { let lo = 0, hi = nl.length; while (lo < hi) { const m = (lo + hi) >> 1; if (nl[m] < i) lo = m + 1; else hi = m; } return lo + 1; };
  const icons = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"]/g)) for (const p of m[1].split(',')) { const n = p.trim().split(/\s+as\s+/).pop(); if (n) icons.add(n); }
  for (const [a, b] of literalRanges(src)) {
    const text = src.slice(a, b);
    if (!/text-[a-z][a-z0-9-]*\/|opacity-\d/.test(text)) continue;
    const tokens = [...text.matchAll(TOKEN)].map((m) => m[0].replace(/[:,]+$/, ''));
    const info = classInfo(tokens);
    const darkTextPlain = tokens.some((t) => /^dark:text-/.test(t) && !/\//.test(t));
    const darkOpacity = tokens.some((t) => /^dark:opacity-/.test(t));
    for (const m of text.matchAll(TOKEN)) {
      const tok = m[0].replace(/[:,]+$/, '');
      const am = tok.match(ALPHA_RE) || null, om = am ? null : tok.match(OPACITY_RE);
      const g = (am || om)?.groups; if (!g) continue;
      const kind = am ? 'text-alpha' : 'opacity';
      const alpha = alphaOf(g.a);
      if (kind === 'text-alpha' && SIZE_NAMES.has(g.util.slice(5))) continue; // text-sm/6 = line-height
      if (kind === 'opacity' && (alpha <= 0 || alpha >= 1)) continue;
      const idx = a + m.index, ti = tagInfo(src, idx);
      const rec = { file: rel, line: lineOf(idx), kind, util: g.util ?? 'opacity', alpha, pre: g.pre, raw: tok };
      rec.cls = classify(rec, tokens, src, idx, icons, ti);
      const onlyDark = /(^|:)dark:/.test(g.pre), onlyLight = !onlyDark && (kind === 'text-alpha' ? darkTextPlain : darkOpacity);
      rec.modes = MODES.filter((md) => (onlyDark ? md === 'dark' : onlyLight ? md === 'light' : true));
      rec.px = info.px; rec.large = info.large; rec.unverifiable = info.gradient ? 'gradient/image' : '';
      rec.state = /(^|:)(hover|focus|focus-visible|active|group-hover|peer-[a-z]+):/.test(g.pre) ? 'state' : '';
      rec.need = rec.cls === 'disabled' || rec.cls === 'incidental' ? 0 : rec.cls === 'decorative glyph' || rec.large ? 3 : 4.5; // disabled/incidental are WCAG-exempt
      rec.ratio = {}; rec.surfaceKnown = false; rec.fgNote = '';
      for (const md of rec.modes) {
        let fg;
        if (kind === 'text-alpha') { fg = resolveColor(g.util.slice(5), md, 'text'); if (!fg) { unresolved.set(g.util, (unresolved.get(g.util) ?? 0) + 1); rec.fgNote = 'unresolved colour (class emits no CSS?)'; } }
        else {
          const own = tokens.filter((t) => (md === 'dark' ? /^(dark:)?text-/.test(t) : /^text-/.test(t)) && !/\//.test(t) && !hasPre(t.replace(/^dark:/, '')) ).map((t) => resolveColor(unpref(t).slice(5), md, 'text')).filter(Boolean);
          fg = own.length ? own[own.length - 1] : TOK[md]['text-secondary']; if (!own.length) rec.fgNote = 'inherited colour (assumed text-secondary, low confidence)';
        }
        const sf = surfaces(tokens, md); rec.surfaceKnown ||= sf.known;
        if (!fg || (!sf.known && (g.util === 'text-white' || g.util === 'text-black'))) { rec.ratio[md] = null; if (fg) rec.unverifiable ||= 'surface unknown (white/black text)'; continue; }
        rec.ratio[md] = Math.min(...sf.list.map((s) => contrast(over(fg, alpha, s), s)));
      }
      const rs = Object.values(rec.ratio).filter((x) => x != null);
      rec.worst = rs.length && !rec.unverifiable ? Math.min(...rs) : null;
      rec.lowConf = kind === 'opacity' && rec.fgNote.startsWith('inherited');
      records.push(rec);
    }
  }
}

// ---------- aggregate ----------
const bucket = (r) => (r.worst == null ? 'unverifiable' : r.worst < 3 ? '<3.0' : r.worst < 4.5 ? '3.0-4.5' : '>=4.5');
const fails = (r) => r.worst != null && r.worst < r.need;
const head = records.filter((r) => r.cls === 'meaningful text' && !r.lowConf);
const by = (arr, f) => arr.reduce((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {});
const r2 = (x) => (x == null ? '—' : x.toFixed(2));
const perFile = {};
for (const r of records) { const o = (perFile[r.file] ??= { n: 0, fail: 0, lt3: 0, mid: 0, ok: 0, unv: 0 }); o.n++; const b = bucket(r); if (fails(r)) o.fail++; if (b === '<3.0') o.lt3++; else if (b === '3.0-4.5') o.mid++; else if (b === '>=4.5') o.ok++; else o.unv++; }

const L = [], P = (s = '') => L.push(s);
const fmt = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' · ');
P('# Vireek — text contrast audit (Phase 0)');
P(`Files scanned: ${files.length} · records: ${records.length} (text-alpha ${records.filter((r) => r.kind === 'text-alpha').length}, opacity-* ${records.filter((r) => r.kind === 'opacity').length})`);
P('', '## Headline (meaningful text, alpha text utilities + opacity with known colour)');
P(`- usages: ${head.length} · **failing (below 4.5, or 3.0 for large text): ${head.filter(fails).length}** · <3.0: ${head.filter((r) => bucket(r) === '<3.0').length} · 3.0–4.5: ${head.filter((r) => bucket(r) === '3.0-4.5').length} · ≥4.5: ${head.filter((r) => bucket(r) === '>=4.5').length} · unverifiable: ${head.filter((r) => r.worst == null).length}`);
P(`- by classification: ${fmt(by(records, (r) => r.cls))}`);
P(`- by kind: ${fmt(by(records, (r) => r.kind + (r.lowConf ? ' (inherited colour, low confidence)' : '')))}`);
P(`- meaningful text with known size ≤12px: ${head.filter((r) => r.px != null && r.px <= 12).length} · with known surface in same class string: ${head.filter((r) => r.surfaceKnown).length}`);
P(`- unverifiable (gradient/image or unknown surface for white/black text): ${records.filter((r) => r.unverifiable).length}`);
P('', '## text-text-secondary/N ratios on the CURRENT palette (zip) — compare with your measured numbers');
P('| N | light bg1 | light bg2 | light bg3 | dark bg1 | dark bg2 | dark bg3 | usages |', '|---|---|---|---|---|---|---|---|');
const sec = (r) => r.util === 'text-text-secondary' && r.kind === 'text-alpha';
for (const N of [30, 40, 50, 60, 70, 80, 100]) {
  const cells = MODES.flatMap((md) => ['bg-primary', 'bg-secondary', 'bg-tertiary'].map((k) => { const s = TOK[md][k]; return r2(contrast(over(TOK[md]['text-secondary'], N / 100, s), s)); }));
  P(`| /${N} | ${cells.join(' | ')} | ${records.filter((r) => sec(r) && Math.round(r.alpha * 100) === N).length} |`);
}
P('', '## Palette text tokens as built from palette.mjs');
P('| token | light hex | dark hex | light on bg1 | dark on bg1 |', '|---|---|---|---|---|');
for (const k of ['text-primary', 'text-secondary', 'text-muted', 'disabled-fg']) P(`| ${k} | ${TOK.light[k] ? toHex(TOK.light[k]) : '—'} | ${TOK.dark[k] ? toHex(TOK.dark[k]) : '—'} | ${TOK.light[k] ? r2(contrast(TOK.light[k], TOK.light['bg-primary'])) : '—'} | ${TOK.dark[k] ? r2(contrast(TOK.dark[k], TOK.dark['bg-primary'])) : '—'} |`);
P('', '## Alpha text by colour utility (all classifications)');
P(fmt(by(records.filter((r) => r.kind === 'text-alpha'), (r) => r.util)));
if (unresolved.size) P('', '## Unresolved colour names (no matching Tailwind colour → class likely emits NO CSS; check before migrating)', [...unresolved].map(([k, v]) => `- ${k}: ${v}`).join('\n'));
P('', '## Not covered by this static pass', '- Ancestor backgrounds, text over gradients/images/video, inline `style` opacity/rgba, `.css` files, `text-[color:…]` arbitrary colours, runtime-built class names → Phase 3 (axe + Playwright) must cover these.', '- Classification is heuristic (icon imports, aria-hidden, variants); Phase 2 reviews each batch manually.');
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'summary.md'), L.join('\n') + '\n');

const F = ['# Per-file counts (all classifications; bucket = worst ratio across light/dark)', '', '| file | total | failing | <3.0 | 3.0–4.5 | ≥4.5 | unverifiable |', '|---|---|---|---|---|---|---|'];
for (const [f, o] of Object.entries(perFile).sort((a, b) => b[1].fail - a[1].fail || b[1].n - a[1].n)) F.push(`| ${f} | ${o.n} | ${o.fail} | ${o.lt3} | ${o.mid} | ${o.ok} | ${o.unv} |`);
writeFileSync(join(OUT, 'by-file.md'), F.join('\n') + '\n');

const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
const csv = ['file,line,kind,class,classification,px,large,state,surface_known,ratio_light,ratio_dark,worst,needs,fails,unverifiable,note'];
for (const r of records) csv.push([q(r.file), r.line, r.kind, q(r.raw), r.cls, r.px ?? '', r.large, r.state, r.surfaceKnown, r2(r.ratio.light).replace('—', ''), r2(r.ratio.dark).replace('—', ''), r.worst == null ? '' : r.worst.toFixed(2), r.need, fails(r), q(r.unverifiable), q(r.fgNote)].join(','));
writeFileSync(join(OUT, 'records.csv'), csv.join('\n') + '\n');

console.log(L.slice(0, 22).join('\n'));
console.log(`\nTop files by failing usages:\n${Object.entries(perFile).sort((a, b) => b[1].fail - a[1].fail).slice(0, 15).map(([f, o]) => `  ${String(o.fail).padStart(3)} / ${String(o.n).padStart(3)}  ${f}`).join('\n')}`);
console.log(`\nReports written to ${relative(ROOT, OUT)}/ (summary.md, by-file.md, records.csv)`);
