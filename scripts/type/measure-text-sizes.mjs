#!/usr/bin/env node
// scripts/type/measure-text-sizes.mjs
//
// Phase 0 of the typography programme: MEASURE, don't guess.
//
// Lists every non-token text size in the codebase and classifies each hit by
//   • kind     — how the size was written (tailwind arbitrary, inline style, SVG attr, CSS)
//   • px       — resolved pixel size at a 16px root (em values are flagged "relative")
//   • role     — what the element is for (label, caption, badge, table-cell, helper, axis-label, …)
//   • surface  — where it renders (dashboard | marketing | shared | unrouted), derived from the
//                REAL router in src/App.tsx + the import graph, not from folder names
//   • mobile   — orthogonal flag: file lives in a mobile/native-specific module
//
// Usage:
//   node scripts/type/measure-text-sizes.mjs                 # human summary
//   node scripts/type/measure-text-sizes.mjs --json out.json # full machine-readable report
//   node scripts/type/measure-text-sizes.mjs --top 25        # densest N files
//   node scripts/type/measure-text-sizes.mjs --files         # per-hit listing (file:line)
//
// Heuristics are deliberately simple (regex, no AST) and every one is documented
// below so the numbers can be audited. Role is a best-effort guess; kind/px/file/line are exact.

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, extname, dirname, resolve } from 'node:path';
import { detectSizes, lineOf } from './lib/detect.mjs';

const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
// --root <dir> measures another checkout (e.g. the pristine archive for a true "before" number).
const ROOT = resolve(argVal('--root') ?? new URL('../..', import.meta.url).pathname);
const SRC = join(ROOT, 'src');
const TOP = Number(argVal('--top') ?? 15);
const JSON_OUT = argVal('--json');
const LIST_FILES = args.includes('--files');
const MIN_PX = 12; // the floor this programme enforces

// ---------------------------------------------------------------- file walk
const SCAN_EXT = new Set(['.ts', '.tsx', '.css']);
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(extname(entry))) out.push(full);
  }
  return out;
}
const files = walk(SRC);
const rel = (f) => relative(ROOT, f);
const isTestFile = (f) => /\.(test|spec)\.[tj]sx?$/.test(f) || f.includes(`${'/'}test${'/'}`);

