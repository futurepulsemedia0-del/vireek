import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HelpCategory } from '@/lib/helpContent';
import {
  HELP_ARTICLES, buildHelpArticles, getRelatedHelpArticles, makeExcerpt, searchHelpArticles, slugify,
} from '@/lib/helpArticles';

const icon = (() => null) as unknown as HelpCategory['icon'];

describe('slugs', () => {
  it('produces unique, URL-safe slugs for every real article', () => {
    const slugs = HELP_ARTICLES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) {
      expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(s.length).toBeLessThanOrEqual(80);
    }
  });

  it('strips apostrophes and diacritics, and caps length on a word boundary', () => {
    expect(slugify('What’s the difference?')).toBe('whats-the-difference');
    expect(slugify('Café déjà vu')).toBe('cafe-deja-vu');
    expect(slugify('word '.repeat(40)).length).toBeLessThanOrEqual(80);
  });

  it('de-duplicates colliding questions and honours explicit slugs first', () => {
    const cats: HelpCategory[] = [
      {
        id: 'c', name: 'C', icon, description: '',
        articles: [
          { q: 'Same question?', a: 'one' },
          { q: 'Same question', a: 'two' },
          { q: 'Anything', a: 'three', slug: 'same-question' },
        ],
      },
    ];
    const slugs = buildHelpArticles(cats).map((a) => a.slug);
    expect(slugs).toEqual(['same-question-2', 'same-question-3', 'same-question']);
  });
});

describe('search', () => {
  it('finds articles by any meaningful word, ignoring case and accents', () => {
    const hits = searchHelpArticles('INVITE');
    expect(hits.some((h) => h.title.toLowerCase().includes('invite'))).toBe(true);
  });
  it('requires all words to match and returns nothing for gibberish or empty input', () => {
    expect(searchHelpArticles('')).toEqual([]);
    expect(searchHelpArticles('zzzxqv')).toEqual([]);
    expect(searchHelpArticles('invite zzzxqv')).toEqual([]);
  });
  it('respects the limit', () => {
    expect(searchHelpArticles('sarah', 2).length).toBeLessThanOrEqual(2);
  });
});

describe('related + excerpt', () => {
  it('never includes the article itself and prefers the same category', () => {
    const base = HELP_ARTICLES[0];
    const related = getRelatedHelpArticles(base, 3);
    expect(related.length).toBeGreaterThan(0);
    expect(related.every((r) => r.slug !== base.slug)).toBe(true);
    expect(related[0].categoryId).toBe(base.categoryId);
  });
  it('keeps meta descriptions within 155 characters', () => {
    expect(makeExcerpt('word '.repeat(100)).length).toBeLessThanOrEqual(155);
    for (const a of HELP_ARTICLES) expect(a.excerpt.length).toBeLessThanOrEqual(155);
  });
});

describe('sitemap', () => {
  it('lists every help article (run: node scripts/generate-help-sitemap.mjs)', () => {
    const xml = readFileSync(path.resolve(process.cwd(), 'public/sitemap.xml'), 'utf8');
    const missing = HELP_ARTICLES.filter((a) => !xml.includes(`<loc>https://vireek.com/help/${a.slug}</loc>`));
    expect(missing.map((a) => a.slug)).toEqual([]);
  });
});
