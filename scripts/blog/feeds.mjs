#!/usr/bin/env node
// Generates public/blog-rss.xml (RSS 2.0) and public/blog-atom.xml (Atom 1.0) from content/blog.
// Runs from `npm run build` (before vite) and as `npm run blog:feeds`.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ROOT, SITE_URL } from '../seo/routes.mjs';
import { loadBlog } from './pipeline.mjs';

const esc = (v) =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const utc = (d) => new Date(`${d}T00:00:00Z`);

export function buildFeeds({ posts, categories, authors }) {
  const catName = (slug) => categories.find((c) => c.slug === slug)?.name ?? slug;
  const authorName = (key) => (authors[key] && !/^TODO/i.test(authors[key].name) ? authors[key].name : 'The Vireek Team');
  const newest = posts[0] ? utc(posts.reduce((m, p) => (p.updatedAt > m ? p.updatedAt : m), posts[0].updatedAt)) : new Date(0);
  const title = 'Vireek Blog';
  const description = 'Practical guides on missed-call revenue, AI receptionists, trade playbooks and compliance for home service businesses.';

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(title)}</title>
    <link>${SITE_URL}/blog</link>
    <description>${esc(description)}</description>
    <language>en-us</language>
    <lastBuildDate>${newest.toUTCString()}</lastBuildDate>
    <atom:link href="${SITE_URL}/blog-rss.xml" rel="self" type="application/rss+xml" />${posts
      .map(
        (p) => `
    <item>
      <title>${esc(p.title)}</title>
      <link>${SITE_URL}/blog/${p.slug}</link>
      <guid isPermaLink="true">${SITE_URL}/blog/${p.slug}</guid>
      <pubDate>${utc(p.publishedAt).toUTCString()}</pubDate>
      <category>${esc(catName(p.category))}</category>
      <description>${esc(p.description)}</description>
    </item>`,
      )
      .join('')}
  </channel>
</rss>
`;

  const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${esc(title)}</title>
  <subtitle>${esc(description)}</subtitle>
  <link href="${SITE_URL}/blog-atom.xml" rel="self" type="application/atom+xml" />
  <link href="${SITE_URL}/blog" rel="alternate" type="text/html" />
  <id>${SITE_URL}/blog</id>
  <updated>${newest.toISOString()}</updated>${posts
    .map(
      (p) => `
  <entry>
    <title>${esc(p.title)}</title>
    <link href="${SITE_URL}/blog/${p.slug}" rel="alternate" type="text/html" />
    <id>${SITE_URL}/blog/${p.slug}</id>
    <published>${utc(p.publishedAt).toISOString()}</published>
    <updated>${utc(p.updatedAt).toISOString()}</updated>
    <author><name>${esc(authorName(p.author))}</name></author>
    <category term="${esc(p.category)}" label="${esc(catName(p.category))}" />
    <summary>${esc(p.description)}</summary>
  </entry>`,
    )
    .join('')}
</feed>
`;
  return { rss, atom };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const blog = loadBlog({ root: ROOT });
  if (blog.errors.length) {
    console.error(`[blog-feeds] content has ${blog.errors.length} error(s); run npm run blog:validate`);
    process.exit(1);
  }
  const { rss, atom } = buildFeeds(blog);
  mkdirSync(path.join(ROOT, 'public'), { recursive: true });
  writeFileSync(path.join(ROOT, 'public/blog-rss.xml'), rss);
  writeFileSync(path.join(ROOT, 'public/blog-atom.xml'), atom);
  console.log(`[blog-feeds] public/blog-rss.xml + public/blog-atom.xml (${blog.posts.length} posts)`);
}
