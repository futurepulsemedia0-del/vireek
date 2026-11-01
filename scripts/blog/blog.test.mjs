import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseMarkdown } from './markdown.mjs';
import { loadBlog } from './pipeline.mjs';

const errs = (md) => parseMarkdown(md).errors.join(' | ');

describe('markdown dialect', () => {
  it('builds heading ids, de-duplicates them and produces a TOC', () => {
    const r = parseMarkdown('## Costs & fees\n\ntext\n\n### Setup\n\n## Costs & fees\n');
    expect(r.errors).toHaveLength(0);
    expect(r.toc.map((t) => t.id)).toEqual(['costs-and-fees', 'setup', 'costs-and-fees-2']);
    expect(r.toc.map((t) => t.level)).toEqual([2, 3, 2]);
  });
  it('rejects h1, h4+ and h3 before any h2', () => {
    expect(errs('# Title')).toContain('h1 is reserved');
    expect(errs('## A\n\n#### Deep')).toContain('only h2 and h3');
    expect(errs('### Early\n\n## Later')).toContain('before any h2');
  });
  it('parses responsive tables and flags ragged rows', () => {
    const ok = parseMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n| **3** | 4 |\n');
    expect(ok.errors).toHaveLength(0);
    expect(ok.blocks[0].t).toBe('table');
    expect(ok.blocks[0].rows).toHaveLength(2);
    expect(errs('| A | B |\n|---|---|\n| 1 |\n')).toContain('table row has 1 cells');
  });
  it('allow-lists link schemes and never emits raw HTML', () => {
    const bad = parseMarkdown('[x](javascript:alert(1)) and <img src=x onerror=alert(1)>');
    expect(bad.errors.join()).toContain('unsafe or empty link');
    expect(JSON.stringify(bad.blocks)).not.toContain('"href":"javascript');
    // raw HTML survives only as a text node, which React escapes
    expect(bad.blocks[0].c.some((n) => n.t === 'text' && n.v.includes('<img'))).toBe(true);
    expect(parseMarkdown('[a](/pricing) [b](https://example.com) [c](#faq)').errors).toHaveLength(0);
  });
  it('supports callouts, steps, takeaways, cta, calculator and figure', () => {
    const r = parseMarkdown(
      ':::tip\nAnswer fast.\n:::\n\n:::steps\n1. One\n2. Two\n:::\n\n:::takeaways\n- A\n- B\n:::\n\n' +
        ':::cta type=demo heading="See it" button="Book"\nBody **text**.\n:::\n\n:::calculator\n:::\n\n' +
        ':::figure src=/og-image.png alt="A descriptive alt" width=1200 height=630\nCaption\n:::\n',
    );
    expect(r.errors).toEqual([]);
    expect(r.blocks.map((b) => b.t)).toEqual(['callout', 'steps', 'takeaways', 'cta', 'calculator', 'figure']);
    expect(r.blocks[3].heading).toBe('See it');
  });
  it('validates directive misuse', () => {
    expect(errs(':::cta type=bogus\nx\n:::')).toContain('must be one of');
    expect(errs(':::figure src=/x.png alt="" width=1 height=1\n:::')).toContain('alt text');
    expect(errs(':::figure src=/x.png alt="Good alt text"\n:::')).toContain('width and height');
    expect(errs(':::nope\nx\n:::')).toContain('unknown directive');
    expect(errs(':::tip\nunclosed')).toContain('unclosed');
    expect(errs(':::steps\n- not numbered\n:::')).toContain('numbered list');
  });
});

