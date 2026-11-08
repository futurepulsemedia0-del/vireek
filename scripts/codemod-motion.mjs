#!/usr/bin/env node
// Usage:  node scripts/codemod-motion.mjs            (dry run: prints counts + review list)
//         node scripts/codemod-motion.mjs --write    (applies changes)
// Rewrites `transition-all` -> transition-interactive | transition-layout (tailwind.config.js transitionProperty)
// and `behavior: 'smooth'` -> `behavior: scrollBehavior()`. Review the layout list in the diff.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { rewriteSmoothScroll, rewriteTransitionAll } from './motion/codemod-lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const WRITE = process.argv.includes('--write');
const SKIP = [/\.test\.tsx?$/, /src\/lib\/motionPolicy\.ts$/, /node_modules/];

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules') yield* walk(p); }
    else if (['.ts', '.tsx'].includes(extname(p))) yield p;
  }
}

const tot = { files: 0, simple: 0, layout: 0, smooth: 0 };
const layoutFiles = [];
for (const file of walk(join(ROOT, 'src'))) {
  if (SKIP.some((r) => r.test(file))) continue;
  const before = readFileSync(file, 'utf8');
  const a = rewriteTransitionAll(before);
  const b = rewriteSmoothScroll(a.out);
  if (a.simple + a.layout + b.count === 0) continue;
  tot.files++; tot.simple += a.simple; tot.layout += a.layout; tot.smooth += b.count;
  if (a.layout) layoutFiles.push(`${relative(ROOT, file)} (${a.layout})`);
  if (WRITE) writeFileSync(file, b.out);
}
console.log(`${WRITE ? 'WROTE' : 'DRY RUN'}: ${tot.files} files | transition-interactive: ${tot.simple} | transition-layout: ${tot.layout} | smooth-scroll: ${tot.smooth}`);
if (layoutFiles.length) console.log('Files that got transition-layout (verify visually):\n  ' + layoutFiles.join('\n  '));
