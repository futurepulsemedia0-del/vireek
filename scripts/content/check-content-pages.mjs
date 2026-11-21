#!/usr/bin/env node
// scripts/content/check-content-pages.mjs  (npm run content:check)
//
// Fails CI when a published content page in the BUILD OUTPUT lacks metadata, a self-referencing canonical URL or
// valid structured data. Run it after `npm run build`; it reads dist/routes.json and dist/<route>/index.html.
//
//   node scripts/content/check-content-pages.mjs [--dist <dir>] [--json] [--write-baseline]
//
// Exit codes: 0 ok · 1 problems (or stale baseline entries) · 2 build output missing.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT, canonicalFor } from '../seo/routes.mjs';
import { loadBlog } from '../blog/pipeline.mjs';
import { applyBaseline, evaluatePage, isContentRoute, requiredTypesFor } from './content-pages-lib.mjs';

const BASELINE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'content-pages-baseline.json');
const outFile = (p) => (p === '/' ? 'index.html' : `${p.slice(1)}/index.html`);

function parseArgs(argv) {
  const args = { dist: path.join(ROOT, 'dist'), json: false, writeBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dist') args.dist = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--write-baseline') args.writeBaseline = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function loadBaseline() {
  try {
    const j = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    return Array.isArray(j.tolerated) ? j.tolerated : [];
  } catch {
    return [];
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(args.dist, 'routes.json');
  if (!existsSync(manifestPath)) {
    console.error(`[content:check] ${manifestPath} not found. Run "npm run build" first.`);
    process.exit(2);
  }
  const { routes } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const posts = new Map(loadBlog({ root: ROOT }).posts.map((p) => [`/blog/${p.slug}`, p]));

  const results = routes.filter(isContentRoute).map((route) => {
    const file = path.join(args.dist, outFile(route.path));
    return evaluatePage({
      path: route.path,
      kind: route.kind,
      html: existsSync(file) ? readFileSync(file, 'utf8') : null,
      canonical: canonicalFor(route.path),
      requiredTypes: requiredTypesFor(route, posts.get(route.path)),
    });
  });

  if (args.writeBaseline) {
    const keys = results.flatMap((r) => r.problems.map((p) => `${r.path} ${p.code}`)).sort();
    const prev = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ ...prev, tolerated: keys }, null, 2)}\n`);
    console.log(`[content:check] baseline written: ${keys.length} tolerated problem(s). Review them: each is a real gap.`);
    return;
  }

  const { failing, stale, tolerated } = applyBaseline(results, loadBaseline());
  if (args.json) {
    console.log(JSON.stringify({ pages: results.length, failing, stale, tolerated }, null, 2));
  } else {
    for (const f of failing) console.error(`FAIL  ${f.path}  [${f.code}] ${f.message}`);
    for (const s of stale) console.error(`STALE baseline entry no longer needed (page now passes): ${s}`);
    console.log(`[content:check] ${results.length} content page(s), ${failing.length} problem(s), ${tolerated.length} tolerated by baseline, ${stale.length} stale baseline entr${stale.length === 1 ? 'y' : 'ies'}.`);
  }
  if (failing.length || stale.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
