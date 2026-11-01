import { describe, expect, it } from 'vitest';
import { BLOG_POSTS, allTags, filterPosts, getAdjacentPosts, getPopularPosts, getRelatedPosts, loadPost, paginate } from '@/lib/blogContent';
import type { BlogPostMeta } from '@/lib/blogTypes';

const mk = (slug: string, over: Partial<BlogPostMeta> = {}): BlogPostMeta => ({
  slug, title: slug, description: 'd', category: 'c1', tags: [], author: 'a', publishedAt: '2026-01-01', updatedAt: '2026-01-01',
  cover: null, featured: false, pillar: false, popularRank: null, draft: false, legalReview: false, relatedSlugs: [],
  cta: { type: 'trial', heading: '', body: [] }, reviewedBy: null, sources: [], wordCount: 1, readTimeMinutes: 1,
  searchText: slug, faqCount: 0, tocCount: 0, ...over,
});

describe('blog helpers', () => {
  const all = [
    mk('new', { publishedAt: '2026-03-01', tags: ['x'], searchText: 'new missed calls', popularRank: 2 }),
    mk('mid', { publishedAt: '2026-02-01', tags: ['x', 'y'], category: 'c2', searchText: 'mid pricing', popularRank: 1 }),
    mk('old', { publishedAt: '2026-01-01', tags: ['y'], searchText: 'old scripts' }),
  ];
  it('filters by every search word, tag and category', () => {
    expect(filterPosts({ q: 'missed calls' }, all).map((p) => p.slug)).toEqual(['new']);
    expect(filterPosts({ q: 'missed pricing' }, all)).toHaveLength(0);
    expect(filterPosts({ tag: 'y' }, all).map((p) => p.slug)).toEqual(['mid', 'old']);
    expect(filterPosts({ category: 'c2' }, all).map((p) => p.slug)).toEqual(['mid']);
  });
  it('paginates and clamps out-of-range pages', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(paginate(items, 1, 9).items).toHaveLength(9);
    expect(paginate(items, 3, 9).items).toHaveLength(2);
    expect(paginate(items, 99, 9).page).toBe(3);
    expect(paginate(items, -4, 9).page).toBe(1);
    expect(paginate([], 1, 9).pages).toBe(1);
  });
  it('puts explicit related posts first and never includes the post itself', () => {
    const rel = getRelatedPosts(mk('x', { tags: ['y'], relatedSlugs: ['new'] }), 3, all);
    expect(rel[0].slug).toBe('new');
    expect(rel.map((p) => p.slug)).not.toContain('x');
    expect(getRelatedPosts(all[1], 5, all).map((p) => p.slug)).not.toContain('mid');
  });
  it('finds chronological neighbours', () => {
    expect(getAdjacentPosts('mid', all)).toEqual({ newer: all[0], older: all[2] });
    expect(getAdjacentPosts('new', all).newer).toBeUndefined();
    expect(getAdjacentPosts('old', all).older).toBeUndefined();
  });
  it('ranks popular posts by popularRank only', () => {
    expect(getPopularPosts(5, all).map((p) => p.slug)).toEqual(['mid', 'new']);
    expect(allTags(all)[0].count).toBe(2);
  });
});

describe('published content (build-time validated)', () => {
  it('loads every published article body lazily', async () => {
    expect(BLOG_POSTS.length).toBeGreaterThan(0);
    for (const p of BLOG_POSTS) {
      const full = await loadPost(p.slug);
      expect(full?.body.length).toBeGreaterThan(0);
      expect(full?.toc.every((t) => t.id.length > 0)).toBe(true);
    }
    expect(await loadPost('does-not-exist')).toBeNull();
    expect(await loadPost('__proto__')).toBeNull();
  });
});
