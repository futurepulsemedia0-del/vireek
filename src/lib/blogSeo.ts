import type { BlogAuthor, BlogCategoryData, BlogPost, BlogPostMeta } from '@/lib/blogTypes';
import { SITE_URL, categoryUrl, ogImageUrl, postUrl } from '@/lib/blogContent';

type Json = Record<string, unknown>;

export const breadcrumbJsonLd = (items: { name: string; url: string }[]): Json => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.url })),
});

export function articleJsonLd(post: BlogPostMeta, author: BlogAuthor | undefined, category: BlogCategoryData | undefined): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.description,
    image: [ogImageUrl(post.slug)],
    datePublished: post.publishedAt,
    dateModified: post.updatedAt,
    mainEntityOfPage: { '@type': 'WebPage', '@id': postUrl(post.slug) },
    author: {
      '@type': author?.type === 'person' ? 'Person' : 'Organization',
      name: author?.name ?? 'The Vireek Team',
      ...(author?.url ? { url: author.url.startsWith('/') ? `${SITE_URL}${author.url}` : author.url } : {}),
    },
    publisher: { '@type': 'Organization', name: 'Vireek', url: SITE_URL, logo: { '@type': 'ImageObject', url: `${SITE_URL}/web-app-manifest-512x512.png` } },
    wordCount: post.wordCount,
    keywords: post.tags.join(', '),
    ...(category ? { articleSection: category.name } : {}),
    ...(post.sources.length ? { citation: post.sources.map((s) => ({ '@type': 'CreativeWork', name: s.title, url: s.url })) } : {}),
    inLanguage: 'en-US',
  };
}

export const faqJsonLd = (post: Pick<BlogPost, 'faq'>): Json | null =>
  post.faq.length
    ? {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: post.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.aText } })),
      }
    : null;

export const blogIndexJsonLd = (posts: BlogPostMeta[]): Json => ({
  '@context': 'https://schema.org',
  '@type': 'Blog',
  name: 'Vireek Blog',
  url: `${SITE_URL}/blog`,
  blogPost: posts.slice(0, 20).map((p) => ({ '@type': 'BlogPosting', headline: p.title, datePublished: p.publishedAt, url: postUrl(p.slug) })),
});

export const categoryJsonLd = (cat: BlogCategoryData, posts: BlogPostMeta[]): Json => ({
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  name: cat.title,
  description: cat.intro,
  url: categoryUrl(cat.slug),
  hasPart: posts.slice(0, 20).map((p) => ({ '@type': 'BlogPosting', headline: p.title, url: postUrl(p.slug) })),
});
