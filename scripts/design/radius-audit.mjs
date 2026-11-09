#!/usr/bin/env node
// scripts/design/radius-audit.mjs
//
// Phase 0 of the border-radius work: measure every `rounded-*` use by element
// ROLE (AST + class-pattern classification, see lib/radius-classify.mjs) and
// report the visual outliers.
//
//   node scripts/design/radius-audit.mjs                 # markdown report
//   node scripts/design/radius-audit.mjs --json out.json # + machine-readable
//   node scripts/design/radius-audit.mjs --tests         # include *.test/spec files
//   node scripts/design/radius-audit.mjs --list 2xl-small  # list one outlier class (file:line)
//
// Counting unit: one radius token occurrence. Side variants (rounded-t-2xl) are
// folded into their size; `md:rounded-xl` counts as xl. Token source for
// everything else (what is "small", what is "monotonic") is radius-tokens.mjs.

import { readFileSync, writeFileSync } from 'node:fs';
import { scanProject, ROLES, SMALL_ROLES, targetFor, arbitraryPx, rankOf, squareDim } from './lib/radius-classify.mjs';
import { RADIUS_PX, RADIUS_ROLES, BEFORE_PX } from './radius-tokens.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const args = process.argv.slice(2);
const NEW_SCALE = args.includes('--new-scale'); // run on a migrated tree: md=6px, sm=4px, aliases resolved
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const listKey = args.includes('--list') ? args[args.indexOf('--list') + 1] : null;
const allow = (() => { try { return JSON.parse(readFileSync(new URL('./radius-allowlist.json', import.meta.url), 'utf8')); } catch { return {}; } })();
const recs = scanProject(ROOT, { includeTests: args.includes('--tests') });

const label = (r) => (r.size === 'DEFAULT' ? 'rounded' : `rounded-${r.size}`);
const COLS = ['rounded', 'rounded-sm', 'rounded-md', 'rounded-legacy-md', 'rounded-lg', 'rounded-xl', 'rounded-2xl', 'rounded-3xl', 'rounded-full', 'rounded-control', 'rounded-inset', 'rounded-chip', 'rounded-surface', 'rounded-overlay', 'arbitrary', 'rounded-none'];
const col = (r) => (r.size.startsWith('[') ? 'arbitrary' : label(r));

// ------------------------------------------------------------ histograms ---
const bySize = {};
const matrix = {};
for (const r of recs) {
  bySize[col(r)] = (bySize[col(r)] || 0) + 1;
  ((matrix[r.role] ||= {})[col(r)] = (matrix[r.role]?.[col(r)] || 0) + 1);
}

// -------------------------------------------------------------- outliers ---
const isFull = (r) => r.size === 'full';
const large = (r) => ['2xl', '3xl'].includes(r.size) || (r.size.startsWith('[') && (arbitraryPx(r.size) ?? 0) > 12);
const OUTLIERS = {
  '2xl-small': { title: 'rounded-2xl/3xl/arbitrary>12px on a SMALL element (button, input, tab, chip, tile, callout…)', test: (r) => large(r) && SMALL_ROLES.has(r.role) && !r.side },
  '3xl': { title: 'rounded-3xl (only an allow-listed hero may keep it)', test: (r) => r.size === '3xl' },
  'full-on-rect': { title: 'rounded-full on a surface/overlay/image (not circular, not a pill)', test: (r) => isFull(r) && ['card', 'panel', 'modal', 'sheet', 'dropdown', 'toast', 'image'].includes(r.role) },
  'full-pill-button': { title: 'rounded-full on a button/input (pill-shaped, not circular) — needs a deliberate keep/drop decision', test: (r) => isFull(r) && ['button', 'input', 'tab'].includes(r.role) && squareDim(r.cls) == null && r.tag !== 'IconButton' },
  'md-inversion': { title: 'rounded-md (renders 12px today, i.e. LARGER than rounded-lg 8px)', test: (r) => r.size === 'md' && !NEW_SCALE },
  'bare-rounded-surface': { title: 'bare `rounded` (4px) on a card/panel/modal', test: (r) => r.size === 'DEFAULT' && ['card', 'panel', 'modal', 'sheet', 'dropdown'].includes(r.role) },
  arbitrary: { title: 'arbitrary radius values (violate "no arbitrary radii")', test: (r) => r.size.startsWith('[') },
  'sharp-surface': { title: 'sm/none on a card/panel/modal/button/input', test: (r) => ['sm', 'none'].includes(r.size) && ['card', 'panel', 'modal', 'sheet', 'dropdown', 'button', 'input'].includes(r.role) },
};
const outliers = {};
for (const [k, o] of Object.entries(OUTLIERS)) outliers[k] = recs.filter((r) => o.test(r));

