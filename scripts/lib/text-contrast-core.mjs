// scripts/lib/text-contrast-core.mjs — ONE static scanner for "alpha text" (text-<color>/<alpha>, opacity-N), shared by
//   scripts/audit-text-contrast.mjs (report) · scripts/color/codemod-text-alpha.mjs (migration) · scripts/lib/text-alpha-rule.mjs (guard).
// Colours come from scripts/color/palette.mjs (the app's token source of truth). Static only: surface = bg-* in the SAME
// class string, else worst case of bg-primary/secondary/tertiary; ancestors/gradients/images are NOT resolved (Phase 3 axe covers them).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { buildTheme } from '../color/palette.mjs';
import { tailwindTheme } from '../color/tailwind-colors.mjs';
import { contrast, over, hexToRgb } from '../color/oklch.mjs';

export { contrast, over };
export const MODES = ['light', 'dark'];
export const TOK = Object.fromEntries(MODES.map((m) => [m, buildTheme(m).tok]));
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
export function resolveColor(name, mode, kind) {
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
  return { back, name: nm[1], attrs, after };
}

function classify(rec, tokens, src, idx, icons, ti) {
  const pre = rec.pre, str = tokens.join(' ');
  if (rec.alpha === 0 || /\bsr-only\b/.test(str)) return 'incidental';
  if (rec.kind === 'opacity' && /(^|:)(hover|focus|focus-visible|active|group-hover|peer-[a-z]+):/.test(pre)) return 'incidental'; // opacity reveal/dim on interaction
  if (/(^|:)(disabled|aria-disabled|group-disabled|peer-disabled):|data-\[disabled/.test(pre) || (rec.kind === 'opacity' && /cursor-not-allowed|pointer-events-none/.test(str) && !/hover:|focus/.test(pre))) return 'disabled';
  if (/(^|:)placeholder:/.test(pre)) return 'placeholder';
  const sized = tokens.some((t) => !hasPre(t) && /^(h|w|size)-/.test(t)), texty = tokens.some((t) => !hasPre(t) && /^(text-(xs|sm|base|lg|xl|\dxl|\[\d)|font-)/.test(t));
  if (ti && (icons.has(ti.name) || (/^[A-Z]/.test(ti.name) && sized && !texty))) return 'decorative glyph';
  if (ti && /aria-hidden(?!=\{?\s*false)/.test(ti.attrs) && ti.after.length <= 2 && !/[\p{L}\p{N}]/u.test(ti.after)) return 'decorative glyph';
  return 'meaningful text';
}

// ---------- scan one file ----------
export function listSourceFiles(root) {
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const f = join(d, e), s = statSync(f);
      if (s.isDirectory()) { if (!['node_modules', '__tests__', 'test'].includes(e)) walk(f); }
      else if (/\.(tsx?|jsx?)$/.test(e) && !/\.(test|spec|stories)\./.test(e)) files.push(f);
    }
  })(join(root, 'src'));
  return files;
}
export const relPath = (root, f) => relative(root, f).split(sep).join('/');