// ------------------------------------------------------------ surface graph
// 1. Which page file does each route render, and is the route public or authenticated?
const appText = existsSync(join(SRC, 'App.tsx')) ? readFileSync(join(SRC, 'App.tsx'), 'utf8') : '';
const lazyMap = new Map(); // ComponentName -> absolute file
for (const m of appText.matchAll(/const\s+(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
  const f = resolveImport(m[2], join(SRC, 'App.tsx'));
  if (f) lazyMap.set(m[1], f);
}
const AUTH_WRAPPERS = /<(ProtectedRoute|StaffRoute|PartnerRoute|SupplierRoute)\b/;
const pageSurface = new Map(); // abs file -> Set('dashboard'|'marketing')
// Routes routinely span several lines, so chunk App.tsx from one "<Route" to the next and read the
// path + every capitalised element inside the chunk. Nested layout routes are not modelled.
const routeChunks = appText.split(/(?=<Route\b)/).slice(1);
let routeCount = 0;
for (const chunk of routeChunks) {
  const path = chunk.match(/\bpath=["']([^"']+)["']/)?.[1];
  if (path === undefined || !/\belement=/.test(chunk.slice(0, 400))) continue;
  routeCount++;
  const surface = path.startsWith('/dashboard') || AUTH_WRAPPERS.test(chunk) ? 'dashboard' : 'marketing';
  for (const name of chunk.matchAll(/<([A-Z]\w+)/g)) {
    const f = lazyMap.get(name[1]);
    if (f) (pageSurface.get(f) ?? pageSurface.set(f, new Set()).get(f)).add(surface);
  }
}

// 2. Import graph (regex: static `from '…'` + dynamic import('…')).
function resolveImport(spec, fromFile) {
  let base;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const cand of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}
const graph = new Map();
for (const f of files) {
  if (extname(f) === '.css') continue;
  const text = readFileSync(f, 'utf8');
  const deps = new Set();
  for (const m of text.matchAll(/(?:from\s+|import\(\s*)['"]([^'"]+)['"]/g)) {
    const d = resolveImport(m[1], f);
    if (d) deps.add(d);
  }
  graph.set(f, deps);
}
// 3. Propagate surface from pages to everything they (transitively) import.
const fileSurface = new Map();
for (const [page, set] of pageSurface) {
  const seen = new Set([page]);
  const stack = [page];
  while (stack.length) {
    const cur = stack.pop();
    for (const s of set) (fileSurface.get(cur) ?? fileSurface.set(cur, new Set()).get(cur)).add(s);
    for (const d of graph.get(cur) ?? []) {
      if (!seen.has(d)) {
        seen.add(d);
        stack.push(d);
      }
    }
  }
}
function surfaceOf(f) {
  if (extname(f) === '.css') return 'global-css';
  const s = fileSurface.get(f);
  if (!s) return 'unrouted';
  if (s.size > 1) return 'shared';
  return [...s][0];
}
const isMobileFile = (f) =>
  /(\/|^)(mobile|native)(\/|$)/i.test(rel(f)) || /Mobile[A-Z]?\w*\.tsx?$/.test(rel(f)) || /PullToRefresh|BottomSheet|SwipeAction|PwaInstall/.test(rel(f));

// -------------------------------------------------------------------- roles
function enclosingTag(text, idx) {
  // nearest opening "<Tag" before idx that hasn't been closed by ">" outside braces — approximated
  // by taking the last "<Letter" in the preceding 600 chars.
  const win = text.slice(Math.max(0, idx - 600), idx);
  const m = [...win.matchAll(/<([A-Za-z][\w.]*)/g)].pop();
  return m ? m[1] : null;
}
function classifyRole({ tag, ctx, kind, assignedName }) {
  const t = (tag ?? '').toLowerCase();
  if (kind === 'svg-attr' || t === 'text' || t === 'tspan' || /\b(axis|tick|legend)\b/i.test(ctx)) return 'axis-label';
  if (['th', 'td', 'resizableth', 'tableheader', 'tablecell'].includes(t) || /\bcolumn\b.*header/i.test(ctx)) return 'table-cell';
  if (t === 'label' || t === 'legend' || t === 'fieldlabel') return 'label';
  if (/badge|chip|pill|tag|status/i.test(tag ?? '') || /badge|chip|pill/i.test(assignedName ?? '') || (/rounded-full/.test(ctx) && /\bpx-\d/.test(ctx))) return 'badge';
  if (t === 'button' || /Button$/.test(tag ?? '')) return 'button';
  if (/uppercase/.test(ctx) && /tracking-/.test(ctx)) return 'eyebrow';
  if (/\b(helper|hint|help-?text|description|error|invalid|aria-describedby)\b/i.test(ctx)) return 'helper-text';
  if (/text-(text-)?(secondary|muted|tertiary)/.test(ctx) || t === 'small' || t === 'figcaption' || t === 'caption') return 'caption';
  if (/tabular-nums|font-mono/.test(ctx)) return 'figure-or-id';
  return 'other';
}

// ---------------------------------------------------------------- detectors
// Detection lives in ./lib/detect.mjs (shared with the CI guard so the audit and the gate cannot disagree).
const hits = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const ext = extname(f);
  const common = { file: rel(f), surface: surfaceOf(f), mobile: isMobileFile(f), test: isTestFile(rel(f)) };
  for (const d of detectSizes(text, ext)) {
    const ctxLen = ext === '.css' ? 80 : 160;
    const ctx = text.slice(Math.max(0, d.index - ctxLen), d.index + ctxLen);
    const assignedName = text.slice(Math.max(0, d.index - 200), d.index).match(/(?:const|let)\s+(\w+)\s*=[^;]*$/)?.[1];
    hits.push({
      ...common,
      line: lineOf(text, d.index),
      kind: d.kind,
      raw: d.raw,
      px: d.px,
      relative: d.relative,
      svgUnits: d.kind === 'svg-attr',
      role: classifyRole({ tag: d.kind === 'css' ? null : enclosingTag(text, d.index), ctx, kind: d.kind, assignedName }),
    });
  }
}

// ------------------------------------------------------------------ summary
// Parent-relative (em) sizes cannot be resolved statically; they are counted separately (the CI guard proves the allowlisted ones).
const tiny = hits.filter((h) => h.px < MIN_PX && !h.relative);
const prod = (arr) => arr.filter((h) => !h.test);
const tally = (arr, key) => {
  const o = {};
  for (const h of arr) o[typeof key === 'function' ? key(h) : h[key]] = (o[typeof key === 'function' ? key(h) : h[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
};
const byFile = Object.entries(tally(prod(hits), 'file')).slice(0, TOP);
const bucket = (px) => (px < 9 ? '<9' : px < 10 ? '9' : px < 11 ? '10' : px < 12 ? '11' : px === 12 ? '12' : px <= 14 ? '13-14' : '>14');
const exactCaption = prod(hits).filter((h) => h.kind === 'tailwind-arbitrary' && h.raw === 'text-[11px]');

// "text-[11px] text-text-secondary" pairs — re-measured separately since the brief quotes it.
let pair11Secondary = 0;
for (const f of files) {
  if (extname(f) === '.css') continue;
  pair11Secondary += (readFileSync(f, 'utf8').match(/text-\[11px\] text-text-secondary/g) ?? []).length;
}

const report = {
  generatedAt: new Date().toISOString(),
  floorPx: MIN_PX,
  totals: {
    allNonTokenSizes: hits.length,
    inTests: hits.filter((h) => h.test).length,
    production: prod(hits).length,
    productionBelowFloor: prod(tiny).length,
    productionParentRelativeEm: prod(hits).filter((h) => h.relative).length,
    productionTailwindArbitrary: prod(hits).filter((h) => h.kind === 'tailwind-arbitrary').length,
    productionTailwindArbitraryBelowFloor: prod(tiny).filter((h) => h.kind === 'tailwind-arbitrary').length,
    productionTailwindArbitraryPxOnly: prod(hits).filter((h) => h.kind === 'tailwind-arbitrary' && /px\]/.test(h.raw)).length,
    exact_text_11px: exactCaption.length,
    exact_text_11px_text_text_secondary_pair: pair11Secondary,
  },
  byKind: tally(prod(hits), 'kind'),
  belowFloorByKind: tally(prod(tiny), 'kind'),
  belowFloorByPxBucket: tally(prod(tiny), (h) => bucket(h.px)),
  allByPxBucket: tally(prod(hits), (h) => bucket(h.px)),
  belowFloorByRole: tally(prod(tiny), 'role'),
  belowFloorBySurface: tally(prod(tiny), 'surface'),
  belowFloorMobileFlag: tally(prod(tiny), (h) => (h.mobile ? 'mobile-module' : 'other')),
  densestFiles: byFile.map(([file, n]) => ({
    file,
    total: n,
    belowFloor: prod(tiny).filter((h) => h.file === file).length,
    surface: hits.find((h) => h.file === file)?.surface,
  })),
  hits,
};

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));

const pad = (s, n) => String(s).padEnd(n);
const section = (title, obj) => {
  console.log(`\n${title}`);
  for (const [k, v] of Object.entries(obj)) console.log(`  ${pad(k, 28)} ${v}`);
};
console.log(`Text-size audit (floor ${MIN_PX}px, root 16px) — ${files.length} files scanned, ${routeCount} routes parsed, ${pageSurface.size} routed pages`);
section('TOTALS', report.totals);
section('BY KIND (production)', report.byKind);
section('BELOW FLOOR — by kind', report.belowFloorByKind);
section('BELOW FLOOR — by px bucket', report.belowFloorByPxBucket);
section('BELOW FLOOR — by role (heuristic)', report.belowFloorByRole);
section('BELOW FLOOR — by surface (router-derived)', report.belowFloorBySurface);
section('BELOW FLOOR — mobile-module flag', report.belowFloorMobileFlag);
console.log(`\nDENSEST ${TOP} FILES (production, all non-token sizes)`);
for (const d of report.densestFiles) console.log(`  ${pad(d.total, 4)} (${pad(d.belowFloor, 3)} <${MIN_PX}px)  ${pad(d.surface, 10)} ${d.file}`);
if (LIST_FILES) {
  console.log('\nHITS');
  for (const h of prod(hits)) console.log(`${h.file}:${h.line}\t${h.px.toFixed(1)}px\t${h.kind}\t${h.role}\t${h.surface}\t${h.raw}`);
}
if (JSON_OUT) console.log(`\nFull report written to ${JSON_OUT}`);
