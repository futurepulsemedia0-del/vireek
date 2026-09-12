import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Calendar, Clock, Rss, Search, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { BLOG_CATEGORIES, BLOG_POSTS, getCategoryBySlug, type BlogPost } from '@/lib/blog';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function SEO() {
  useSEO({
    title: 'Blog & Resources — Vireek',
    description:
      'Practical guides on missed-call revenue loss, call scripts, HVAC and plumbing dispatch, AI receptionists, and security — for home service business owners.',
    canonical: 'https://vireek.com/blog',
  });

  useEffect(() => {
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'Blog',
      name: 'Vireek Blog',
      url: 'https://vireek.com/blog',
      blogPost: BLOG_POSTS.map((post) => ({
        '@type': 'BlogPosting',
        headline: post.title,
        datePublished: post.publishedDate,
        url: `https://vireek.com/blog/${post.slug}`,
      })),
    };
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.text = JSON.stringify(schema);
    document.head.appendChild(script);
    return () => {
      script.remove();
    };
  }, []);

  return null;
}

function PostCard({ post, index }: { post: BlogPost; index: number }) {
  const category = getCategoryBySlug(post.category);
  const Icon = category?.icon ?? Sparkles;

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewport}
      transition={{ duration: 0.45, ease: EASE, delay: Math.min(index * 0.05, 0.3) }}
    >
      <Link to={`/blog/${post.slug}`} className="focus-ring block h-full rounded-2xl">
        <Card className="flex h-full flex-col p-6">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
              <Icon className="h-4 w-4" />
            </span>
            <span className="text-xs font-semibold uppercase tracking-wider text-accent">
              {category?.name ?? 'Resources'}
            </span>
          </div>
          <h3 className="mt-4 text-lg font-bold leading-snug tracking-tight text-text-primary">{post.title}</h3>
          <p className="mt-2.5 flex-1 text-sm leading-relaxed text-text-secondary">{post.excerpt}</p>
          <div className="mt-5 flex items-center justify-between border-t border-border pt-4 text-xs text-text-secondary">
            <span className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              {formatDate(post.publishedDate)}
            </span>
            <span className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              {post.readTimeMinutes} min read
            </span>
          </div>
        </Card>
      </Link>
    </motion.div>
  );
}

