import { describe, expect, it } from 'vitest';
import { ACADEMY_COURSES } from './academy';
import {
  HELP_ARTICLES,
  HELP_CATEGORIES,
  HELP_VIDEOS,
  buildVideoLibrary,
  contextualArticles,
  contextualVideos,
  filterByPermission,
  fold,
  highlightParts,
  isValidContextPath,
  normalizePath,
  pageLabel,
  pushRecent,
  routeMatches,
  searchArticles,
  searchVideos,
  toEmbedSrc,
  tokenize,
  videoEmbedState,
  type HelpArticle,
} from './helpCenter';

const article = (over: Partial<HelpArticle>): HelpArticle => ({
  id: 'a',
  category: 'account',
  title: 'Title',
  summary: 'Summary',
  body: ['Body'],
  keywords: [],
  routes: [],
  ...over,
});

describe('content integrity', () => {
  it('has unique article ids and known categories', () => {
    const ids = HELP_ARTICLES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cats = new Set(HELP_CATEGORIES.map((c) => c.id));
    for (const a of HELP_ARTICLES) expect(cats.has(a.category)).toBe(true);
  });

  it('only references real Academy videos and dashboard routes', () => {
    const videoIds = new Set(HELP_VIDEOS.map((v) => v.id));
    for (const a of HELP_ARTICLES) {
      for (const id of a.videoIds ?? []) expect(videoIds.has(id)).toBe(true);
      for (const r of a.routes) expect(r.startsWith('/dashboard')).toBe(true);
    }
  });

  it('derives the video library from every Academy lesson', () => {
    const lessons = ACADEMY_COURSES.reduce((n, c) => n + c.lessons.length, 0);
    expect(HELP_VIDEOS).toHaveLength(lessons);
    expect(new Set(HELP_VIDEOS.map((v) => v.id)).size).toBe(lessons);
  });

  it('gives every article a title, summary and body', () => {
    for (const a of HELP_ARTICLES) {
      expect(a.title.length > 3 && a.summary.length > 3 && a.body.length > 0).toBe(true);
    }
  });
});

describe('route context', () => {
  it('normalizes paths', () => {
    expect(normalizePath('/Dashboard/Calls/?x=1#top')).toBe('/dashboard/calls');
    expect(normalizePath('')).toBe('/');
  });

  it('matches by prefix on segment boundaries, but /dashboard only exactly', () => {
    expect(routeMatches('/dashboard/inventory/counts', '/dashboard/inventory')).toBe(true);
    expect(routeMatches('/dashboard/inventory-x', '/dashboard/inventory')).toBe(false);
    expect(routeMatches('/dashboard/calls', '/dashboard')).toBe(false);
    expect(routeMatches('/dashboard', '/dashboard')).toBe(true);
  });

  it('puts the most specific article first', () => {
    const list = contextualArticles('/dashboard/inventory/counts', HELP_ARTICLES).map((a) => a.id);
    expect(list[0]).toBe('cycle-counts');
    expect(list).toContain('inventory-overview');
    expect(list.indexOf('cycle-counts')).toBeLessThan(list.indexOf('inventory-overview'));
  });

  it('returns nothing for pages without help, and videos for pages that have them', () => {
    expect(contextualArticles('/dashboard/some-unknown-page', HELP_ARTICLES).map((a) => a.id)).not.toContain('cycle-counts');
    expect(contextualVideos('/dashboard/price-book', HELP_VIDEOS).map((v) => v.id)).toContain('price-book');
  });

  it('labels pages by longest prefix', () => {
    expect(pageLabel('/dashboard/inventory/counts')).toBe('Cycle Counts');
    expect(pageLabel('/dashboard/inventory')).toBe('Parts & Inventory');
    expect(pageLabel('/dashboard/zzz')).toBeNull();
    expect(pageLabel('/dashboard')).toBe('Overview');
  });

  it('only accepts safe dashboard paths as context', () => {
    expect(isValidContextPath('/dashboard/calls')).toBe(true);
    expect(isValidContextPath('/dashboard/help')).toBe(false);
    expect(isValidContextPath('https://evil.test/dashboard')).toBe(false);
    expect(isValidContextPath('/dashboard/<script>')).toBe(false);
    expect(isValidContextPath(null)).toBe(false);
  });
});

