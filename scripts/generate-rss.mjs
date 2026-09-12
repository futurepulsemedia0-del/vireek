#!/usr/bin/env node
// scripts/generate-rss.mjs
//
// Generates static RSS 2.0 feeds for the Blog and Changelog straight from
// the same TypeScript data files the site itself renders from
// (src/lib/blog.ts and src/lib/changelog.ts) — one source of truth, no
// duplicated content to keep in sync.
//
// Run manually whenever you publish a new post or ship a release:
//   node scripts/generate-rss.mjs
//
// Requires esbuild as a dev dependency:
//   npm install --save-dev esbuild

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE_URL = 'https://vireek.com';

/**
 * Transpiles a TS data module with esbuild and imports the result via a
 * data: URL, so this script reads the exact same data the site renders
 * from without needing a full app build or a TS runtime. UI-only imports
 * (icons, React, routing) are stubbed out since we only need the data.
 */
async function loadTsModule(relativePath) {
  const absPath = path.join(ROOT, relativePath);
  const result = await esbuild.build({
    entryPoints: [absPath],
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'node',
    plugins: [
      {
        name: 'stub-ui-only-deps',
        setup(build) {
          build.onResolve(
            { filter: /^(lucide-react|react|react-dom|framer-motion|react-router-dom)$/ },
            () => ({ path: 'stub', namespace: 'stub-ns' })
          );
          build.onLoad({ filter: /.*/, namespace: 'stub-ns' }, () => ({
            contents: 'export default new Proxy({}, { get: () => (() => null) });',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const code = result.outputFiles[0].text;
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  return import(dataUrl);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildRss({ title, description, link, feedPath, items }) {
  const now = new Date().toUTCString();
  const itemsXml = items
    .map(
      (item) => `
    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="true">${escapeXml(item.link)}</guid>
      <pubDate>${new Date(item.date).toUTCString()}</pubDate>
      <description>${escapeXml(item.description)}</description>
    </item>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(link)}</link>
    <description>${escapeXml(description)}</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="${SITE_URL}${feedPath}" rel="self" type="application/rss+xml" />${itemsXml}
  </channel>
</rss>
`;
}

async function main() {
  const { BLOG_POSTS } = await loadTsModule('src/lib/blog.ts');
  const { CHANGELOG_RELEASES } = await loadTsModule('src/lib/changelog.ts');

  const blogItems = [...BLOG_POSTS]
    .sort((a, b) => new Date(b.publishedDate) - new Date(a.publishedDate))
    .map((post) => ({
      title: post.title,
      link: `${SITE_URL}/blog/${post.slug}`,
      date: post.publishedDate,
      description: post.excerpt,
    }));

  const changelogItems = CHANGELOG_RELEASES.map((release) => ({
    title: `Update — ${release.date}`,
    link: `${SITE_URL}/changelog`,
    date: release.date,
    description: release.entries.map((e) => `${e.title}: ${e.body}`).join(' | '),
  }));

  writeFileSync(
    path.join(ROOT, 'public/blog-rss.xml'),
    buildRss({
      title: 'Vireek Blog',
      description:
        'Practical guides on missed-call revenue loss, AI receptionists, and running a home service business.',
      link: `${SITE_URL}/blog`,
      feedPath: '/blog-rss.xml',
      items: blogItems,
    })
  );

  writeFileSync(
    path.join(ROOT, 'public/changelog-rss.xml'),
    buildRss({
      title: 'Vireek Changelog',
      description: 'Every feature, improvement, and fix shipped to the Vireek platform.',
      link: `${SITE_URL}/changelog`,
      feedPath: '/changelog-rss.xml',
      items: changelogItems,
    })
  );

  console.log(`Generated public/blog-rss.xml (${blogItems.length} posts)`);
  console.log(`Generated public/changelog-rss.xml (${changelogItems.length} releases)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
