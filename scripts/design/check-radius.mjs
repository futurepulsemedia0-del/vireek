#!/usr/bin/env node
// scripts/design/check-radius.mjs
//
// Phase 3 guard (also called from scripts/check-design-system.mjs). Ratchet, not a big bang:
//   * a file NOT in the baseline may not use raw radius steps at all (use role aliases),
//   * a file in the baseline may never exceed its recorded counts,
//   * nobody may add a new small-element-with-large-radius, `legacy-md`, arbitrary radius or non-allowlisted 3xl.
//
//   node scripts/design/check-radius.mjs            # check
//   node scripts/design/check-radius.mjs --init     # (re)create baseline from the current tree (do this once, after the migration)
//   node scripts/design/check-radius.mjs --ratchet  # lower baseline entries that improved; never raises

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanProject, SMALL_ROLES, arbitraryPx, targetFor } from './lib/radius-classify.mjs';

const BASELINE_URL = new URL('./radius-baseline.json', import.meta.url);
const RAW = new Set(['md', 'lg', 'xl', '2xl', '3xl']); // sm / bare / none / full / aliases are always allowed
const KEYS = ['raw', 'smallLarge', 'legacyMd', 'arbitrary', 'hero3xl', 'cssRaw', 'inlineRaw'];
const MESSAGES = {
  raw: 'raw radius step in new code — use a role alias: rounded-control (buttons/inputs/tabs), rounded-inset (nested callouts/tiles/images), rounded-chip, rounded-surface (cards/panels/menus), rounded-overlay (modals/sheets), or rounded-full for circles/pills',
  smallLarge: 'rounded-2xl/3xl (or an arbitrary radius > 12px) on a small element — small elements never exceed rounded-lg (use rounded-control / rounded-chip / rounded-inset)',
  legacyMd: 'rounded-legacy-md is a one-release compatibility alias — migrate by role (rounded-control / rounded-surface / …)',
  arbitrary: 'arbitrary radius value — use a scale step or role alias',
  hero3xl: 'rounded-3xl is only allowed for files listed in scripts/design/radius-allowlist.json',
  cssRaw: "raw border-radius in CSS — use border-radius: theme('borderRadius.control' | 'inset' | 'surface' | 'overlay'); Tailwind resolves it in any processed CSS file (2px, 50% and 9999px are exempt)",
  inlineRaw: 'raw borderRadius in TS/TSX (inline style or SDK appearance) — use a value from the scale (8 control/inset, 12 surface, 16 overlay) and say why a class cannot be used',
};

function* walkText(root) {
  function* rec(dir) {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) { if (e !== 'node_modules' && e !== 'locales') yield* rec(full); }
      else if (['.css', '.ts', '.tsx'].includes(extname(e)) && !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(e)) yield relative(root, full).split(sep).join('/');
    }
  }
  yield* rec(join(root, 'src'));
}

