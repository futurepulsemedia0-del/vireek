import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Calendar, Clock, RefreshCw, Sparkles, User } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { ArticleBody, CtaCard } from '@/components/blog/ArticleBody';
import { AuthorCard, FaqAccordion, ReadingProgress, ShareBar, SourcesList, TableOfContents, useScrollDepth } from '@/components/blog/ArticleChrome';
import { BlogCard } from '@/components/blog/BlogCard';
import { NewsletterSignup } from '@/components/blog/NewsletterSignup';
import {
  SITE_URL,
  formatDate,
  getAdjacentPosts,
  getAuthor,
  getCategoryBySlug,
  getPostMeta,
  getRelatedPosts,
  loadPost,
  ogImageUrl,
  postUrl,
} from '@/lib/blogContent';
import { articleJsonLd, breadcrumbJsonLd, faqJsonLd } from '@/lib/blogSeo';
import type { BlogPost } from '@/lib/blogTypes';
import { useSEO } from '@/lib/seo';

type LoadState = { status: 'loading' } | { status: 'ready'; post: BlogPost } | { status: 'missing' } | { status: 'error' };

export function BlogArticlePage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const meta = getPostMeta(slug);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const articleRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loadPost(slug)
      .then((post) => !cancelled && setState(post ? { status: 'ready', post } : { status: 'missing' }))
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [slug, attempt]);

  const post = state.status === 'ready' ? state.post : null;
  const category = meta ? getCategoryBySlug(meta.category) : undefined;
  const author = meta ? getAuthor(meta.author) : undefined;

  const jsonLd = useMemo(() => {
    if (!post) return undefined;
    const faq = faqJsonLd(post);
    return [
      articleJsonLd(post, author, category),
      breadcrumbJsonLd([
        { name: 'Home', url: `${SITE_URL}/` },
        { name: 'Blog', url: `${SITE_URL}/blog` },
        ...(category ? [{ name: category.name, url: `${SITE_URL}/blog/category/${category.slug}` }] : []),
        { name: post.title, url: postUrl(post.slug) },
      ]),
      ...(faq ? [faq] : []),
    ];
  }, [post, author, category]);

  useSEO({
    title: meta ? `${meta.title} | Vireek Blog` : 'Blog — Vireek',
    description: meta?.description ?? 'Practical guides for home service business owners.',
    canonical: meta ? postUrl(meta.slug) : `${SITE_URL}/blog`,
    type: 'article',
    image: meta ? ogImageUrl(meta.slug) : undefined,
    jsonLd,
  });
  useScrollDepth(slug, articleRef);

  if (!meta || state.status === 'missing') return <Navigate to="/blog" replace />;

  const related = getRelatedPosts(meta, 3);
  const { newer, older } = getAdjacentPosts(meta.slug);
  const CategoryIcon = category?.icon ?? Sparkles;

  return (
    <>
      <Header />
      {post && <ReadingProgress target={articleRef} />}
      <main className="min-h-screen bg-bg-primary pt-24">
        {state.status === 'error' ? (
          <section className="px-6 py-24 text-center">
            <p className="text-lg font-semibold text-text-primary">We could not load this article.</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="focus-ring mt-5 inline-flex items-center gap-2 rounded-xl border border-border px-5 py-3 text-sm font-semibold hover:border-accent/40">
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
            </button>
          </section>
        ) : !post ? (
          <div aria-busy="true" aria-label="Loading article" className="mx-auto max-w-3xl animate-pulse space-y-4 px-6 py-24">
            <div className="h-6 w-40 rounded bg-bg-tertiary" /><div className="h-12 w-full rounded bg-bg-tertiary" /><div className="h-4 w-3/4 rounded bg-bg-tertiary" /><div className="h-64 w-full rounded-2xl bg-bg-tertiary" />
          </div>
        ) : (
          <>
            <header className="relative bg-gradient-mesh bg-noise px-6 py-14 sm:py-18">
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
              <div className="mx-auto max-w-3xl">
                <nav aria-label="Breadcrumb" className="mb-6 text-sm text-text-secondary">
                  <ol className="flex flex-wrap items-center gap-1.5">
                    <li><Link to="/blog" className="focus-ring rounded-sm hover:text-accent">Blog</Link></li>
                    {category && (<><li aria-hidden="true">/</li><li><Link to={`/blog/category/${category.slug}`} className="focus-ring rounded-sm hover:text-accent">{category.name}</Link></li></>)}
                  </ol>
                </nav>
                <div className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-2 text-sm font-semibold text-accent">
                  <CategoryIcon className="h-4 w-4" aria-hidden="true" />{category?.name ?? 'Resources'}
                </div>
                <h1 className="mt-6 text-balance text-4xl font-extrabold leading-tight tracking-tight text-text-primary sm:text-5xl">{post.title}</h1>
                <p className="mt-5 text-xl leading-8 text-text-secondary">{post.description}</p>
                <dl className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-6 text-sm text-text-secondary">
                  <div className="flex items-center gap-1.5"><dt className="sr-only">Author</dt><User className="h-4 w-4" aria-hidden="true" /><dd>{author && !/^TODO/i.test(author.name) ? author.name : 'The Vireek Team'}</dd></div>
                  <div className="flex items-center gap-1.5"><dt className="sr-only">Published</dt><Calendar className="h-4 w-4" aria-hidden="true" /><dd><time dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time></dd></div>
                  {post.updatedAt !== post.publishedAt && <div className="flex items-center gap-1.5"><dt>Last updated</dt><dd><time dateTime={post.updatedAt}>{formatDate(post.updatedAt)}</time></dd></div>}
                  <div className="flex items-center gap-1.5"><dt className="sr-only">Reading time</dt><Clock className="h-4 w-4" aria-hidden="true" /><dd>{post.readTimeMinutes} min read</dd></div>
                </dl>
              </div>
            </header>

            <div className="mx-auto grid max-w-6xl gap-10 px-6 py-12 lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-14">
              <article ref={articleRef} className="min-w-0 lg:col-start-1 lg:row-start-1">
                <div className="mx-auto max-w-3xl">
                  {post.cover && (
                    <figure className="mb-10">
                      <img src={post.cover.src} alt={post.cover.alt} width={post.cover.width} height={post.cover.height} decoding="async" fetchPriority="high" className="h-auto w-full rounded-2xl border border-border" />
                    </figure>
                  )}
                  <TableOfContentsMobile post={post} />
                  <ArticleBody blocks={post.body} slug={post.slug} />
                  <div className="mt-14 space-y-12">
                    <FaqAccordion faq={post.faq} />
                    <SourcesList sources={post.sources} />
                    <CtaCard slug={post.slug} type={post.cta.type} heading={post.cta.heading} body={post.cta.body} placement="end" />
                    <ShareBar url={postUrl(post.slug)} title={post.title} slug={post.slug} />
                    <AuthorCard author={author} post={post} />
                  </div>
                </div>
              </article>
              <aside className="hidden lg:col-start-2 lg:row-start-1 lg:block"><TableOfContentsDesktop post={post} /></aside>
            </div>

            <section className="px-6 pb-14"><div className="mx-auto max-w-3xl"><NewsletterSignup source={`post:${post.slug}`} /></div></section>

            {(newer || older) && (
              <nav aria-label="More articles" className="px-6 pb-14">
                <div className="mx-auto grid max-w-3xl gap-4 sm:grid-cols-2">
                  {older ? (
                    <Link to={`/blog/${older.slug}`} rel="prev" className="focus-ring rounded-2xl border border-border bg-bg-secondary p-5 hover:border-accent/40">
                      <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-text-secondary"><ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />Previous</span>
                      <span className="mt-2 block font-semibold text-text-primary">{older.title}</span>
                    </Link>
                  ) : <span />}
                  {newer ? (
                    <Link to={`/blog/${newer.slug}`} rel="next" className="focus-ring rounded-2xl border border-border bg-bg-secondary p-5 text-right hover:border-accent/40">
                      <span className="flex items-center justify-end gap-1.5 text-xs font-semibold uppercase tracking-wider text-text-secondary">Next<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></span>
                      <span className="mt-2 block font-semibold text-text-primary">{newer.title}</span>
                    </Link>
                  ) : <span />}
                </div>
              </nav>
            )}

            {related.length > 0 && (
              <section aria-labelledby="related-h" className="px-6 pb-24">
                <div className="mx-auto max-w-6xl">
                  <h2 id="related-h" className="text-2xl font-bold tracking-tight text-text-primary">Keep reading</h2>
                  <ul className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    {related.map((r) => <li key={r.slug}><BlogCard post={r} showDate={false} /></li>)}
                  </ul>
                </div>
              </section>
            )}
          </>
        )}
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

/** FAQ is rendered outside the body AST, so it is appended to the table of contents here. */
function tocFor(post: BlogPost) {
  return post.faq.length ? [...post.toc, { id: 'faq', text: 'Frequently asked questions', level: 2 as const }] : post.toc;
}
function TableOfContentsMobile({ post }: { post: BlogPost }) {
  return <div className="lg:hidden"><TableOfContents items={tocFor(post)} variant="mobile" /></div>;
}
function TableOfContentsDesktop({ post }: { post: BlogPost }) {
  return <TableOfContents items={tocFor(post)} variant="desktop" />;
}
