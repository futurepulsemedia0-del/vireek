// scripts/blog/pipeline.mjs
//
// Single source of truth for blog content. Used by the Vite plugin (app), `npm run blog:validate`
// (CI), the sitemap/feed/OG scripts and the tests — so every consumer sees the same validated data.
//
//   loadBlog({ root, knownPaths?, now? }) -> { posts, categories, authors, errors, warnings }
//
// `errors` fail the build / CI. `warnings` are editorial reminders.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { CTA_TYPES, blocksToText, countWords, inlineToText, parseInline, parseMarkdown, readTimeMinutes } from './markdown.mjs';

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RESERVED_SLUGS = ['category', 'tag', 'page', 'feed', 'rss', 'atom', 'search', 'newsletter'];
export const MIN_INTERNAL_POST_LINKS = 3;
const PRODUCT_PATH = /^\/(pricing|platform|calculator|demo|roi|features(\/|$)|integrations(\/|$))/;

const validDate = (s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const isoDate = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').refine(validDate, 'not a real calendar date'),
);
const slug = z.string().regex(SLUG_RE, 'lowercase letters, digits and hyphens only').max(80);
const siteRelativeOrHttps = z.string().regex(/^(\/(?!\/)|https:\/\/)/, 'must start with / or https://');

export const frontmatterSchema = z
  .object({
    title: z.string().min(10).max(60, 'title must be ≤ 60 characters (SERP truncation)'),
    slug,
    description: z.string().min(140, 'description must be 140–160 characters').max(160, 'description must be 140–160 characters'),
    category: z.string().min(1),
    tags: z.array(slug).min(1).max(8),
    author: z.string().min(1),
    publishedAt: isoDate,
    updatedAt: isoDate,
    cover: z
      .object({ src: siteRelativeOrHttps, alt: z.string().min(5), width: z.number().int().positive(), height: z.number().int().positive() })
      .strict()
      .optional(),
    featured: z.boolean().default(false),
    pillar: z.boolean().default(false),
    popularRank: z.number().int().positive().optional(),
    draft: z.boolean().default(false),
    legalReview: z.boolean().default(false),
    faq: z.array(z.object({ q: z.string().min(10), a: z.string().min(20) }).strict()).max(8).default([]),
    relatedSlugs: z.array(slug).max(6).default([]),
    cta: z
      .object({ type: z.enum(CTA_TYPES), heading: z.string().max(90).optional(), body: z.string().max(220).optional() })
      .strict()
      .default({ type: 'trial' }),
    reviewedBy: z.object({ name: z.string().min(2), role: z.string().min(2), date: isoDate }).strict().optional(),
    sources: z.array(z.object({ title: z.string().min(3), url: z.string().url() }).strict()).default([]),
  })
  .strict()
  .refine((f) => f.updatedAt >= f.publishedAt, { message: 'updatedAt must not be earlier than publishedAt', path: ['updatedAt'] });

const categorySchema = z.object({
  slug,
  name: z.string().min(2),
  icon: z.string().min(2),
  title: z.string().min(5),
  intro: z.string().min(60).max(400),
});
const authorSchema = z.object({
  name: z.string().min(2),
  type: z.enum(['person', 'organization']),
  role: z.string().min(2),
  bio: z.string().min(20),
  credentials: z.array(z.string()).default([]),
  url: z.string().default(''),
});

const fmt = (issues) => issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);

function splitFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return null;
  return { yaml: text.slice(4, end), body: text.slice(end + 5) };
}

function readJson(file, schema, errors, isMap) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (isMap) {
      const out = {};
      for (const [k, v] of Object.entries(data)) {
        const r = authorSchema.safeParse(v);
        if (r.success) out[k] = r.data;
        else fmt(r.error.issues).forEach((m) => errors.push(`${path.basename(file)} → ${k}: ${m}`));
      }
      return out;
    }
    const r = z.array(schema).safeParse(data);
    if (r.success) return r.data;
    fmt(r.error.issues).forEach((m) => errors.push(`${path.basename(file)}: ${m}`));
  } catch (e) {
    errors.push(`${path.basename(file)}: cannot read (${e.message})`);
  }
  return isMap ? {} : [];
}

