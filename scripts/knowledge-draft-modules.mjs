#!/usr/bin/env node
// scripts/knowledge-draft-modules.mjs
//
// Closes the biggest coverage gap: the ~420 /dashboard/* pages that have a name but no
// description in the knowledge base. For every dashboard route this script finds the page
// component, extracts the REAL on-screen text (headings, descriptions, labels) with the
// TypeScript parser, and writes a draft to knowledge/_drafts/<slug>.md.
//
// Drafts are NEVER ingested (folders starting with "_" are skipped by knowledge:build).
// Workflow:  npm run knowledge:drafts  ->  open a draft  ->  rewrite it as 3-6 factual sentences
//            ->  fix the front-matter  ->  move it to knowledge/modules/  ->  npm run knowledge:build
//
// Only text that literally appears in the page is copied; nothing is invented.
//   --only=<substring>   limit to routes containing the substring
//   --limit=<n>          limit the number of drafts (default: all)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractJsxText, slugify } from './lib/knowledgeChunker.mjs';

const ROOT = process.env.VIREEK_ROOT ? path.resolve(process.env.VIREEK_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const only = arg('only');
const limit = Number(arg('limit') ?? Infinity);

let ts;
try { ts = (await import('typescript')).default; } catch { throw new Error('typescript is required (repo devDependency): run npm ci.'); }

const app = readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');

// component name -> page file (lazy imports: const X = lazy(() => import('@/pages/Y')))
const files = new Map();
for (const m of app.matchAll(/const\s+([A-Z][A-Za-z0-9]*)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*['"]@\/([^'"]+)['"]/g)) files.set(m[1], `src/${m[2]}`);
// eager imports: import { X } from '@/pages/Y' / import X from '@/pages/Y'
for (const m of app.matchAll(/import\s+(?:\{([^}]+)\}|([A-Z][A-Za-z0-9]*))\s+from\s+['"]@\/(pages\/[^'"]+)['"]/g)) {
  const names = (m[1] ? m[1].split(',') : [m[2]]).map((s) => s.trim().split(/\s+as\s+/).pop());
  for (const n of names) if (n) files.set(n, `src/${m[3]}`);
}

const WRAPPERS = /(Route|Gate|Boundary|Suspense|Layout|Guard|Provider)$/;
const routes = [];
for (const m of app.matchAll(/path="(\/dashboard[^"]*)"/g)) {
  if (m[1].includes(':') || m[1].includes('*')) continue;
  const window = app.slice(m.index, m.index + 400);
  const el = window.indexOf('element=');
  if (el < 0) continue;
  const comp = [...window.slice(el).matchAll(/<([A-Z][A-Za-z0-9]*)/g)].map((x) => x[1]).find((n) => !WRAPPERS.test(n));
  if (comp) routes.push({ route: m[1], comp });
}

const resolveFile = (rel) => {
  for (const c of [rel, `${rel}.tsx`, `${rel}.ts`, `${rel}/index.tsx`]) if (existsSync(path.join(ROOT, c))) return c;
  return null;
};

const outDir = path.join(ROOT, 'knowledge/_drafts');
mkdirSync(outDir, { recursive: true });
const seen = new Set();
const index = [];
let written = 0;

for (const { route, comp } of routes) {
  if (only && !route.includes(only)) continue;
  if (seen.has(route)) continue;
  seen.add(route);
  if (written >= limit) break;

  const rel = files.get(comp) && resolveFile(files.get(comp));
  if (!rel) { index.push(`- ${route} — component ${comp}: file not found`); continue; }
  let text = '';
  try { text = extractJsxText(readFileSync(path.join(ROOT, rel), 'utf8'), ts, rel); } catch (e) { index.push(`- ${route} — ${rel}: parse failed (${e.message})`); continue; }
  if (text.length < 150) { index.push(`- ${route} — ${rel}: only ${text.length} chars of UI text (write this one by hand)`); continue; }

  const slug = slugify(route.replace('/dashboard/', '') || 'dashboard');
  writeFileSync(
    path.join(outDir, `${slug}.md`),
    `---
title: ${comp.replace(/Page$/, '').replace(/([a-z])([A-Z])/g, '$1 $2')}
url: ${route}
topic: module
plans: 
status: live
verified: REPLACE-WITH-YYYY-MM-DD-AFTER-YOU-CHECK
---
<!-- DRAFT. Source: ${rel}. Rewrite as 3-6 factual sentences: what it does, who uses it, which plans, limits.
     Delete this comment and the raw text below. Fix "plans" and "verified", then move to knowledge/modules/. -->

RAW UI TEXT (copied from the page; may include button labels and empty-state messages):

${text.slice(0, 3000)}
`,
  );
  written++;
}

writeFileSync(path.join(outDir, 'INDEX.md'), `# Draft index (generated)\n\nDrafts written: ${written} of ${routes.length} dashboard routes.\n\nNeeds manual writing:\n${index.join('\n') || '- none'}\n`);
console.log(`Dashboard routes found: ${routes.length} | drafts written: ${written} | need manual: ${index.length}`);
