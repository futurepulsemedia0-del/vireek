#!/usr/bin/env node
// scripts/design/dashboard-codemod.mjs
//
// Mechanical, reviewable clean-up of "AI tell" Tailwind classes in the dashboard scope.
//   node scripts/design/dashboard-codemod.mjs            # dry run, prints a per-rule count
//   node scripts/design/dashboard-codemod.mjs --write    # apply
//
// Rules are class-string only (no logic changes). Lines that look like a modal/dialog panel
// keep their large radius (modals are allowed 12–16px).

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DASHBOARD_SCOPE } from './ai-tells.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const write = process.argv.includes('--write');

const MODAL_LINE = /fixed inset-0|role="dialog"|aria-modal|shadow-(?:xl|2xl)\b|\bmax-w-(?:md|lg|xl|2xl|3xl|4xl)\b.*\bw-full\b|\bw-full\b.*\bmax-w-(?:md|lg|xl|2xl|3xl|4xl)\b/;

const RULES = [
  { id: 'radius-2xl', re: /\brounded-2xl\b/g, to: 'rounded-lg', skip: MODAL_LINE },
  { id: 'radius-3xl', re: /\brounded-3xl\b/g, to: 'rounded-xl', skip: MODAL_LINE },
  { id: 'bold', re: /\bfont-(?:bold|extrabold|black)\b/g, to: 'font-semibold' },
  { id: 'pulse', re: / ?\banimate-pulse\b/g, to: '' },
  { id: 'backdrop-blur', re: / ?\bbackdrop-blur(?:-[a-z0-9]+)?\b/g, to: '' },
  { id: 'glow', re: / ?\b(?:hover:)?shadow-glow-[a-z-]+\b/g, to: '' },
  { id: 'card-shadow', re: / ?\b(?:hover:|dark:|dark:hover:)?shadow-card(?:-hover)?(?:-dark)?\b/g, to: '' },
  { id: 'hover-lift', re: / ?\bhover:-translate-y-0\.5\b/g, to: '' },
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(f)) out.push(f);
  }
  return out;
}

const files = [];
for (const p of DASHBOARD_SCOPE) {
  const full = join(ROOT, p);
  if (p.endsWith('/')) files.push(...walk(full));
  else files.push(full);
}

const totals = Object.fromEntries(RULES.map((r) => [r.id, 0]));
for (const file of new Set(files)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let changed = false;
  const next = lines.map((line) => {
    let out = line;
    for (const r of RULES) {
      if (r.skip && r.skip.test(out)) continue;
      const n = (out.match(r.re) ?? []).length;
      if (!n) continue;
      totals[r.id] += n;
      out = out.replace(r.re, r.to);
      changed = true;
    }
    return out;
  });
  if (changed && write) writeFileSync(file, next.join('\n'));
  if (changed) console.log(`${write ? 'updated' : 'would update'} ${relative(ROOT, file)}`);
}
console.log(totals);
