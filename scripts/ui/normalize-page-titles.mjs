#!/usr/bin/env node
/**
 * Normalizes dashboard page titles (<h1>) to ONE canonical type style.
 *
 *   node scripts/ui/normalize-page-titles.mjs          # dry run, prints what would change
 *   node scripts/ui/normalize-page-titles.mjs --write  # apply
 *   node scripts/ui/normalize-page-titles.mjs --check  # exit 1 if any page deviates (use in CI)
 *
 * Only exact, known variants of the "text-2xl" page-title family are rewritten. Hero headings (text-4xl+),
 * dialog/section titles (text-lg / text-xl) and anything with extra classes are left alone on purpose.
 * Layout classes in front of the type classes (flex items-center gap-2) are preserved.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CANONICAL = 'text-2xl font-bold tracking-tight text-text-primary';
const TYPE_VARIANTS = [
  'text-2xl font-bold text-text-primary',
  'text-2xl font-bold tracking-tight text-text-primary md:text-3xl',
  'text-2xl font-semibold text-text-primary',
  'text-2xl font-semibold tracking-tight text-text-primary',
  'text-2xl font-bold text-text-primary sm:text-3xl',
];
const PREFIXES = ['', 'flex items-center gap-2 ', 'flex items-center gap-3 '];

const args = new Set(process.argv.slice(2));
const root = join(process.cwd(), 'src', 'pages');
const files = readdirSync(root).filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'));

const exact = new Set();
for (const pre of PREFIXES) for (const v of TYPE_VARIANTS) exact.add(`${pre}${v}`);

let changed = 0;
let deviating = 0;
const touched = [];
for (const f of files) {
  const path = join(root, f);
  const src = readFileSync(path, 'utf8');
  let n = 0;
  const out = src.replace(/<h1 className="([^"]*)"/g, (m, cls) => {
    if (!exact.has(cls)) return m;
    const pre = PREFIXES.find((p) => p && cls.startsWith(p)) ?? '';
    const next = `${pre}${CANONICAL}`;
    if (next === cls) return m;
    n += 1;
    return `<h1 className="${next}"`;
  });
  if (n) {
    changed += n;
    deviating += 1;
    touched.push(`${f} (${n})`);
    if (args.has('--write')) writeFileSync(path, out);
  }
}
console.log(`${changed} title(s) in ${deviating} page(s) ${args.has('--write') ? 'rewritten' : 'would change'}`);
if (!args.has('--write')) touched.slice(0, 15).forEach((t) => console.log('  ' + t));
if (args.has('--check') && changed) process.exit(1);
