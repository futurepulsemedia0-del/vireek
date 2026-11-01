// Types for the Markdown-based blog (content/blog/*.md). The AST is produced at build time by
// scripts/blog/markdown.mjs — keep the two in sync.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] };

export type CtaType = 'trial' | 'demo' | 'pricing' | 'calculator';

export type Block =
  | { t: 'h2' | 'h3'; id: string; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'ul' | 'ol'; items: Inline[][] }
  | { t: 'quote'; c: Inline[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'callout'; kind: 'tip' | 'warning' | 'stat'; c: Block[] }
  | { t: 'takeaways' | 'steps'; items: Inline[][] }
  | { t: 'cta'; type: CtaType; heading: string; button: string; body: Inline[] }
  | { t: 'calculator' }
  | { t: 'figure'; src: string; alt: string; width: number; height: number; caption: Inline[] };

export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface BlogCover {
  src: string;
  alt: string;
  width: number;
  height: number;
}

export interface BlogPostMeta {
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  author: string;
  publishedAt: string;
  updatedAt: string;
  cover: BlogCover | null;
  featured: boolean;
  pillar: boolean;
  popularRank: number | null;
  draft: boolean;
  legalReview: boolean;
  relatedSlugs: string[];
  cta: { type: CtaType; heading: string; body: Inline[] };
  reviewedBy: { name: string; role: string; date: string } | null;
  sources: { title: string; url: string }[];
  wordCount: number;
  readTimeMinutes: number;
  searchText: string;
  faqCount: number;
  tocCount: number;
}

export interface BlogFaq {
  q: string;
  a: Inline[];
  aText: string;
}

export interface BlogPost extends Omit<BlogPostMeta, 'faqCount' | 'tocCount'> {
  faq: BlogFaq[];
  toc: TocItem[];
  body: Block[];
}

export interface BlogCategoryData {
  slug: string;
  name: string;
  icon: string;
  title: string;
  intro: string;
}

export interface BlogAuthor {
  name: string;
  type: 'person' | 'organization';
  role: string;
  bio: string;
  credentials: string[];
  url: string;
}
