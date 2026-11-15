#!/usr/bin/env node
// scripts/design/sync-page-titles.mjs
//
// Keeps page <h1> titles in sync with the nav renames in
// src/lib/surface/surface.manifest.json ("renames": old -> new).
//
//   node scripts/design/sync-page-titles.mjs          # dry run: print what would change
//   node scripts/design/sync-page-titles.mjs --write  # apply
//
// Scope (deliberately narrow, so it is safe to run):
//  - only src/pages/**/*.tsx (not tests)
//  - only a literal JSX heading whose entire text is the OLD label:
//      <h1 className="...">Cash Flow War Room</h1>
//  - headings using t('...') or expressions are NEVER touched; they are listed
//    in the report so a human can handle them.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const PAGES = join(ROOT, 'src/pages');
const WRITE = process.argv.includes('--write');

const manifest = JSON.parse(readFileSync(join(ROOT, 'src/lib/surface/surface.manifest.json'), 'utf8'));
const renames = manifest.renames.filter((r) => r.old && r.new && r.old !== r.new);

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (e.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(e)) yield full;
  }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const files = [...walk(PAGES)];
const changes = [];
const manual = [];

for (const file of files) {
  let src = readFileSync(file, 'utf8');
  let next = src;
  for (const r of renames) {
    const literal = new RegExp(`(<h1\\b[^>]*>)(\\s*)${esc(r.old)}(\\s*)(</h1>)`, 'g');
    next = next.replace(literal, (_m, open, a, b, close) => {
      changes.push({ file: relative(ROOT, file), from: r.old, to: r.new });
      return `${open}${a}${r.new}${b}${close}`;
    });
    // Old name still present in some other string form inside an <h1>: report only.
    const loose = new RegExp(`<h1\\b[^>]*>[^<]*${esc(r.old)}`, 'g');
    if (loose.test(src) && !literal.test(src)) manual.push({ file: relative(ROOT, file), name: r.old });
  }
  if (WRITE && next !== src) writeFileSync(file, next);
}

console.log(`${WRITE ? 'APPLIED' : 'DRY RUN'}: ${changes.length} heading(s) in ${new Set(changes.map((c) => c.file)).size} file(s)`);
for (const c of changes) console.log(`  ${c.file}: "${c.from}" -> "${c.to}"`);
if (manual.length) {
  console.log(`\nNeeds manual review (old name inside an <h1> but not a plain literal): ${manual.length}`);
  for (const m of manual) console.log(`  ${m.file}: ${m.name}`);
}
