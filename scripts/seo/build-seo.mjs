#!/usr/bin/env node
// Runs right after `vite build`. Generates sitemap.xml, sitemap-locations.xml (only when location
// data exists), robots.txt and routes.json in dist/, and keeps a pristine SPA shell at dist/_spa.html.
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ROOT, SITE_URL, canonicalFor, collectRoutes, robotsDisallowRules } from './routes.mjs';

const DIST = path.join(ROOT, 'dist');
const fail = (msg) => {
  console.error(`[seo] ${msg}`);
  process.exit(1);
};

const xml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function urlset(entries) {
  const body = entries
    .map(
      (e) =>
        `  <url>\n    <loc>${xml(canonicalFor(e.path))}</loc>${e.lastmod ? `\n    <lastmod>${e.lastmod}</lastmod>` : ''}\n  </url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function robotsTxt(hasLocations) {
  return [
    '# Generated at build time by scripts/seo/build-seo.mjs — do not edit by hand.',
    'User-agent: *',
    'Allow: /',
    '',
    '# Private, authenticated and token-based areas (SPA-only, never prerendered).',
    ...robotsDisallowRules().map((r) => `Disallow: ${r}`),
    '',
    '# Never disallow /assets/ — crawlers need the JS/CSS bundles to render the app.',
    '',
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    ...(hasLocations ? [`Sitemap: ${SITE_URL}/sitemap-locations.xml`] : []),
    '',
  ].join('\n');
}

const indexHtml = path.join(DIST, 'index.html');
if (!existsSync(indexHtml)) fail('dist/index.html not found — run `vite build` first.');

// Pristine SPA shell: served (via the vercel.json rewrite) for every route that is not prerendered.
const spaShell = path.join(DIST, '_spa.html');
if (!existsSync(spaShell)) copyFileSync(indexHtml, spaShell);

const routes = await collectRoutes();
const main = routes.filter((r) => r.kind !== 'location');
const locations = routes.filter((r) => r.kind === 'location');
if (main.length > 50000 || locations.length > 50000) fail('sitemap exceeds the 50,000 URL limit — split it.');

writeFileSync(path.join(DIST, 'sitemap.xml'), urlset(main));
if (locations.length > 0) {
  writeFileSync(path.join(DIST, 'sitemap-locations.xml'), urlset(locations));
} else {
  console.log('[seo] no locations data (src/lib/locations.ts) — sitemap-locations.xml not generated.');
}
writeFileSync(path.join(DIST, 'robots.txt'), robotsTxt(locations.length > 0));
writeFileSync(
  path.join(DIST, 'routes.json'),
  JSON.stringify({ siteUrl: SITE_URL, generatedAt: new Date().toISOString(), routes }, null, 2),
);
console.log(`[seo] sitemap.xml (${main.length} URLs)${locations.length ? `, sitemap-locations.xml (${locations.length})` : ''}, robots.txt written.`);