export function scanFile(src, rel) {
  const records = [], unresolved = new Map();
  const nl = []; for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) nl.push(i);
  const lineOf = (i) => { let lo = 0, hi = nl.length; while (lo < hi) { const m = (lo + hi) >> 1; if (nl[m] < i) lo = m + 1; else hi = m; } return lo + 1; };
  const lineText = (n) => src.slice(n <= 1 ? 0 : nl[n - 2] + 1, nl[n - 1] ?? src.length);
  const icons = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"]/g)) for (const p of m[1].split(',')) { const n = p.trim().split(/\s+as\s+/).pop(); if (n) icons.add(n); }
  for (const [a, b] of literalRanges(src)) {
    const text = src.slice(a, b);
    if (!/text-[a-z][a-z0-9-]*\/|opacity-\d/.test(text)) continue;
    const tokens = [...text.matchAll(TOKEN)].map((m) => m[0].replace(/[:,]+$/, ''));
    const info = classInfo(tokens);
    const darkTextPlain = tokens.some((t) => /^dark:text-/.test(t) && !/\//.test(t));
    const darkOpacity = tokens.some((t) => /^dark:opacity-/.test(t));
    const joined = tokens.join(' ');
    const hasTextColor = tokens.some((t) => !hasPre(t) && /^text-/.test(t) && !/\//.test(t) && resolveColor(t.slice(5), 'light', 'text'));
    for (const m of text.matchAll(TOKEN)) {
      const tok = m[0].replace(/[:,]+$/, '');
      const am = tok.match(ALPHA_RE) || null, om = am ? null : tok.match(OPACITY_RE);
      const g = (am || om)?.groups; if (!g) continue;
      const kind = am ? 'text-alpha' : 'opacity';
      const alpha = alphaOf(g.a);
      if (kind === 'text-alpha' && SIZE_NAMES.has(g.util.slice(5))) continue; // text-sm/6 = line-height
      if (kind === 'opacity' && (alpha <= 0 || alpha >= 1)) continue;
      const idx = a + m.index, ti = tagInfo(src, idx), line = lineOf(idx);
      const bang = tok.slice(g.pre.length).startsWith('!') ? 1 : 0;
      const rec = { file: rel, line, kind, util: g.util ?? 'opacity', alpha, pre: g.pre, raw: tok, start: idx + g.pre.length + bang, end: idx + tok.length };
      rec.cls = classify(rec, tokens, src, idx, icons, ti);
      rec.tag = ti ? { back: ti.back, name: ti.name, isIcon: icons.has(ti.name), hasA11yAttr: /aria-(hidden|label|labelledby)|\btitle=|\brole=/.test(ti.attrs) } : null;
      rec.ok = /contrast-ok:/.test(lineText(line)) || /contrast-ok:/.test(lineText(line - 1));
      rec.hasTextColor = hasTextColor; rec.motion = /transition-opacity|animate-/.test(joined);
      const onlyDark = /(^|:)dark:/.test(g.pre), onlyLight = !onlyDark && (kind === 'text-alpha' ? darkTextPlain : darkOpacity);
      rec.modes = MODES.filter((md) => (onlyDark ? md === 'dark' : onlyLight ? md === 'light' : true));
      rec.px = info.px; rec.large = info.large; rec.unverifiable = info.gradient ? 'gradient/image' : '';
      rec.state = /(^|:)(hover|focus|focus-visible|active|group-hover|peer-[a-z]+):/.test(g.pre) ? 'state' : '';
      rec.need = rec.cls === 'disabled' || rec.cls === 'incidental' ? 0 : rec.cls === 'decorative glyph' || rec.large ? 3 : 4.5; // disabled/incidental are WCAG-exempt
      rec.ratio = {}; rec.sf = {}; rec.surfaceKnown = false; rec.fgNote = '';
      for (const md of rec.modes) {
        let fg;
        if (kind === 'text-alpha') { fg = resolveColor(g.util.slice(5), md, 'text'); if (!fg) { unresolved.set(g.util, (unresolved.get(g.util) ?? 0) + 1); rec.fgNote = 'unresolved colour (class emits no CSS?)'; } }
        else {
          const own = tokens.filter((t) => (md === 'dark' ? /^(dark:)?text-/.test(t) : /^text-/.test(t)) && !/\//.test(t) && !hasPre(t.replace(/^dark:/, ''))).map((t) => resolveColor(unpref(t).slice(5), md, 'text')).filter(Boolean);
          fg = own.length ? own[own.length - 1] : TOK[md]['text-secondary']; if (!own.length) rec.fgNote = 'inherited colour (assumed text-secondary, low confidence)';
        }
        const sf = surfaces(tokens, md); rec.surfaceKnown ||= sf.known; rec.sf[md] = sf.list;
        if (!fg || (!sf.known && (g.util === 'text-white' || g.util === 'text-black'))) { rec.ratio[md] = null; if (fg) rec.unverifiable ||= 'surface unknown (white/black text)'; continue; }
        rec.ratio[md] = Math.min(...sf.list.map((s) => contrast(over(fg, alpha, s), s)));
      }
      const rs = Object.values(rec.ratio).filter((x) => x != null);
      rec.worst = rs.length && !rec.unverifiable ? Math.min(...rs) : null;
      rec.lowConf = kind === 'opacity' && rec.fgNote.startsWith('inherited');
      records.push(rec);
    }
  }
  return { records, unresolved };
}

/** Records the guard forbids: alpha on text colour, or opacity-N on an element that carries a text colour.
 *  Exempt: disabled/incidental states, hover/focus opacity reveals, motion, decorative glyphs (opacity), `// contrast-ok: reason`. */
export function guardViolations(records) {
  return records.filter((r) => {
    if (r.ok || r.alpha === 0 || r.cls === 'disabled' || r.cls === 'incidental') return false;
    if (r.kind === 'opacity') return r.hasTextColor && !r.state && !r.motion && r.cls !== 'decorative glyph';
    return true;
  });
}
