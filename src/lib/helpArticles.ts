import { HELP_CATEGORIES, type HelpArticle, type HelpCategory } from '@/lib/helpContent';

export interface HelpArticleRecord {
  slug: string;
  title: string;
  body: string;
  excerpt: string;
  categoryId: string;
  categoryName: string;
}

const MAX_SLUG_LENGTH = 80;

export function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length <= MAX_SLUG_LENGTH) return base;
  const cut = base.slice(0, MAX_SLUG_LENGTH);
  const lastDash = cut.lastIndexOf('-');
  return lastDash > 0 ? cut.slice(0, lastDash) : cut;
}

export function makeExcerpt(text: string, max = 155): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const trimmed = (space > 80 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, '');
  return `${trimmed}…`;
}

const slugByArticle = new WeakMap<HelpArticle, string>();

export function buildHelpArticles(categories: HelpCategory[]): HelpArticleRecord[] {
  const explicit = new Set<string>();
  for (const cat of categories) {
    for (const art of cat.articles) if (art.slug) explicit.add(slugify(art.slug));
  }
  const used = new Set<string>();
  const out: HelpArticleRecord[] = [];
  let fallback = 0;
  for (const cat of categories) {
    for (const art of cat.articles) {
      const isExplicit = Boolean(art.slug);
      const wanted = (isExplicit ? slugify(art.slug as string) : slugify(art.q)) || `article-${(fallback += 1)}`;
      let slug = wanted;
      let n = 2;
      while (used.has(slug) || (!isExplicit && explicit.has(slug))) {
        slug = `${wanted}-${n}`;
        n += 1;
      }
      used.add(slug);
      slugByArticle.set(art, slug);
      out.push({
        slug,
        title: art.q.trim(),
        body: art.a.trim(),
        excerpt: makeExcerpt(art.a),
        categoryId: cat.id,
        categoryName: cat.name,
      });
    }
  }
  return out;
}

export const HELP_ARTICLES: HelpArticleRecord[] = buildHelpArticles(HELP_CATEGORIES);

export const getHelpArticle = (slug: string): HelpArticleRecord | undefined =>
  HELP_ARTICLES.find((a) => a.slug === slug);

export const getHelpArticleSlug = (article: HelpArticle): string | undefined => slugByArticle.get(article);

export const getHelpCategory = (id: string): HelpCategory | undefined => HELP_CATEGORIES.find((c) => c.id === id);

// ------------------------------------------------------------
// Search + related
// ------------------------------------------------------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’‘`]/g, '');

const tokenize = (s: string) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'i', 'my', 'do', 'does', 'is', 'are', 'can', 'how', 'what', 'to', 'of', 'in', 'on',
  'and', 'or', 'it', 'me', 'we', 'you', 'for', 'with', 'that', 'this', 'be', 'at', 'as', 'if',
]);

/** All meaningful words must match (prefix-friendly for type-ahead). Title hits rank highest. */
export function searchHelpArticles(
  query: string,
  limit = 8,
  articles: HelpArticleRecord[] = HELP_ARTICLES,
): HelpArticleRecord[] {
  const tokens = tokenize(query);
  const meaningful = tokens.filter((t) => !STOP_WORDS.has(t));
  const words = meaningful.length > 0 ? meaningful : tokens;
  if (words.length === 0) return [];

  const scored: Array<{ a: HelpArticleRecord; i: number; score: number }> = [];
  articles.forEach((a, i) => {
    const title = norm(a.title);
    const body = norm(a.body);
    const cat = norm(a.categoryName);
    let score = 0;
    for (const w of words) {
      const inTitle = title.includes(w);
      const inBody = body.includes(w);
      const inCat = cat.includes(w);
      if (!inTitle && !inBody && !inCat) return;
      score += (inTitle ? 3 : 0) + (inBody ? 1 : 0) + (inCat ? 1 : 0);
    }
    scored.push({ a, i, score });
  });
  scored.sort((x, y) => y.score - x.score || x.i - y.i);
  return scored.slice(0, limit).map((s) => s.a);
}

export function getRelatedHelpArticles(
  article: HelpArticleRecord,
  count = 3,
  articles: HelpArticleRecord[] = HELP_ARTICLES,
): HelpArticleRecord[] {
  const words = new Set(tokenize(article.title).filter((w) => !STOP_WORDS.has(w) && w.length > 2));
  return articles
    .map((a, i) => {
      if (a.slug === article.slug) return null;
      const overlap = tokenize(a.title).filter((w) => words.has(w)).length;
      return { a, i, score: overlap * 2 + (a.categoryId === article.categoryId ? 3 : 0) };
    })
    .filter((x): x is { a: HelpArticleRecord; i: number; score: number } => x !== null && x.score > 0)
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .slice(0, count)
    .map((x) => x.a);
}