// Files that mix md and lg: same screen shows 12px "md" next to 8px "lg".
const sizesByFile = {};
for (const r of recs) (sizesByFile[r.file] ||= new Set()).add(r.size);
const mixMdLg = Object.entries(sizesByFile).filter(([, s]) => s.has('md') && s.has('lg')).map(([f]) => f);

// Nesting: a child whose radius is >= its nearest ancestor's (no hierarchy). Only sized, non-full, non-responsive tokens.
const primary = new Map(); // jsxId -> {rank,size,file}
for (const r of recs) if (r.jsxId && !r.side && !r.responsive && r.size !== 'full' && r.size !== 'none') primary.set(`${r.file}#${r.jsxId}`, r);
let nestedPairs = 0, nestedSame = 0;
const nestedSamples = [];
for (const r of primary.values()) {
  let p = r.parentJsxId ? primary.get(`${r.file}#${r.parentJsxId}`) : null;
  if (!p) continue;
  nestedPairs++;
  if (rankOf(r.size) >= rankOf(p.size)) { nestedSame++; if (nestedSamples.length < 8) nestedSamples.push(`${r.file}:${r.line} (${label(r)} inside ${label(p)})`); }
}

// ---------------------------------------------------------------- output ---
const pad = (s, n) => String(s).padStart(n);
const total = recs.length;
const out = [];
out.push(`# Border-radius audit (Phase 0)\n`);
out.push(`Scanned ${new Set(recs.map((r) => r.file)).size} files, ${total} radius tokens (${args.includes('--tests') ? 'tests included' : 'tests excluded'}).\n`);
out.push('## By size');
out.push('| size | uses | % |\n|---|---:|---:|');
for (const c of COLS) if (bySize[c]) out.push(`| ${c} | ${bySize[c]} | ${((bySize[c] / total) * 100).toFixed(1)}% |`);
out.push(`\nxl+2xl+3xl together: ${(bySize['rounded-xl'] || 0) + (bySize['rounded-2xl'] || 0) + (bySize['rounded-3xl'] || 0)} uses (${((((bySize['rounded-xl'] || 0) + (bySize['rounded-2xl'] || 0) + (bySize['rounded-3xl'] || 0)) / total) * 100).toFixed(1)}%).\n`);
out.push('## By role × size');
const hdr = COLS.filter((c) => bySize[c]);
out.push(`| role | total | ${hdr.map((h) => h.replace('rounded-', '').replace('rounded', 'bare')).join(' | ')} |\n|---|---:|${hdr.map(() => '---:').join('|')}|`);
for (const role of ROLES) {
  const m = matrix[role]; if (!m) continue;
  const t = Object.values(m).reduce((a, b) => a + b, 0);
  out.push(`| ${role} | ${t} | ${hdr.map((h) => m[h] || '·').join(' | ')} |`);
}
out.push('\n## Visual outliers');
for (const [k, o] of Object.entries(OUTLIERS)) {
  const list = outliers[k];
  const files = {}; for (const r of list) files[r.file] = (files[r.file] || 0) + 1;
  const top = Object.entries(files).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, n]) => `${f} (${n})`).join(', ');
  out.push(`- **${k}** — ${list.length} uses in ${Object.keys(files).length} files — ${o.title}${top ? `\n  top: ${top}` : ''}`);
}
out.push(`- **md+lg in the same file** — ${mixMdLg.length} files render 12px "md" beside 8px "lg"`);
out.push(`- **no hierarchy (child radius ≥ parent radius, same file)** — ${nestedSame} of ${nestedPairs} measurable nested pairs (${nestedPairs ? ((nestedSame / nestedPairs) * 100).toFixed(0) : 0}%)${nestedSamples.length ? `\n  e.g. ${nestedSamples.slice(0, 4).join('; ')}` : ''}`);
// ------------------------------------------------------ projected "after" ---
const pxOf = (size) => {
  if (size.startsWith('[')) return Math.round(arbitraryPx(size) ?? 12);
  if (RADIUS_ROLES[size]) return RADIUS_PX[RADIUS_ROLES[size]];
  if (size === 'legacy-md') return 12;
  if (NEW_SCALE && size === 'md') return RADIUS_PX.md;
  if (NEW_SCALE && size === 'sm') return RADIUS_PX.sm;
  return BEFORE_PX[size] ?? 12;
};
function afterPx(r) {
  const before = pxOf(r.size);
  if (r.size === 'none') return 0;
  const t = targetFor(r, allow);
  if (!t) return before === pxOf('md') && r.size === 'md' ? 12 : before;
  return t === 'full' ? 9999 : RADIUS_PX[RADIUS_ROLES[t]];
}
const bucket = (n) => (n >= 9999 ? 'full' : `${n}px`);
const hBefore = {}, hAfter = {}; let changed = 0;
for (const r of recs) {
  const b = pxOf(r.size), a = afterPx(r);
  hBefore[bucket(b)] = (hBefore[bucket(b)] || 0) + 1;
  hAfter[bucket(a)] = (hAfter[bucket(a)] || 0) + 1;
  if (a !== b) changed++;
}
out.push('\n## Rendered-radius histogram: BEFORE vs PROJECTED AFTER (role mapping applied to this snapshot)');
out.push('| rendered radius | before | after (projected) |\n|---|---:|---:|');
for (const k of ['0px', '2px', '4px', '6px', '8px', '12px', '16px', '24px', '32px', 'full']) if (hBefore[k] || hAfter[k]) out.push(`| ${k} | ${hBefore[k] || 0} | ${hAfter[k] || 0} |`);
const other = (h) => Object.entries(h).filter(([k]) => !['0px', '2px', '4px', '6px', '8px', '12px', '16px', '24px', '32px', 'full'].includes(k)).reduce((a, [, v]) => a + v, 0);
if (other(hBefore) || other(hAfter)) out.push(`| other arbitrary px | ${other(hBefore)} | ${other(hAfter)} |`);
out.push(`\nTokens whose rendered radius would change: ${changed} of ${total} (${((changed / total) * 100).toFixed(1)}%). Projection assumes the classifier is right; Phase 2 reviews by batch.`);
const unclassified = matrix.other ? Object.values(matrix.other).reduce((a, b) => a + b, 0) : 0;
out.push(`\nClassification coverage: ${(((total - unclassified) / total) * 100).toFixed(1)}% classified by a rule; ${unclassified} tokens fell into \`other\` (listed by --list other).`);
console.log(out.join('\n'));

if (listKey) {
  const list = listKey === 'other' ? recs.filter((r) => r.role === 'other') : outliers[listKey] ?? [];
  console.log(`\n## ${listKey} (${list.length})`);
  for (const r of list) console.log(`${r.file}:${r.line}  ${label(r)}  <${r.tag || '-'}> ${r.role}`);
}
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ total, bySize, matrix, outliers: Object.fromEntries(Object.entries(outliers).map(([k, v]) => [k, v.length])), mixMdLg: mixMdLg.length, nested: { pairs: nestedPairs, noHierarchy: nestedSame } }, null, 2));
}
