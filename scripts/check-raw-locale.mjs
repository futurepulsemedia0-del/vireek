#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  Raw-locale ratchet                                                  */
/*                                                                      */
/*  Bans NEW direct use of toLocaleString/toLocaleDateString/           */
/*  toLocaleTimeString and `new Intl.(NumberFormat|DateTimeFormat|      */
/*  RelativeTimeFormat|ListFormat)` outside the formatting layer —      */
/*  use @/lib/format (or useFormat()) instead.                          */
/*                                                                      */
/*  Existing call sites are grandfathered in scripts/raw-locale-        */
/*  baseline.json and may only go DOWN as files are migrated.           */
/*                                                                      */
/*    node scripts/check-raw-locale.mjs                  check (CI)     */
/*    node scripts/check-raw-locale.mjs --write-baseline create/shrink  */
/*    node scripts/check-raw-locale.mjs --list           per-file counts*/
/* ------------------------------------------------------------------ */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const BASELINE = join(ROOT, 'scripts', 'raw-locale-baseline.json');

/** The formatting layer itself is the only place allowed to touch Intl directly. */
const ALLOWED = new Set(['src/lib/format.ts', 'src/lib/regional.ts', 'src/lib/timezone.ts']);

const PATTERNS = [
  /\.toLocale(?:Date|Time)?String\s*\(/g,
  /new\s+Intl\.(?:NumberFormat|DateTimeFormat|RelativeTimeFormat|ListFormat)\s*\(/g,
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') yield* walk(full);
    } else if (['.ts', '.tsx'].includes(extname(entry)) && !/\.test\.tsx?$/.test(entry)) {
      yield full;
    }
  }
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const counts = {};
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).split(sep).join('/');
  if (ALLOWED.has(rel)) continue;
  const text = stripComments(readFileSync(file, 'utf8'));
  const n = PATTERNS.reduce((sum, re) => sum + (text.match(re)?.length ?? 0), 0);
  if (n > 0) counts[rel] = n;
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);
const args = process.argv.slice(2);

if (args.includes('--list')) {
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([f, n]) => console.log(String(n).padStart(4), f));
  console.log(`\n${total} raw call sites in ${Object.keys(counts).length} files`);
  process.exit(0);
}

if (args.includes('--write-baseline')) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`Baseline written: ${total} call sites in ${Object.keys(counts).length} files.`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('Missing scripts/raw-locale-baseline.json — run: node scripts/check-raw-locale.mjs --write-baseline');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const worse = Object.entries(counts).filter(([f, n]) => n > (baseline[f] ?? 0));
const better = Object.keys(baseline).filter((f) => (counts[f] ?? 0) < baseline[f]);

if (worse.length) {
  console.error('Raw toLocale*/Intl.* usage increased. Use the helpers from @/lib/format (or useFormat()):\n');
  for (const [f, n] of worse) console.error(`  ${f}: ${n} (allowed ${baseline[f] ?? 0})`);
  process.exit(1);
}
console.log(`raw-locale ratchet OK: ${total} grandfathered call sites in ${Object.keys(counts).length} files.`);
if (better.length) console.log(`${better.length} file(s) improved — run with --write-baseline to lock in the progress.`);