describe('permissions', () => {
  const gated = article({ id: 'g', permission: 'can_view_billing' });
  const open = article({ id: 'o' });
  it('hides gated articles unless owner or permitted', () => {
    expect(filterByPermission([gated, open], { isOwner: false, permissions: {} }).map((a) => a.id)).toEqual(['o']);
    expect(filterByPermission([gated, open], { isOwner: false, permissions: { can_view_billing: true } })).toHaveLength(2);
    expect(filterByPermission([gated, open], { isOwner: true, permissions: {} })).toHaveLength(2);
  });
});

describe('search', () => {
  it('folds accents and punctuation, drops 1-char tokens', () => {
    expect(fold('Café—Stock!')).toBe('cafe stock');
    expect(tokenize('a  Stock stock')).toEqual(['stock']);
  });

  it('requires every token to match (AND)', () => {
    const r = searchArticles('approve count', HELP_ARTICLES).map((x) => x.article.id);
    expect(r).toContain('approve-a-count');
    expect(searchArticles('cycle zzzzqq', HELP_ARTICLES)).toHaveLength(0);
  });

  it('ranks title hits above body hits', () => {
    const list = [
      article({ id: 'body', title: 'Other', body: ['mentions forwarding once'] }),
      article({ id: 'title', title: 'Forwarding setup' }),
    ];
    expect(searchArticles('forwarding', list).map((x) => x.article.id)).toEqual(['title', 'body']);
  });

  it('finds articles by keyword synonyms the copy does not contain', () => {
    expect(searchArticles('stocktake', HELP_ARTICLES)[0].article.id).toBe('cycle-counts');
  });

  it('returns nothing for an empty or too-short query', () => {
    expect(searchArticles('', HELP_ARTICLES)).toEqual([]);
    expect(searchArticles(' a ', HELP_ARTICLES)).toEqual([]);
  });

  it('is safe against regex metacharacters', () => {
    expect(() => searchArticles('(.*[', HELP_ARTICLES)).not.toThrow();
    expect(() => highlightParts('abc', '(.*[')).not.toThrow();
  });

  it('searches videos by title, description and course', () => {
    expect(searchVideos('dispatch', HELP_VIDEOS).map((v) => v.id)).toContain('dispatch-board');
    expect(searchVideos('qqqqq', HELP_VIDEOS)).toEqual([]);
  });

  it('highlights matches without losing text', () => {
    const parts = highlightParts('Forward your number', 'forward number');
    expect(parts.map((p) => p.text).join('')).toBe('Forward your number');
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(['Forward', 'number']);
    expect(highlightParts('plain', '')).toEqual([{ text: 'plain', match: false }]);
  });
});

describe('videos', () => {
  it('flags Academy placeholders so no broken player is shown', () => {
    expect(videoEmbedState('https://www.youtube.com/embed/REPLACE_ME_WELCOME')).toBe('placeholder');
  });
  it('allows only https embeds on known hosts', () => {
    expect(videoEmbedState('https://www.youtube.com/embed/abc123')).toBe('ok');
    expect(videoEmbedState('https://player.vimeo.com/video/42')).toBe('ok');
    expect(videoEmbedState('http://www.youtube.com/embed/abc')).toBe('invalid');
    expect(videoEmbedState('https://evil.test/embed/abc')).toBe('invalid');
    expect(videoEmbedState('javascript:alert(1)')).toBe('invalid');
    expect(videoEmbedState('not a url')).toBe('invalid');
  });
  it('serves YouTube from the privacy-enhanced host', () => {
    expect(toEmbedSrc('https://www.youtube.com/embed/abc')).toBe('https://www.youtube-nocookie.com/embed/abc');
    expect(toEmbedSrc('https://player.vimeo.com/video/42')).toBe('https://player.vimeo.com/video/42');
  });
  it('builds a library from arbitrary courses', () => {
    const lib = buildVideoLibrary([
      { slug: 's', title: 'T', summary: '', lessons: [{ id: 'x', title: 'X', minutes: 2, videoUrl: 'u', description: 'd' }] },
    ]);
    expect(lib).toEqual([expect.objectContaining({ id: 'x', courseSlug: 's', courseTitle: 'T', routes: [] })]);
  });
});

describe('recent searches', () => {
  it('dedupes case-insensitively, trims, caps at 5, ignores junk', () => {
    let list: string[] = [];
    for (const q of ['one', 'two', 'three', 'four', 'five', 'six']) list = pushRecent(list, q);
    expect(list).toEqual(['six', 'five', 'four', 'three', 'two']);
    expect(pushRecent(list, '  TWO  ')[0]).toBe('TWO');
    expect(pushRecent(list, 'TWO')).toHaveLength(5);
    expect(pushRecent(list, 'x')).toBe(list);
  });
});