export function loadBlog({ root = process.cwd(), knownPaths, now = new Date() } = {}) {
  const dir = path.join(root, 'content', 'blog');
  const errors = [];
  const warnings = [];
  if (!existsSync(dir)) return { posts: [], categories: [], authors: {}, errors: [`missing directory ${dir}`], warnings };

  const categories = readJson(path.join(dir, '_categories.json'), categorySchema, errors, false);
  const authors = readJson(path.join(dir, '_authors.json'), authorSchema, errors, true);
  const catSlugs = new Set(categories.map((c) => c.slug));
  const today = now.toISOString().slice(0, 10);

  const parsed = [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_') && f.toLowerCase() !== 'readme.md').sort();
  for (const file of files) {
    const rel = `content/blog/${file}`;
    const err = (m) => errors.push(`${rel}: ${m}`);
    const warn = (m) => warnings.push(`${rel}: ${m}`);
    const split = splitFrontmatter(readFileSync(path.join(dir, file), 'utf8'));
    if (!split) {
      err('missing or unterminated frontmatter (--- … ---)');
      continue;
    }
    let raw;
    try {
      raw = parseYaml(split.yaml);
    } catch (e) {
      err(`invalid YAML frontmatter: ${String(e.message).split('\n')[0]}`);
      continue;
    }
    const fm = frontmatterSchema.safeParse(raw ?? {});
    if (!fm.success) {
      fmt(fm.error.issues).forEach(err);
      continue;
    }
    const f = fm.data;
    if (path.basename(file, '.md') !== f.slug) err(`file name must match slug "${f.slug}"`);
    if (RESERVED_SLUGS.includes(f.slug)) err(`slug "${f.slug}" is reserved`);
    if (!catSlugs.has(f.category)) err(`unknown category "${f.category}" (see _categories.json)`);
    if (!authors[f.author]) err(`unknown author "${f.author}" (see _authors.json)`);
    else if (/^TODO/i.test(authors[f.author].name)) warn(`author "${f.author}" is still a placeholder — fill _authors.json before publishing`);

    const md = parseMarkdown(split.body);
    md.errors.forEach(err);
    if (!md.blocks.length) err('article body is empty');

    const faq = f.faq.map((x) => {
      const ctx = { errors: [], links: [] };
      const a = parseInline(x.a, ctx);
      ctx.errors.forEach((m) => err(`faq: ${m}`));
      md.links.push(...ctx.links);
      return { q: x.q, a, aText: inlineToText(a) };
    });

    const words = countWords(blocksToText(md.blocks)) + countWords(faq.map((x) => `${x.q} ${x.aText}`).join(' '));
    const headings = md.toc.filter((t) => t.level === 2).map((t) => t.text);
    const ctaBody = f.cta.body ? parseInline(f.cta.body, { errors: [], links: [] }) : [];

    parsed.push({
      file: rel,
      links: md.links,
      post: {
        slug: f.slug,
        title: f.title,
        description: f.description,
        category: f.category,
        tags: f.tags,
        author: f.author,
        publishedAt: f.publishedAt,
        updatedAt: f.updatedAt,
        cover: f.cover ?? null,
        featured: f.featured,
        pillar: f.pillar,
        popularRank: f.popularRank ?? null,
        draft: f.draft,
        legalReview: f.legalReview,
        relatedSlugs: f.relatedSlugs,
        cta: { type: f.cta.type, heading: f.cta.heading ?? '', body: ctaBody },
        reviewedBy: f.reviewedBy ?? null,
        sources: f.sources,
        faq,
        wordCount: words,
        readTimeMinutes: readTimeMinutes(words),
        toc: md.toc,
        body: md.blocks,
        searchText: [f.title, f.description, f.tags.join(' '), headings.join(' ')].join(' ').toLowerCase(),
      },
      warn,
      err,
    });
  }

  // ---- cross-post checks ----
  const bySlug = new Map();
  for (const p of parsed) {
    if (bySlug.has(p.post.slug)) p.err(`duplicate slug "${p.post.slug}" (also in ${bySlug.get(p.post.slug).file})`);
    else bySlug.set(p.post.slug, p);
  }
  const sourcesRequired = (post) => post.legalReview || post.category === 'compliance';
  for (const { post, links, file, err, warn } of parsed) {
    for (const r of post.relatedSlugs) {
      if (r === post.slug) err('relatedSlugs contains itself');
      else if (!bySlug.has(r)) err(`relatedSlugs → unknown post "${r}"`);
    }
    if (post.cover && post.cover.src.startsWith('/') && !existsSync(path.join(root, 'public', post.cover.src))) {
      err(`cover image not found: public${post.cover.src}`);
    }
    for (const b of post.body) {
      if (b.t === 'figure' && b.src.startsWith('/') && !existsSync(path.join(root, 'public', b.src))) err(`figure image not found: public${b.src}`);
    }

    const ctaPath = { demo: '/demo', pricing: '/pricing', calculator: '/calculator' }[post.cta.type];
    const hasBodyCta = post.body.some((b) => b.t === 'cta');
    const allLinks = [...links, ...(ctaPath ? [ctaPath] : [])];
    const postTargets = new Set();
    let productLinks = 0;
    for (const href of allLinks) {
      if (!href.startsWith('/')) continue;
      const p = href.split('#')[0].split('?')[0].replace(/\/$/, '') || '/';
      const blogMatch = p.match(/^\/blog\/([^/]+)$/);
      const catMatch = p.match(/^\/blog\/category\/([^/]+)$/);
      if (catMatch) {
        if (!catSlugs.has(catMatch[1])) err(`broken internal link: ${href}`);
      } else if (blogMatch) {
        if (!bySlug.has(blogMatch[1])) err(`broken internal link: ${href}`);
        else if (blogMatch[1] !== post.slug) postTargets.add(blogMatch[1]);
      } else if (knownPaths && !knownPaths.has(p)) {
        err(`broken internal link: ${href}`);
      }
      if (PRODUCT_PATH.test(p)) productLinks++;
    }
    if (postTargets.size < MIN_INTERNAL_POST_LINKS) err(`needs links to at least ${MIN_INTERNAL_POST_LINKS} other blog posts in the body (found ${postTargets.size})`);
    if (productLinks < 1) err('needs at least one link to a product/pricing page (/pricing, /features/*, /platform, /calculator, /demo, /integrations/*)');

    if (!post.faq.length) warn('no FAQ — add 3–5 questions for rich results');
    else if (post.faq.length < 3) warn(`only ${post.faq.length} FAQ question(s); aim for 3–5`);
    if (!post.sources.length) warn(sourcesRequired(post) ? 'compliance/legal article without sources' : 'no sources listed (add them wherever you cite numbers)');
    if (post.legalReview && !post.reviewedBy) warn('legalReview: true but no reviewedBy — needs a qualified reviewer before publishing');
    if (!hasBodyCta && !ctaPath) warn('no inline :::cta block');
    if (post.wordCount < 1500) warn(`${post.wordCount} words (target 1,500–2,500 for new articles)`);
    if (post.publishedAt > today && !post.draft) warn(`scheduled for ${post.publishedAt}; hidden until then (needs a daily rebuild)`);
    void file;
  }

  const visible = parsed
    .map((p) => p.post)
    .filter((p) => !p.draft && p.publishedAt <= today)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.slug.localeCompare(b.slug));
  const featured = visible.filter((p) => p.featured);
  if (featured.length > 1) warnings.push(`content/blog: ${featured.length} posts are featured; only the newest is shown as the hero`);

  return { posts: visible, categories, authors, errors, warnings };
}

export const postMeta = ({ body, toc, faq, ...meta }) => ({ ...meta, faqCount: faq.length, tocCount: toc.length });