describe('content pipeline', () => {
  const dirs = [];
  const D = 'Description text that is long enough to satisfy the minimum length rule for search snippets and stays under the limit. ';
  const desc = (D + D).slice(0, 150);
  const body = (links) => `## First section\n\nSome text ${links}.\n`;
  const allLinks = '[a](/blog/p-one) [b](/blog/p-two) [c](/blog/p-three) [d](/blog/p-four) [pricing](/pricing)';

  function setup(overrides = {}, extraFiles = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'blog-'));
    dirs.push(root);
    const dir = path.join(root, 'content', 'blog');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '_categories.json'), JSON.stringify([{ slug: 'ops', name: 'Ops', icon: 'Wrench', title: 'Operations', intro: 'x'.repeat(80) }]));
    writeFileSync(path.join(dir, '_authors.json'), JSON.stringify({ team: { name: 'Team', type: 'organization', role: 'Editors', bio: 'A bio that is long enough.' } }));
    for (const slug of ['p-one', 'p-two', 'p-three', 'p-four']) {
      const o = overrides[slug] ?? {};
      const fm = {
        title: `Post number ${slug}`, slug, description: desc, category: 'ops', tags: '[a]', author: 'team',
        publishedAt: '2026-01-10', updatedAt: '2026-01-11', ...o.fm,
      };
      const head = Object.entries(fm).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${typeof v === 'string' && !/^[[{]/.test(v) ? JSON.stringify(v) : v}`).join('\n');
      writeFileSync(path.join(dir, o.file ?? `${slug}.md`), `---\n${head}\n---\n\n${o.body ?? body(allLinks)}`);
    }
    for (const [name, text] of Object.entries(extraFiles)) writeFileSync(path.join(dir, name), text);
    return root;
  }
  const run = (root, opts = {}) => loadBlog({ root, now: new Date('2026-06-01T00:00:00Z'), ...opts });
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('accepts valid content and calculates read time', () => {
    const r = run(setup());
    expect(r.errors).toEqual([]);
    expect(r.posts).toHaveLength(4);
    expect(r.posts[0].readTimeMinutes).toBeGreaterThan(0);
    expect(r.posts[0].toc[0].id).toBe('first-section');
  });
  it('enforces title ≤ 60 and description 140–160', () => {
    const t = run(setup({ 'p-one': { fm: { title: 'T'.repeat(61) } } }));
    expect(t.errors.join()).toContain('title must be ≤ 60');
    const short = run(setup({ 'p-one': { fm: { description: 'D'.repeat(139) } } }));
    expect(short.errors.join()).toContain('140–160');
    const long = run(setup({ 'p-one': { fm: { description: 'D'.repeat(161) } } }));
    expect(long.errors.join()).toContain('140–160');
  });
  it('rejects missing, unknown and auto-calculated fields', () => {
    expect(run(setup({ 'p-one': { fm: { author: undefined } } })).errors.join()).toContain('author');
    expect(run(setup({ 'p-one': { fm: { readTime: 5 } } })).errors.join()).toContain('Unrecognized key');
    expect(run(setup({ 'p-one': { fm: { category: 'nope' } } })).errors.join()).toContain('unknown category');
    expect(run(setup({ 'p-one': { fm: { updatedAt: '2025-01-01' } } })).errors.join()).toContain('updatedAt');
  });
  it('detects duplicate slugs, reserved slugs and file/slug mismatch', () => {
    const dup = run(setup({ 'p-two': { fm: { slug: 'p-one' }, file: 'p-two.md' } }));
    expect(dup.errors.join()).toContain('file name must match slug');
    const reserved = run(setup({ 'p-one': { fm: { slug: 'category' }, file: 'category.md' } }));
    expect(reserved.errors.join()).toContain('reserved');
    const dupFile = run(setup({}, { 'p-one-copy.md': '---\n---\n' }));
    expect(dupFile.errors.join()).toContain('p-one-copy.md');
  });
  it('detects broken internal links, unknown related slugs and missing link quotas', () => {
    expect(run(setup({ 'p-one': { body: body(allLinks + ' [x](/blog/ghost)') } })).errors.join()).toContain('broken internal link: /blog/ghost');
    expect(run(setup({ 'p-one': { fm: { relatedSlugs: '[ghost]' } } })).errors.join()).toContain('unknown post "ghost"');
    expect(run(setup({ 'p-one': { body: body('[a](/blog/p-two) [pricing](/pricing)') } })).errors.join()).toContain('at least 3 other blog posts');
    expect(run(setup({ 'p-one': { body: body('[a](/blog/p-two) [b](/blog/p-three) [c](/blog/p-four)') } })).errors.join()).toContain('product/pricing page');
    expect(run(setup({ 'p-one': { body: body(allLinks + ' [bad](/nope)') } }), { knownPaths: new Set(['/pricing']) }).errors.join()).toContain('broken internal link: /nope');
  });
  it('hides drafts and future-dated posts', () => {
    const r = run(setup({ 'p-one': { fm: { draft: true } }, 'p-two': { fm: { publishedAt: '2026-12-01', updatedAt: '2026-12-01' } } }));
    expect(r.posts.map((p) => p.slug).sort()).toEqual(['p-four', 'p-three']);
  });
  it('rejects missing cover images', () => {
    const r = run(setup({ 'p-one': { fm: { cover: '{ src: /blog/missing.png, alt: Alt text here, width: 1200, height: 630 }' } } }));
    expect(r.errors.join()).toContain('cover image not found');
  });
});
