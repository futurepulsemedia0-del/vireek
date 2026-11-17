#!/usr/bin/env node
// Final build gate (runs after prerender.mjs). Fails the build when the output is not what search engines need:
// prerender silently skipped (PRERENDER_OPTIONAL swallows errors), missing pages, malformed sitemap, or sitemap URLs
// that robots.txt blocks. Escape hatch for emergencies only: SEO_ASSERT_WARN_ONLY=1.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const count = (s, re) => (s.match(re) ?? []).length;
const locOf = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const isDisallowed = (pathname, rules) =>
  rules.some((r) => (r.endsWith('$') ? pathname === r.slice(0, -1) : pathname.startsWith(r)));

/** Pure: returns a list of problems for a dist/ directory. */
export function assertDist(dist) {
  const problems = [];
  const read = (rel) => readFileSync(path.join(dist, rel), 'utf8');
  const has = (rel) => existsSync(path.join(dist, rel));

  for (const f of ['routes.json', '_prerender-report.json', 'sitemap.xml', 'robots.txt', 'app-routes.json', '_spa.html']) {
    if (!has(f)) problems.push(`dist/${f} is missing`);
  }
  if (problems.length) {
    if (!has('_prerender-report.json')) {
      problems.push('prerender did not run or was skipped (PRERENDER_OPTIONAL=1 hides the real error — see the "[prerender] WARNING" line above)');
    }
    return problems;
  }

  const { routes } = JSON.parse(read('routes.json'));
  const report = JSON.parse(read('_prerender-report.json'));
  if (report.failures?.length) {
    problems.push(`${report.failures.length} route(s) failed to prerender: ${report.failures.slice(0, 5).map((f) => f.path).join(', ')}`);
  }
  if (report.pages.length < routes.length) problems.push(`only ${report.pages.length}/${routes.length} routes were prerendered`);
  for (const r of routes) {
    const rel = r.path === '/' ? 'index.html' : `${r.path.slice(1)}/index.html`;
    if (!has(rel)) problems.push(`prerendered file missing: ${rel}`);
  }

  const sitemap = read('sitemap.xml');
  const locs = locOf(sitemap);
  if (!sitemap.startsWith('<?xml')) problems.push('sitemap.xml does not start with an XML declaration');
  if (count(sitemap, /<url>/g) !== count(sitemap, /<\/url>/g) || count(sitemap, /<url>/g) !== locs.length) {
    problems.push('sitemap.xml is malformed (unbalanced or nested <url> blocks)');
  }
  if (new Set(locs).size !== locs.length) problems.push('sitemap.xml contains duplicate URLs');

  const robots = read('robots.txt');
  const rules = [...robots.matchAll(/^Disallow:\s*(\S+)/gim)].map((m) => m[1]);
  const blocked = locs.filter((l) => isDisallowed(new URL(l).pathname, rules));
  if (blocked.length) problems.push(`robots.txt blocks ${blocked.length} sitemap URL(s), e.g. ${blocked.slice(0, 3).join(', ')}`);
  if (!/^Sitemap:\s*\S+/im.test(robots)) problems.push('robots.txt has no Sitemap line');

  try {
    const m = JSON.parse(read('app-routes.json'));
    if (!Array.isArray(m.patterns) || m.patterns.length < 10) problems.push('app-routes.json has too few route patterns');
  } catch {
    problems.push('app-routes.json is not valid JSON');
  }
  return problems;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dist = process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(root, 'dist');
  if (process.env.SKIP_PRERENDER === '1') {
    console.log('[assert-prerendered] SKIP_PRERENDER=1 - skipped.');
    return;
  }
  const problems = assertDist(dist);
  if (problems.length) {
    for (const p of problems) console.error(`[assert-prerendered] ${p}`);
    if (process.env.SEO_ASSERT_WARN_ONLY === '1') {
      console.warn('[assert-prerendered] SEO_ASSERT_WARN_ONLY=1 - continuing despite problems.');
      return;
    }
    process.exit(1);
  }
  console.log('[assert-prerendered] OK - prerender complete, sitemap well-formed, robots.txt does not block any sitemap URL.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
