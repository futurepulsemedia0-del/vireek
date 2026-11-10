#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  Regional-assumptions ratchet                                        */
/*  Fails CI when NEW hard-coded USD / imperial / US-format literals    */
/*  appear outside the region-aware formatting layer. Existing sites    */
/*  are grandfathered in scripts/regional-assumptions-baseline.json and */
/*  may only go DOWN.                                                   */
/*                                                                      */
/*    node scripts/check-regional-assumptions.mjs                check   */
/*    node scripts/check-regional-assumptions.mjs --list         report  */
/*    node scripts/check-regional-assumptions.mjs --write-baseline       */
/*        (first run creates it; afterwards it can only shrink)          */
/*    node scripts/check-regional-assumptions.mjs --write-baseline --init*/
/*        (re-create from scratch, e.g. after intentionally exempting)   */
/* ------------------------------------------------------------------ */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { RULES, scanText, isExempt, findRegressions, mergeShrinkOnly } from './lib/regionalAssumptions.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const BASELINE = join(ROOT, 'scripts', 'regional-assumptions-baseline.json');

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { if (entry !== 'node_modules') yield* walk(full); }
    else if (['.ts', '.tsx'].includes(extname(entry))) yield full;
  }
}

const current = {};
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).split(sep).join('/');
  if (isExempt(rel)) continue;
  const hits = scanText(readFileSync(file, 'utf8'));
  if (Object.keys(hits).length) current[rel] = hits;
}
const args = process.argv.slice(2);
const totals = {};
for (const rules of Object.values(current)) for (const [r, n] of Object.entries(rules)) totals[r] = (totals[r] ?? 0) + n;
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

if (args.includes('--list')) {
  for (const [r, n] of Object.entries(totals)) console.log(String(n).padStart(5), r, '—', RULES[r].fix);
  console.log(`\n${Object.keys(current).length} files with grandfathered hard-coded assumptions`);
  process.exit(0);
}
if (args.includes('--write-baseline')) {
  const prior = existsSync(BASELINE) && !args.includes('--init') ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
  const next = prior ? mergeShrinkOnly(current, prior) : current;
  writeFileSync(BASELINE, JSON.stringify(sortObj(next), null, 2) + '\n');
  console.log(`Baseline written (${prior ? 'shrink-only' : 'initial'}): ${Object.keys(next).length} files.`);
  process.exit(0);
}
if (!existsSync(BASELINE)) {
  console.error('Missing scripts/regional-assumptions-baseline.json — run: node scripts/check-regional-assumptions.mjs --write-baseline');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const bad = findRegressions(current, baseline);
if (bad.length) {
  console.error('New hard-coded US-region assumptions found. Use the region profile instead:\n');
  for (const [f, r, n, a] of bad) console.error(`  ${f}: ${r} = ${n} (allowed ${a})\n    fix: ${RULES[r].fix}`);
  process.exit(1);
}
const improved = Object.keys(baseline).some((f) => Object.entries(baseline[f]).some(([r, n]) => (current[f]?.[r] ?? 0) < n));
console.log(`regional-assumptions ratchet OK: ${Object.keys(current).length} grandfathered files.`);
if (improved) console.log('Some files improved — run with --write-baseline to lock in the progress.');
