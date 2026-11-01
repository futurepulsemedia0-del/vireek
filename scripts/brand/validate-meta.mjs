#!/usr/bin/env node
// CI gate: every indexable page in dist/ must ship og:image, og:title, og:description, twitter:card and a correct
// canonical, and its og:image must be a real 1200x630 PNG in dist/. Exits 1 otherwise.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { ROOT, SITE_URL, canonicalFor } from '../seo/routes.mjs';
import { extractHead } from '../seo/html-meta.mjs';

export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Pure: returns a list of problems for one page. `readOg(url)` returns a Buffer or null. */
export function checkPage({ routePath, head, readOg, siteUrl = SITE_URL }) {
  const problems = [];
  const expected = canonicalFor(routePath);
  if (!head.ogTitle?.trim()) problems.push('missing og:title');
  if (!head.ogDescription?.trim()) problems.push('missing og:description');
  if (head.twitterCard !== 'summary_large_image') problems.push(`twitter:card is ${head.twitterCard ?? 'missing'}`);
  if (head.canonicals.length !== 1) problems.push(`${head.canonicals.length} canonical links (need exactly 1)`);
  else if (head.canonicals[0] !== expected) problems.push(`canonical ${head.canonicals[0]} != ${expected}`);
  if (head.ogUrl && head.ogUrl !== expected) problems.push(`og:url ${head.ogUrl} != ${expected}`);
  if (!head.ogImage) problems.push('missing og:image');
  else if (!head.ogImage.startsWith(`${siteUrl}/`)) problems.push(`og:image is not an absolute ${siteUrl} URL: ${head.ogImage}`);
  else {
    const buf = readOg(head.ogImage);
    const size = buf && pngSize(buf);
    if (!buf) problems.push(`og:image file not in dist: ${head.ogImage}`);
    else if (!size) problems.push(`og:image is not a PNG: ${head.ogImage}`);
    else if (size.w !== 1200 || size.h !== 630) problems.push(`og:image is ${size.w}x${size.h}, need 1200x630 (run npm run brand:assets for the default card)`);
  }
  return problems;
}

function main() {
  const DIST = path.join(ROOT, 'dist');
  const routesPath = path.join(DIST, 'routes.json');
  if (!existsSync(routesPath)) {
    console.error('[meta] dist/routes.json missing - run the full build first.');
    process.exit(1);
  }
  if (!existsSync(path.join(DIST, '_prerender-report.json'))) {
    console.error('[meta] dist/_prerender-report.json missing - pages were not prerendered, so per-page tags cannot be verified.');
    process.exit(1);
  }
  const { routes } = JSON.parse(readFileSync(routesPath, 'utf8'));
  const readOg = (url) => {
    const f = path.join(DIST, new URL(url).pathname);
    return f.startsWith(DIST + path.sep) && existsSync(f) ? readFileSync(f) : null;
  };
  const homeTitle = extractHead(readFileSync(path.join(DIST, 'index.html'), 'utf8')).ogTitle;
  let bad = 0;
  const dupes = [];
  for (const r of routes) {
    const file = r.path === '/' ? path.join(DIST, 'index.html') : path.join(DIST, r.path.slice(1), 'index.html');
    if (!existsSync(file)) {
      console.error(`[meta] FAIL ${r.path}: prerendered file missing`);
      bad++;
      continue;
    }
    const head = extractHead(readFileSync(file, 'utf8'));
    const problems = checkPage({ routePath: r.path, head, readOg });
    if (problems.length) {
      bad++;
      console.error(`[meta] FAIL ${r.path}\n  - ${problems.join('\n  - ')}`);
    }
    if (r.path !== '/' && head.ogTitle === homeTitle) dupes.push(r.path);
  }
  if (dupes.length) console.warn(`[meta] WARN ${dupes.length} page(s) reuse the homepage og:title (no useSEO of their own): ${dupes.slice(0, 15).join(', ')}${dupes.length > 15 ? ' ...' : ''}`);
  if (bad) {
    console.error(`[meta] ${bad}/${routes.length} indexable pages failed.`);
    process.exit(1);
  }
  console.log(`[meta] OK - ${routes.length} indexable pages have og:title, og:description, og:image (1200x630), twitter:card and a correct canonical.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
