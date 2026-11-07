#!/usr/bin/env node
// scripts/design/normalize-layout.mjs
// Codemod: z-[n] / z-10..50 -> named layers, shadow-sm..2xl -> elevation-1..4,
// arbitrary spacing/size -> theme tokens (ONLY when a pixel-identical token exists).
//
//   node scripts/design/normalize-layout.mjs            # dry run + report (writes nothing)
//   node scripts/design/normalize-layout.mjs --apply    # rewrite files in place
//   node scripts/design/normalize-layout.mjs --only=z,shadow   # subset: z | shadow | spacing
//   node scripts/design/normalize-layout.mjs --json     # machine-readable report
//
// Anything it cannot map with certainty is listed under "needs review" and left untouched.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { transformSource } from './layout-tokens.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const asJson = args.has('--json');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice(7).split(',') : ['z', 'shadow', 'spacing'];

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) {
      if (e === 'node_modules' || e === 'locales') continue;
      yield* walk(full);
    } else if (['.ts', '.tsx'].includes(extname(e)) && !/\.(test|spec|d)\.(ts|tsx)$/.test(e)) yield full;
  }
}

const tally = { z: 0, shadow: 0, spacing: 0 };
const reviewTally = { z: 0, shadow: 0, spacing: 0 };
const review = [];
let filesChanged = 0;

for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  const { code, changes, review: rv } = transformSource(src, relative(ROOT, file), {
    z: only.includes('z'), shadow: only.includes('shadow'), spacing: only.includes('spacing'),
  });
  for (const c of changes) tally[c.kind]++;
  for (const r of rv) { reviewTally[r.kind]++; review.push({ file: relative(ROOT, file), ...r }); }
  if (code !== src) {
    filesChanged++;
    if (apply) writeFileSync(file, code);
  }
}

if (asJson) {
  console.log(JSON.stringify({ applied: apply, filesChanged, migrated: tally, needsReview: reviewTally, review }, null, 2));
} else {
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'} — files ${apply ? 'changed' : 'that would change'}: ${filesChanged}`);
  console.log(`  migrated   z: ${tally.z}   shadow: ${tally.shadow}   spacing: ${tally.spacing}`);
  console.log(`  needs review (left untouched)   z: ${reviewTally.z}   shadow: ${reviewTally.shadow}   spacing: ${reviewTally.spacing}`);
  if (review.length) {
    console.log('\nNeeds review (file:line token):');
    for (const r of review.filter((x) => x.kind !== 'spacing')) console.log(`  ${r.file}:${r.line}  [${r.kind}] ${r.token}`);
    console.log(`  … plus ${reviewTally.spacing} spacing values with no pixel-identical token (see --json).`);
  }
  if (!apply) console.log('\nRe-run with --apply to write changes.');
}