export function countByFile(root) {
  let allow = {};
  try { allow = JSON.parse(readFileSync(new URL('./radius-allowlist.json', import.meta.url), 'utf8')); } catch { /* none */ }
  const files = {};
  const where = {};
  const rawFiles = new Set(allow.rawFiles ?? []);
  for (const r of scanProject(root)) {
    const f = (files[r.file] ??= { raw: 0, smallLarge: 0, legacyMd: 0, arbitrary: 0, hero3xl: 0, cssRaw: 0, inlineRaw: 0 });
    const hit = (k) => { f[k]++; (where[`${r.file}#${k}`] ??= []).push({ line: r.line, token: r.token, role: r.role, target: targetFor(r, allow) }); };
    const isSide = ['tl', 'tr', 'bl', 'br', 'ss', 'se', 'es', 'ee'].includes(r.side);
    if (r.size === 'legacy-md') hit('legacyMd');
    if (r.size.startsWith('[')) hit('arbitrary');
    if (r.size === '3xl' && !(allow.hero3xl ?? []).includes(r.file)) hit('hero3xl');
    const large = ['2xl', '3xl'].includes(r.size) || (r.size.startsWith('[') && (arbitraryPx(r.size) ?? 0) > 12);
    if (large && SMALL_ROLES.has(r.role) && !r.side) hit('smallLarge');
    if (RAW.has(r.size) && !isSide && !rawFiles.has(r.file)) hit('raw');
  }
  // Non-Tailwind radii: CSS declarations and inline/SDK `borderRadius`.
  for (const rel of walkText(root)) {
    const text = readFileSync(join(root, rel), 'utf8');
    const isCss = rel.endsWith('.css');
    const re = isCss ? /border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*(\d+(?:\.\d+)?)px/g : /\bborderRadius\s*:\s*['"]?(\d+(?:\.\d+)?)(?:px)?['"]?/g;
    const key = isCss ? 'cssRaw' : 'inlineRaw';
    for (const m of text.matchAll(re)) {
      const px = parseFloat(m[1]);
      if (px < 3 || px >= 9999) continue;
      const f = (files[rel] ??= { raw: 0, smallLarge: 0, legacyMd: 0, arbitrary: 0, hero3xl: 0, cssRaw: 0, inlineRaw: 0 });
      f[key]++;
      (where[`${rel}#${key}`] ??= []).push({ line: text.slice(0, m.index).split('\n').length, token: m[0].trim(), role: isCss ? 'css' : 'inline', target: null });
    }
  }
  return { files, where };
}

export function radiusViolations(root) {
  if (!existsSync(BASELINE_URL)) return [{ rule: 'radius-baseline', file: 'scripts/design/radius-baseline.json', line: 0, snippet: 'baseline missing — run: node scripts/design/check-radius.mjs --init (after the radius migration)' }];
  const base = JSON.parse(readFileSync(BASELINE_URL, 'utf8')).files ?? {};
  const { files, where } = countByFile(root);
  const out = [];
  for (const [file, c] of Object.entries(files)) {
    const b = base[file];
    for (const k of KEYS) {
      const allowed = k === 'raw' ? (b ? b.raw ?? 0 : 0) : b?.[k] ?? 0;
      if (c[k] <= allowed) continue;
      const hits = where[`${file}#${k}`] ?? [];
      // report the last (c[k]-allowed) occurrences: new code is almost always appended
      for (const h of hits.slice(allowed)) out.push({ rule: `radius-${k}`, file, line: h.line, snippet: `${h.token} on <${h.role}> — ${MESSAGES[k]}${h.target ? ` (suggested: rounded-${h.target})` : ''}` });
    }
  }
  return out;
}

function main() {
  const root = new URL('../..', import.meta.url).pathname;
  const args = process.argv.slice(2);
  if (args.includes('--init') || args.includes('--ratchet')) {
    const { files } = countByFile(root);
    const prev = existsSync(BASELINE_URL) && !args.includes('--init') ? JSON.parse(readFileSync(BASELINE_URL, 'utf8')).files : {};
    const next = {};
    for (const [f, c] of Object.entries(files)) {
      if (!KEYS.some((k) => c[k])) continue;
      next[f] = Object.fromEntries(KEYS.map((k) => [k, prev[f] ? Math.min(prev[f][k] ?? 0, c[k]) : c[k]]));
    }
    writeFileSync(BASELINE_URL, `${JSON.stringify({ _comment: 'Ratchet: counts may only go down. Regenerate with --ratchet after cleaning up.', files: next }, null, 2)}\n`);
    console.log(`baseline written: ${Object.keys(next).length} files`);
    return;
  }
  const v = radiusViolations(root);
  for (const x of v) console.error(`${x.file}:${x.line}  [${x.rule}]  ${x.snippet}`);
  console.log(v.length ? `\n${v.length} radius violation(s).` : 'radius guard: OK');
  process.exit(v.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
