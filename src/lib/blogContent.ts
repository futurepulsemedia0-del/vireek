import {
  BarChart3,
  Bot,
  ClipboardList,
  FileText,
  PhoneMissed,
  Plug,
  ShieldCheck,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { AUTHORS, CATEGORIES, POSTS, POST_LOADERS } from 'virtual:vireek-blog';
import type { BlogAuthor, BlogCategoryData, BlogPost, BlogPostMeta } from '@/lib/blogTypes';

export const SITE_URL = 'https://vireek.com';
export const POSTS_PER_PAGE = 9;

const ICONS: Record<string, LucideIcon> = { BarChart3, Bot, ClipboardList, FileText, PhoneMissed, Plug, ShieldCheck, Sparkles, Wrench };

export interface BlogCategory extends BlogCategoryData {
  icon: LucideIcon;
}

export const BLOG_CATEGORIES: BlogCategory[] = CATEGORIES.map((c) => ({ ...c, icon: ICONS[c.icon] ?? Sparkles }));

/** Metadata for every published post, newest first. `excerpt`/`publishedDate` keep older call sites working. */
export const BLOG_POSTS: (BlogPostMeta & { excerpt: string; publishedDate: string })[] = POSTS.map((p) => ({
  ...p,
  excerpt: p.description,
  publishedDate: p.publishedAt,
}));

export const postUrl = (slug: string) => `${SITE_URL}/blog/${slug}`;
export const categoryUrl = (slug: string) => `${SITE_URL}/blog/category/${slug}`;
export const ogImageUrl = (slug: string) => `${SITE_URL}/og/blog/${slug}.png`;

export function getPostMeta(slug: string): BlogPostMeta | undefined {
  return POSTS.find((p) => p.slug === slug);
}
export function getPostBySlug(slug: string) {
  return BLOG_POSTS.find((p) => p.slug === slug);
}
export function getCategoryBySlug(slug: string): BlogCategory | undefined {
  return BLOG_CATEGORIES.find((c) => c.slug === slug);
}
export function getAuthor(key: string): BlogAuthor | undefined {
  return AUTHORS[key];
}

/** Lazy-loads the full article (body AST). Resolves null for unknown slugs. */
export async function loadPost(slug: string): Promise<BlogPost | null> {
  const loader = Object.prototype.hasOwnProperty.call(POST_LOADERS, slug) ? POST_LOADERS[slug] : undefined;
  if (!loader) return null;
  return loader();
}

/** Explicit relatedSlugs first, then ranked by shared tags (x2) + same category, newest wins ties. */
export function getRelatedPosts(
  post: Pick<BlogPostMeta, 'slug' | 'category' | 'tags' | 'relatedSlugs'>,
  count = 3,
  all: BlogPostMeta[] = POSTS,
): BlogPostMeta[] {
  const explicit = post.relatedSlugs
    .map((s) => all.find((p) => p.slug === s))
    .filter((p): p is BlogPostMeta => Boolean(p));
  const rest = all
    .filter((p) => p.slug !== post.slug && !post.relatedSlugs.includes(p.slug))
    .map((p) => ({ p, score: p.tags.filter((t) => post.tags.includes(t)).length * 2 + (p.category === post.category ? 1 : 0) }))
    .sort((a, b) => b.score - a.score || b.p.publishedAt.localeCompare(a.p.publishedAt))
    .map((x) => x.p);
  return [...explicit, ...rest].slice(0, count);
}

/** Chronological neighbours: `newer` published after this post, `older` before it. */
export function getAdjacentPosts(slug: string, all: BlogPostMeta[] = POSTS) {
  const i = all.findIndex((p) => p.slug === slug);
  return { newer: i > 0 ? all[i - 1] : undefined, older: i >= 0 && i < all.length - 1 ? all[i + 1] : undefined };
}

/** Editor-picked "Popular": posts with a popularRank (frontmatter), lowest rank first. Not analytics-driven. */
export function getPopularPosts(count = 4, all: BlogPostMeta[] = POSTS): BlogPostMeta[] {
  return all
    .filter((p) => p.popularRank !== null)
    .sort((a, b) => (a.popularRank ?? 0) - (b.popularRank ?? 0))
    .slice(0, count);
}

export function allTags(all: BlogPostMeta[] = POSTS): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  all.forEach((p) => p.tags.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1)));
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export interface PostFilter {
  q?: string;
  tag?: string;
  category?: string;
}

/** Every search word must appear in title, description, tags or headings. */
export function filterPosts(filter: PostFilter, all: BlogPostMeta[] = POSTS): BlogPostMeta[] {
  const words = (filter.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return all.filter(
    (p) =>
      (!filter.category || p.category === filter.category) &&
      (!filter.tag || p.tags.includes(filter.tag)) &&
      words.every((w) => p.searchText.includes(w)),
  );
}

export function paginate<T>(items: T[], page: number, perPage = POSTS_PER_PAGE) {
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { items: items.slice((current - 1) * perPage, current * perPage), page: current, pages, total: items.length };
}

export const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
