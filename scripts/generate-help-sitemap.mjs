#!/usr/bin/env node
// Writes one <url> per Help Center article into public/sitemap.xml, between
//   <!-- help-articles:start --> and <!-- help-articles:end -->
// Source of truth: src/lib/helpContent.ts via src/lib/helpArticles.ts (same slugs as the site).
// Run after adding/renaming an article:   node scripts/generate-help-sitemap.mjs
// Existing <lastmod> values are preserved; new URLs get today's date (edit by hand to bump one).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_URL = 'https://vireek.com';
const SITEMAP = path.join(ROOT, 'public', 'sitemap.xml');
const START = '<!-- help-articles:start -->';
const END = '<!-- help-articles:end -->';

async function loadHelpArticles() {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/lib/helpArticles.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    alias: { '@': path.join(ROOT, 'src') },
    plugins: [
      {
        name: 'stub-ui-only-deps',
        setup(build) {
          build.onResolve({ filter: /^(lucide-react|react|react-dom|framer-motion|react-router-dom)$/ }, (args) => ({
            path: args.path,
            namespace: 'stub-ns',
          }));
          build.onLoad({ filter: /.*/, namespace: 'stub-ns' }, () => ({
            contents:
              'module.exports = new Proxy({}, { get: (_t, key) => (key === "__esModule" ? false : () => null) });',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

const { HELP_ARTICLES } = await loadHelpArticles();
let xml = readFileSync(SITEMAP, 'utf8');
const today = new Date().toISOString().slice(0, 10);

const entries = HELP_ARTICLES.map(({ slug }) => {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error(`Unsafe slug: ${slug}`);
  const loc = `${SITE_URL}/help/${slug}`;
  const prior = xml.match(new RegExp(`<loc>${loc}</loc>\\s*<lastmod>([^<]+)</lastmod>`));
  return [
    '  <url>',
    `    <loc>${loc}</loc>`,
    `    <lastmod>${prior ? prior[1] : today}</lastmod>`,
    '    <changefreq>monthly</changefreq>',
    '    <priority>0.6</priority>',
    '  </url>',
  ].join('\n');
}).join('\n');

const block = `  ${START}\n${entries}\n  ${END}`;
if (xml.includes(START) && xml.includes(END)) {
  xml = xml.replace(/[ \t]*<!-- help-articles:start -->[\s\S]*?<!-- help-articles:end -->/, () => block);
} else {
  xml = xml.replace('</urlset>', () => `${block}\n</urlset>`);
}
writeFileSync(SITEMAP, xml);
console.log(`Help sitemap: ${HELP_ARTICLES.length} article URLs written to public/sitemap.xml`);
