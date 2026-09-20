import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, BookOpen, Droplets, Eye, Mail, Quote, Sparkles, Star, TrendingUp, Wind, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { Button } from '@/components/ui/Button';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { CASE_STUDIES } from '@/components/sections/CaseStudies';
import { BLOG_POSTS, getCategoryBySlug } from '@/lib/blog';

// Curated "related reading" for this page: real posts that already exist on
// the blog (src/lib/blog.ts), chosen because they support the trust/proof
// story this page tells — why missed calls cost real money, how an AI
// receptionist compares to the alternatives, and how we handle data. This
// keeps every link on the page honest and internally consistent instead of
// inventing new copy just for this page.
const SHARE_STORY_EMAIL = 'ali@vireek.com';
const SHARE_STORY_SUBJECT = 'My Vireek story';
const SHARE_STORY_HREF = `mailto:${SHARE_STORY_EMAIL}?subject=${encodeURIComponent(SHARE_STORY_SUBJECT)}`;
const RELATED_READING_SLUGS = [
  'cost-of-a-missed-call',
  'ai-receptionist-vs-answering-service',
  'ai-vendor-security-checklist',
];

// ============================================================
// CONTENT
// ============================================================
//
// This page reuses CASE_STUDIES from src/components/sections/CaseStudies.tsx
// — the same single source of truth already used on the homepage and on
// CaseStudiesPage.tsx — instead of introducing new quotes here. Per the
// "Radical Transparency" value stated on the About page ("No fake
// testimonials, invented customer counts, or hidden pricing claims"), do
// not add a testimonial to this page unless it is a real, attributable
// customer quote. As more verified stories come in, add them to
// CASE_STUDIES and they will automatically appear here, on the homepage,
// and on the Case Studies page.

const INDUSTRY_ICON: Record<string, typeof Droplets> = {
  Plumbing: Droplets,
  HVAC: Wind,
  Electrical: Zap,
};

const INDUSTRIES = Array.from(new Set(CASE_STUDIES.map((s) => s.industry)));

