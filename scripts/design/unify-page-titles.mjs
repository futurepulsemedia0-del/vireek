#!/usr/bin/env node
// scripts/design/unify-page-titles.mjs
//
// Gives every dashboard page title ONE type style: the `text-page-title` token
// (defined in tailwind.config.js). Before this, <h1> in the dashboard used many
// combinations of text-lg..3xl, font-semibold/bold/extrabold and tracking-*.
//
//   node scripts/design/unify-page-titles.mjs            # dry run + report
//   node scripts/design/unify-page-titles.mjs --write    # apply
//
// Scope (kept narrow on purpose):
//  - only page modules that are routed under /dashboard in src/App.tsx
//  - only <h1 className="..."> with a plain string literal (no template/expr)
//  - h1 that use text-4xl or larger are treated as hero headings: left alone, reported
//  - only size / weight / tracking tokens are replaced; colour, margin, truncate,
//    flex etc. are preserved in their original order.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const WRITE = process.argv.includes('--write');
const TOKEN = 'text-page-title';

const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
const lazy = new Map([...app.matchAll(/const\s+(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*['"]@\/pages\/([^'"]+)['"]/g)].map((m) => [m[1], m[2]]));
const modules = new Set();
for (const m of app.matchAll(/<Route\s+path="([^"]+)"\s+element=\{([\s\S]*?)\}\s*\/>/g)) {
  if (!/^\/?dashboard/.test(m[1])) continue;
  for (const c of m[2].matchAll(/<([A-Z]\w+)/g)) if (lazy.has(c[1])) modules.add(lazy.get(c[1]));
}

const STRIP = /^(?:(?:sm|md|lg|xl):)?(?:text-(?:xs|sm|base|lg|xl|2xl|3xl)|font-(?:normal|medium|semibold|bold|extrabold|black)|tracking-(?:tighter|tight|normal|tightest))$/;
const HERO = /(?:^|\s)(?:(?:sm|md|lg|xl):)?text-(?:4xl|5xl|6xl|7xl|8xl|9xl|display-\w+)(?:\s|$)/;

let changed = 0;
let already = 0;
const skippedHero = [];
const skippedDynamic = [];
const touched = [];

for (const mod of [...modules].sort()) {
  const file = join(ROOT, 'src/pages', `${mod}.tsx`);
  if (!existsSync(file)) continue;
  const src = readFileSync(file, 'utf8');
  let fileChanged = false;
  const out = src.replace(/<h1\b([^>]*)>/g, (full, attrs) => {
    const m = attrs.match(/\bclassName="([^"]*)"/);
    if (!m) { if (/className=/.test(attrs)) skippedDynamic.push(mod); return full; }
    const cls = m[1];
    if (HERO.test(` ${cls} `)) { skippedHero.push(mod); return full; }
    const tokens = cls.split(/\s+/).filter(Boolean);
    if (tokens.includes(TOKEN) && !tokens.some((t) => STRIP.test(t))) { already++; return full; }
    const kept = tokens.filter((t) => !STRIP.test(t) && t !== TOKEN);
    const next = [TOKEN, ...kept].join(' ');
    if (next === cls) return full;
    fileChanged = true;
    changed++;
    return full.replace(`className="${cls}"`, `className="${next}"`);
  });
  if (fileChanged) { touched.push(mod); if (WRITE) writeFileSync(file, out); }
}

console.log(`${WRITE ? 'APPLIED' : 'DRY RUN'}: ${changed} <h1> in ${touched.length} files (dashboard modules scanned: ${modules.size})`);
console.log(`already on token: ${already} | hero (text-4xl+) left alone: ${new Set(skippedHero).size} | dynamic className left alone: ${new Set(skippedDynamic).size}`);
if (skippedHero.length) console.log('hero files:', [...new Set(skippedHero)].join(', '));
if (skippedDynamic.length) console.log('dynamic files:', [...new Set(skippedDynamic)].join(', '));
