import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Calendar, Clock, Rss, Search, Sparkles } from 'lucide-react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { BlogCard } from '@/components/blog/BlogCard';
import { NewsletterSignup } from '@/components/blog/NewsletterSignup';
import {
  BLOG_CATEGORIES,
  SITE_URL,
  allTags,
  categoryUrl,
  filterPosts,
  formatDate,
  getCategoryBySlug,
  getPopularPosts,
  paginate,
  BLOG_POSTS,
  POSTS_PER_PAGE,
  type BlogCategory,
} from '@/lib/blogContent';
import { blogIndexJsonLd, breadcrumbJsonLd, categoryJsonLd } from '@/lib/blogSeo';
import { useSEO } from '@/lib/seo';

const truncate = (s: string, max = 157) => (s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, '')}…`);

const chip = (active: boolean) =>
  `focus-ring inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
    active ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-bg-secondary/80 text-text-secondary hover:border-accent/30 hover:text-text-primary'
  }`;

function Listing({ category }: { category?: BlogCategory }) {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const tag = params.get('tag') ?? '';
  const pageParam = Number(params.get('page')) || 1;
  const [draft, setDraft] = useState(q);

  // URL-synced, debounced search (history is replaced, so Back does not step through every keystroke).
  useEffect(() => setDraft(q), [q]);
  useEffect(() => {
    if (draft.trim() === q.trim()) return;
    const t = window.setTimeout(() => {
      const next = new URLSearchParams(params);
      if (draft.trim()) next.set('q', draft.trim());
      else next.delete('q');
      next.delete('page');
      setParams(next, { replace: true });
    }, 250);
    return () => window.clearTimeout(t);
  }, [draft, q, params, setParams]);

  const scoped = useMemo(() => (category ? BLOG_POSTS.filter((p) => p.category === category.slug) : BLOG_POSTS), [category]);
  const tags = useMemo(() => allTags(scoped).slice(0, 12), [scoped]);
  const filtered = useMemo(() => filterPosts({ q, tag, category: category?.slug }), [q, tag, category]);
  const isFiltered = Boolean(q.trim() || tag);
  const featured = !category && !isFiltered && pageParam === 1 ? BLOG_POSTS.find((p) => p.featured) ?? BLOG_POSTS[0] : undefined;
  const popular = !category && !isFiltered && pageParam === 1 ? getPopularPosts(3).filter((p) => p.slug !== featured?.slug) : [];
  const gridPosts = featured ? filtered.filter((p) => p.slug !== featured.slug) : filtered;
  const { items, page, pages } = paginate(gridPosts, pageParam, POSTS_PER_PAGE);

  const base = category ? `/blog/category/${category.slug}` : '/blog';
  const pageHref = (n: number) => {
    const next = new URLSearchParams(params);
    if (n > 1) next.set('page', String(n));
    else next.delete('page');
    const qs = next.toString();
    return qs ? `${base}?${qs}` : base;
  };

  const title = category ? `${category.title} | Vireek Blog` : 'Blog & Resources — Vireek';
  const description = category
    ? truncate(category.intro)
    : 'Practical guides on missed-call revenue, AI receptionists, call scripts, trade playbooks, dispatch and compliance for home service business owners.';
  const canonical = `${SITE_URL}${base}${!isFiltered && page > 1 ? `?page=${page}` : ''}`;
  const jsonLd = useMemo(
    () => [
      category ? categoryJsonLd(category, scoped) : blogIndexJsonLd(BLOG_POSTS),
      breadcrumbJsonLd([
        { name: 'Home', url: `${SITE_URL}/` },
        { name: 'Blog', url: `${SITE_URL}/blog` },
        ...(category ? [{ name: category.name, url: categoryUrl(category.slug) }] : []),
      ]),
    ],
    [category, scoped],
  );
  useSEO({ title, description, canonical, jsonLd });

  const clearFilters = () => {
    setDraft('');
    setParams(new URLSearchParams(), { replace: true });
  };

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-6 py-16 sm:py-20">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-5xl">
            <div className="mb-8"><BackButton fallback={category ? '/blog' : '/'} /></div>
            <div className="text-center">
              <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary">
                <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
                {category ? 'Topic hub' : 'Blog & Resources'}
              </div>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-6xl">
                {category ? category.title : 'Insights for home service businesses'}
              </h1>
              <p className="mx-auto mt-6 max-w-3xl text-lg leading-8 text-text-secondary sm:text-xl">
                {category ? category.intro : 'Practical guides on missed-call revenue, AI receptionists, call scripts, trade playbooks and compliance, written for contractors, not marketers.'}
              </p>
              <p className="mt-4 flex items-center justify-center gap-4 text-sm font-medium text-text-secondary">
                <a href="/blog-rss.xml" className="focus-ring inline-flex items-center gap-1.5 rounded-sm hover:text-accent"><Rss className="h-3.5 w-3.5" aria-hidden="true" />RSS</a>
                <a href="/blog-atom.xml" className="focus-ring rounded-sm hover:text-accent">Atom</a>
              </p>

              <form role="search" onSubmit={(e) => e.preventDefault()} className="mx-auto mt-10 max-w-2xl">
                <label htmlFor="blog-search" className="sr-only">Search articles</label>
                <div className="group relative flex items-center rounded-2xl border border-border bg-bg-secondary shadow-card focus-within:border-accent/50 dark:shadow-card-dark">
                  <Search className="ml-5 h-5 w-5 shrink-0 text-text-secondary/60 group-focus-within:text-accent" aria-hidden="true" />
                  <input
                    id="blog-search"
                    type="search"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={category ? `Search ${category.name}…` : 'Search articles…'}
                    className="w-full bg-transparent py-4 pl-3 pr-5 text-base text-text-primary placeholder:text-text-secondary/60 focus:outline-none"
                  />
                </div>
              </form>

              <nav aria-label="Blog topics" className="mx-auto mt-8 flex max-w-4xl flex-wrap items-center justify-center gap-2.5">
                <Link to="/blog" aria-current={!category ? 'page' : undefined} className={chip(!category)}>All articles</Link>
                {BLOG_CATEGORIES.filter((c) => BLOG_POSTS.some((p) => p.category === c.slug)).map((c) => {
                  const Icon = c.icon;
                  return (
                    <Link key={c.slug} to={`/blog/category/${c.slug}`} aria-current={category?.slug === c.slug ? 'page' : undefined} className={chip(category?.slug === c.slug)}>
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />{c.name}
                    </Link>
                  );
                })}
              </nav>

              {tags.length > 0 && (
                <div role="group" aria-label="Filter by tag" className="mx-auto mt-5 flex max-w-4xl flex-wrap items-center justify-center gap-2">
                  {tags.map(({ tag: t }) => (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={tag === t}
                      onClick={() => {
                        const next = new URLSearchParams(params);
                        if (tag === t) next.delete('tag');
                        else next.set('tag', t);
                        next.delete('page');
                        setParams(next, { replace: true });
                      }}
                      className={`focus-ring rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${tag === t ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
                    >
                      #{t}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {featured && (
          <section aria-label="Featured article" className="px-6 pt-4">
            <div className="mx-auto max-w-7xl">
              <Link to={`/blog/${featured.slug}`} className="focus-ring block rounded-[2rem]">
                <div className="group relative overflow-hidden rounded-[2rem] border border-border bg-bg-secondary p-8 shadow-card transition-all hover:-translate-y-0.5 hover:border-accent/25 hover:shadow-card-hover dark:shadow-card-dark sm:p-10">
                  <p className="text-xs font-semibold uppercase tracking-wider text-accent">Featured · {getCategoryBySlug(featured.category)?.name ?? 'Resources'}</p>
                  <h2 className="mt-5 text-3xl font-bold leading-tight tracking-tight text-text-primary sm:text-4xl">{featured.title}</h2>
                  <p className="mt-4 max-w-2xl text-base leading-7 text-text-secondary">{featured.description}</p>
                  <div className="mt-6 flex flex-wrap items-center gap-5 text-sm text-text-secondary">
                    <span className="flex items-center gap-1.5"><Calendar className="h-4 w-4" aria-hidden="true" />{formatDate(featured.publishedAt)}</span>
                    <span className="flex items-center gap-1.5"><Clock className="h-4 w-4" aria-hidden="true" />{featured.readTimeMinutes} min read</span>
                    <span className="inline-flex items-center gap-1.5 font-semibold text-accent">Read article <ArrowRight className="h-4 w-4" aria-hidden="true" /></span>
                  </div>
                </div>
              </Link>
            </div>
          </section>
        )}

        {popular.length > 0 && (
          <section aria-labelledby="popular-h" className="px-6 pt-14">
            <div className="mx-auto max-w-7xl">
              <h2 id="popular-h" className="text-2xl font-bold tracking-tight text-text-primary">Popular</h2>
              <ul className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {popular.map((p) => <li key={p.slug}><BlogCard post={p} showDate={false} /></li>)}
              </ul>
            </div>
          </section>
        )}

        <section aria-labelledby="all-h" className="px-6 py-14 sm:py-16">
          <div className="mx-auto max-w-7xl">
            <h2 id="all-h" className="text-2xl font-bold tracking-tight text-text-primary">
              {isFiltered ? `${filtered.length} result${filtered.length === 1 ? '' : 's'}` : category ? 'All articles in this topic' : 'Latest articles'}
            </h2>
            <p role="status" aria-live="polite" className="sr-only">{`${filtered.length} article${filtered.length === 1 ? '' : 's'} found`}</p>
            {BLOG_POSTS.length === 0 ? (
              <div className="mt-6 rounded-3xl border border-border bg-bg-secondary p-10 text-center">
                <p className="text-lg font-semibold text-text-primary">New articles are on the way</p>
                <p className="mt-2 text-text-secondary">Subscribe below and we will email you when the first guides are published.</p>
              </div>
            ) : items.length === 0 ? (
              <div className="mt-6 rounded-3xl border border-border bg-bg-secondary p-10 text-center">
                <p className="text-lg font-semibold text-text-primary">No articles found</p>
                <p className="mt-2 text-text-secondary">Try a different search term or remove a filter.</p>
                <div className="mt-5"><Button variant="secondary" size="sm" onClick={clearFilters}>Clear search and filters</Button></div>
              </div>
            ) : (
              <ul className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((p) => <li key={p.slug}><BlogCard post={p} /></li>)}
              </ul>
            )}

            {pages > 1 && (
              <nav aria-label="Pagination" className="mt-10 flex items-center justify-center gap-3 text-sm font-semibold">
                {page > 1 ? <Link to={pageHref(page - 1)} rel="prev" className="focus-ring rounded-xl border border-border px-4 py-2 hover:border-accent/40">Previous</Link> : <span className="rounded-xl border border-border/50 px-4 py-2 text-text-secondary/50" aria-disabled="true">Previous</span>}
                <span className="text-text-secondary" aria-current="page">Page {page} of {pages}</span>
                {page < pages ? <Link to={pageHref(page + 1)} rel="next" className="focus-ring rounded-xl border border-border px-4 py-2 hover:border-accent/40">Next</Link> : <span className="rounded-xl border border-border/50 px-4 py-2 text-text-secondary/50" aria-disabled="true">Next</span>}
              </nav>
            )}
          </div>
        </section>

        <section className="px-6 pb-24">
          <div className="mx-auto max-w-3xl"><NewsletterSignup source={category ? `hub:${category.slug}` : 'index'} /></div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

/** /blog and /blog/category/:slug share one listing; unknown categories fall back to /blog. */
export function BlogIndexPage() {
  const { slug } = useParams<{ slug?: string }>();
  const category = slug ? getCategoryBySlug(slug) : undefined;
  if (slug && !category) return <Navigate to="/blog" replace />;
  return <Listing key={category?.slug ?? 'all'} category={category} />;
}
