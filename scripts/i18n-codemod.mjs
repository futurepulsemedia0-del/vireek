#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  i18n codemod — RTL-safe Tailwind classes + locale-aware formatting */
/*                                                                      */
/*    node scripts/i18n-codemod.mjs rtl            (dry run)            */
/*    node scripts/i18n-codemod.mjs rtl --write                         */
/*    node scripts/i18n-codemod.mjs locale --write                      */
/*    node scripts/i18n-codemod.mjs all --write src/pages               */
/*                                                                      */
/*  Dry run is the default: it prints what WOULD change. Review with    */
/*  `git diff` after --write; revert with `git checkout -- src`.        */
/* ------------------------------------------------------------------ */

import fs from 'node:fs';
import path from 'node:path';
import { transformLocale, transformRtl } from './i18n-codemod-lib.mjs';

const [mode = 'all', ...rest] = process.argv.slice(2);
const write = rest.includes('--write');
const roots = rest.filter((a) => !a.startsWith('--'));
if (!['rtl', 'locale', 'all'].includes(mode)) {
  console.error('Usage: node scripts/i18n-codemod.mjs <rtl|locale|all> [--write] [paths…]');
  process.exit(1);
}

const SKIP = [/node_modules/, /\.test\.[tj]sx?$/, /src[\\/]lib[\\/]format\.ts$/, /src[\\/]locales[\\/]/, /\.d\.ts$/];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !SKIP.some((r) => r.test(p))) yield p;
  }
}

let files = 0, rtlChanges = 0, localeChanges = 0;
const skippedLines = [];

for (const root of roots.length ? roots : ['src']) {
  for (const file of walk(root)) {
    const original = fs.readFileSync(file, 'utf8');
    let code = original;
    if (mode === 'rtl' || mode === 'all') {
      const r = transformRtl(code);
      code = r.code;
      rtlChanges += r.changes;
      r.skipped.forEach((s) => skippedLines.push(`${file}:${s.line}  ${s.text}`));
    }
    if (mode === 'locale' || mode === 'all') {
      const r = transformLocale(code);
      code = r.code;
      localeChanges += r.changes;
    }
    if (code !== original) {
      files++;
      if (write) fs.writeFileSync(file, code);
      else console.log('would change', file);
    }
  }
}

console.log(`\n${write ? 'Changed' : 'Would change'} ${files} file(s): ${rtlChanges} RTL class edits, ${localeChanges} locale edits.`);
if (skippedLines.length) {
  console.log(`\n${skippedLines.length} line(s) use left-/right- together with translate/rotate/origin and were left alone.`);
  console.log('Review each by hand (centered or animated elements need a manual decision):\n');
  console.log(skippedLines.join('\n'));
}
if (!write) console.log('\nDry run only. Re-run with --write to apply.');