export function BlogPage() {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const featuredPost = useMemo(() => BLOG_POSTS.find((p) => p.featured) ?? BLOG_POSTS[0], []);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredPosts = useMemo(() => {
    return BLOG_POSTS.filter((post) => {
      if (post.slug === featuredPost.slug && !normalizedQuery && !activeCategory) return false;
      const matchesCategory = !activeCategory || post.category === activeCategory;
      const matchesQuery =
        !normalizedQuery ||
        post.title.toLowerCase().includes(normalizedQuery) ||
        post.excerpt.toLowerCase().includes(normalizedQuery);
      return matchesCategory && matchesQuery;
    });
  }, [normalizedQuery, activeCategory, featuredPost.slug]);

  const featuredCategory = getCategoryBySlug(featuredPost.category);
  const FeaturedIcon = featuredCategory?.icon ?? Sparkles;
  const showFeatured = !normalizedQuery && !activeCategory;

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-5xl">
            <div className="mb-8">
              <BackButton />
            </div>
            <div className="text-center">
              <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
                <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                  <Sparkles className="h-4 w-4 text-accent" />
                  Blog &amp; Resources
                </div>
                <h1 className="text-balance text-5xl font-extrabold tracking-tight text-text-primary sm:text-6xl lg:text-7xl">
                  Insights for home service businesses
                </h1>
                <p className="mx-auto mt-6 max-w-3xl text-xl leading-8 text-text-secondary sm:text-2xl">
                  Practical guides on missed-call revenue, call scripts, dispatch, and security — written for
                  contractors, not marketers.
                </p>
                <a
                  href="/blog-rss.xml"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="focus-ring mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary transition-colors hover:text-accent"
                >
                  <Rss className="h-3.5 w-3.5" /> RSS feed
                </a>

                {/* Search */}
                <div className="mx-auto mt-10 max-w-2xl">
                  <div className="group relative flex items-center rounded-2xl border border-border bg-bg-secondary shadow-card transition-colors focus-within:border-accent/50 dark:shadow-card-dark">
                    <Search className="ml-5 h-5 w-5 shrink-0 text-text-secondary/60 group-focus-within:text-accent" />
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search articles…"
                      aria-label="Search the blog"
                      className="w-full bg-transparent py-4 pl-3 pr-5 text-base text-text-primary placeholder:text-text-secondary/50 focus:outline-none"
                    />
                  </div>
                </div>

                {/* Category filters */}
                <div className="mx-auto mt-8 flex max-w-3xl flex-wrap items-center justify-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setActiveCategory(null)}
                    className={`focus-ring inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold transition-all duration-200 ease-out ${
                      activeCategory === null
                        ? 'border-accent/40 bg-accent/10 text-accent'
                        : 'border-border bg-bg-secondary/80 text-text-secondary hover:border-accent/30 hover:text-text-primary'
                    }`}
                  >
                    All articles
                  </button>
                  {BLOG_CATEGORIES.map((category) => {
                    const Icon = category.icon;
                    const isActive = activeCategory === category.slug;
                    return (
                      <button
                        key={category.slug}
                        type="button"
                        onClick={() => setActiveCategory(isActive ? null : category.slug)}
                        className={`focus-ring inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold transition-all duration-200 ease-out ${
                          isActive
                            ? 'border-accent/40 bg-accent/10 text-accent'
                            : 'border-border bg-bg-secondary/80 text-text-secondary hover:border-accent/30 hover:text-text-primary'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {category.name}
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Featured post */}
        {showFeatured && (
          <section className="px-6 pb-4 pt-4">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-7xl"
            >
              <Link to={`/blog/${featuredPost.slug}`} className="focus-ring block rounded-[2rem]">
                <div className="group relative overflow-hidden rounded-[2rem] border border-border bg-bg-secondary p-8 shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/25 hover:shadow-card-hover dark:shadow-card-dark sm:p-10">
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 opacity-[0.6]"
                    style={{
                      background:
                        'radial-gradient(circle at 85% 0%, rgb(var(--accent-primary) / 0.10), transparent 55%)',
                    }}
                  />
                  <div className="relative">
                    <div className="flex items-center gap-2">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
                        <FeaturedIcon className="h-4 w-4" />
                      </span>
                      <span className="text-xs font-semibold uppercase tracking-wider text-accent">
                        Featured &middot; {featuredCategory?.name ?? 'Resources'}
                      </span>
                    </div>
                    <h2 className="mt-5 text-3xl font-bold leading-tight tracking-tight text-text-primary sm:text-4xl">
                      {featuredPost.title}
                    </h2>
                    <p className="mt-4 max-w-2xl text-base leading-7 text-text-secondary">{featuredPost.excerpt}</p>
                    <div className="mt-6 flex flex-wrap items-center gap-5 text-sm text-text-secondary">
                      <span className="flex items-center gap-1.5">
                        <Calendar className="h-4 w-4" />
                        {formatDate(featuredPost.publishedDate)}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Clock className="h-4 w-4" />
                        {featuredPost.readTimeMinutes} min read
                      </span>
                      <span className="inline-flex items-center gap-1.5 font-semibold text-accent">
                        Read article
                        <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            </motion.div>
          </section>
        )}

        {/* Post grid */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-7xl">
            {filteredPosts.length === 0 ? (
              <div className="rounded-3xl border border-border bg-bg-secondary p-10 text-center shadow-card dark:shadow-card-dark">
                <p className="text-lg font-semibold text-text-primary">No articles found</p>
                <p className="mt-2 text-text-secondary">Try a different search term or category.</p>
              </div>
            ) : (
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {filteredPosts.map((post, index) => (
                  <PostCard key={post.slug} post={post} index={index} />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* CTA */}
        <section className="px-6 pb-24">
          <div className="mx-auto max-w-5xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Ready when your customers call</p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Turn missed calls into captured opportunities.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary">
              Launch Vireek to answer calls, qualify demand, and help your team follow up with confidence.
            </p>
            <div className="mt-8">
              <Link to="/login">
                <Button variant="primary" size="lg">
                  Start Free Trial
                </Button>
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