function SEO() {
  useSEO({
    title: 'Testimonials — What Contractors Say About Vireek',
    description:
      'Real quotes from early-access home service contractors using Vireek\u2019s AI voice receptionist to answer more calls and book more jobs.',
    canonical: 'https://vireek.com/testimonials',
  });

  useEffect(() => {
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      itemListElement: CASE_STUDIES.map((s, i) => ({
        '@type': 'Review',
        position: i + 1,
        itemReviewed: { '@type': 'SoftwareApplication', name: 'Vireek' },
        author: { '@type': 'Person', name: s.name },
        reviewBody: s.quote,
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

export function TestimonialsPage() {
  const [activeIndustry, setActiveIndustry] = useState<string | null>(null);

  const filtered = useMemo(
    () => CASE_STUDIES.filter((s) => !activeIndustry || s.industry === activeIndustry),
    [activeIndustry]
  );

  const relatedPosts = useMemo(
    () =>
      RELATED_READING_SLUGS.map((slug) => BLOG_POSTS.find((p) => p.slug === slug)).filter(
        (p): p is (typeof BLOG_POSTS)[number] => Boolean(p)
      ),
    []
  );

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
                  <Star className="h-4 w-4 text-accent" />
                  Testimonials
                </div>
                <h1 className="text-balance text-5xl font-extrabold tracking-tight text-text-primary sm:text-6xl lg:text-7xl">
                  What contractors are saying
                </h1>
                <p className="mx-auto mt-6 max-w-3xl text-xl leading-8 text-text-secondary sm:text-2xl">
                  Illustrative examples of the kind of results home service businesses can expect from Sarah
                  answering calls and booking jobs they used to lose.
                </p>

                {/* Industry filters */}
                <div className="mx-auto mt-10 flex max-w-3xl flex-wrap items-center justify-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setActiveIndustry(null)}
                    className={`focus-ring inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold transition-all duration-200 ease-out ${
                      activeIndustry === null
                        ? 'border-accent/40 bg-accent/10 text-accent'
                        : 'border-border bg-bg-secondary/80 text-text-secondary hover:border-accent/30 hover:text-text-primary'
                    }`}
                  >
                    All industries
                  </button>
                  {INDUSTRIES.map((industry) => {
                    const Icon = INDUSTRY_ICON[industry] ?? Sparkles;
                    const isActive = activeIndustry === industry;
                    return (
                      <button
                        key={industry}
                        type="button"
                        onClick={() => setActiveIndustry(isActive ? null : industry)}
                        className={`focus-ring inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold transition-all duration-200 ease-out ${
                          isActive
                            ? 'border-accent/40 bg-accent/10 text-accent'
                            : 'border-border bg-bg-secondary/80 text-text-secondary hover:border-accent/30 hover:text-text-primary'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {industry}
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Testimonial cards */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-7xl">
            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
            >
              {filtered.map((t) => {
                const Icon = INDUSTRY_ICON[t.industry] ?? Sparkles;
                return (
                  <motion.div
                    key={t.slug}
                    variants={fadeUpItem}
                    transition={{ duration: 0.5, ease: EASE }}
                    className="flex h-full flex-col rounded-2xl border border-border bg-bg-secondary p-7 shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:border-accent/25 dark:shadow-card-dark"
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="text-xs font-semibold uppercase tracking-wider text-accent">{t.industry}</span>
                    </div>
                    <Quote size={24} className="mt-4 text-accent/30" />
                    <p className="mt-3 flex-1 text-base leading-relaxed text-text-primary">&ldquo;{t.quote}&rdquo;</p>
                    <div className="mt-6 flex items-center gap-3 border-t border-border/60 pt-4">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-bold text-accent">
                        {t.initials}
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-text-primary">{t.name}</p>
                        <p className="text-xs text-text-secondary">{t.business}</p>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-success/10 px-3 py-2">
                      <TrendingUp size={14} className="text-success" />
                      <span className="text-xs font-semibold text-success">{t.result}</span>
                    </div>
                    <Link
                      to={`/case-studies#${t.slug}`}
                      className="focus-ring mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-accent transition-colors hover:text-accent/80"
                    >
                      Read the full story <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </motion.div>
                );
              })}
            </motion.div>
          </div>
        </section>

        {/* Transparency note */}
        <section className="px-6 pb-4">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="mx-auto flex max-w-4xl items-start gap-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
              <Eye className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-text-primary">Radical transparency</p>
              <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
                These are early-access partner stories from real home service businesses using Vireek during our
                founding contractor program — not composite or hypothetical examples. We don&apos;t publish invented
                testimonials, customer counts, or results. As our customer base grows, this page will be updated
                with more verified stories.
              </p>
            </div>
          </motion.div>
        </section>

        {/* Share your story */}
        <section className="px-6 pb-4 pt-12 sm:pt-16">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="mx-auto flex max-w-4xl flex-col items-center gap-5 rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:flex-row sm:text-left"
          >
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
              <Mail className="h-5 w-5" />
            </span>
            <div className="flex-1">
              <p className="text-base font-semibold text-text-primary">Are you a Vireek customer?</p>
              <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
                Send us your story — a couple of sentences on what changed, and a photo of you or
                your crew if you'd like one included. We read every one and add real, verified
                stories here and to our case studies.
              </p>
            </div>
            <a href={SHARE_STORY_HREF} className="shrink-0">
              <Button variant="secondary" size="md">
                Share your story <ArrowRight size={16} />
              </Button>
            </a>
          </motion.div>
        </section>

        {/* Related reading */}
        {relatedPosts.length > 0 && (
          <section className="px-6 py-16 sm:py-20">
            <div className="mx-auto max-w-7xl">
              <motion.div
                initial={{ opacity: 0, y: 14 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, ease: EASE }}
                className="flex items-end justify-between gap-4"
              >
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">More proof, less guesswork</p>
                  <h2 className="mt-3 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
                    Related reading
                  </h2>
                </div>
                <Link
                  to="/blog"
                  className="focus-ring hidden shrink-0 items-center gap-1.5 text-sm font-semibold text-accent transition-colors hover:text-accent/80 sm:inline-flex"
                >
                  Visit the blog <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </motion.div>

              <motion.div
                variants={staggerContainer}
                initial="initial"
                whileInView="whileInView"
                viewport={viewport}
                className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
              >
                {relatedPosts.map((post) => {
                  const category = getCategoryBySlug(post.category);
                  const Icon = category?.icon ?? BookOpen;
                  return (
                    <motion.div key={post.slug} variants={fadeUpItem} transition={{ duration: 0.5, ease: EASE }}>
                      <Link to={`/blog/${post.slug}`} className="focus-ring block h-full rounded-2xl">
                        <div className="flex h-full flex-col rounded-2xl border border-border bg-bg-secondary p-6 shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:border-accent/25 dark:shadow-card-dark">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
                            <Icon className="h-4 w-4" />
                          </span>
                          <span className="mt-3 text-xs font-semibold uppercase tracking-wider text-accent">
                            {category?.name ?? 'Resources'}
                          </span>
                          <h3 className="mt-2 text-lg font-bold leading-snug tracking-tight text-text-primary">
                            {post.title}
                          </h3>
                          <p className="mt-2.5 flex-1 text-sm leading-relaxed text-text-secondary">{post.excerpt}</p>
                          <span className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-accent">
                            Read article <ArrowRight className="h-3.5 w-3.5" />
                          </span>
                        </div>
                      </Link>
                    </motion.div>
                  );
                })}
              </motion.div>

              <div className="mt-8 flex justify-center sm:hidden">
                <Link
                  to="/blog"
                  className="focus-ring inline-flex items-center gap-1.5 text-sm font-semibold text-accent transition-colors hover:text-accent/80"
                >
                  Visit the blog <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>
          </section>
        )}

        {/* Share your story CTA */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Already a Vireek customer?</p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Share your story
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary">
              If Sarah has helped your business catch a job you would have otherwise lost, we&apos;d love to feature
              your story here.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link to="/contact">
                <Button variant="primary" size="lg">
                  Get in Touch
                </Button>
              </Link>
              <Link
                to="/case-studies"
                className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
              >
                See full case studies <ArrowRight className="h-4 w-4" />
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
