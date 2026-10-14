import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Search,
  ChevronDown,
  ArrowRight,
  Mail,
  Phone,
  MessageCircle,
  PhoneCall,
  ShieldCheck,
  BookOpen,
  Sparkles,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { CookieConsent } from '@/components/CookieConsent';
import { BackButton } from '@/components/ui/BackButton';
import { EASE, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { SARAH_PHONE } from '@/lib/site';
import { INDUSTRIES } from '@/lib/industries';
import { HELP_CATEGORIES } from '@/lib/helpContent';
import { getHelpArticleSlug } from '@/lib/helpArticles';

/* ------------------------------------------------------------------ */
/*  Content — categories & articles live in @/lib/helpContent          */
/* ------------------------------------------------------------------ */

const SUPPORT_EMAIL = 'ali@vireek.com';
const PHONE_DISPLAY = '+1 (650) 910-6703';

const QUICK_LINKS = [
  { label: 'Read the FAQ', href: '/faq', icon: BookOpen },
  { label: 'Book a Demo', href: '/demo', icon: PhoneCall },
  { label: 'Security overview', href: '/security', icon: ShieldCheck },
  { label: 'Contact support', href: '/contact', icon: MessageCircle },
] as const;

/* ------------------------------------------------------------------ */
/*  SEO + structured data                                              */
/* ------------------------------------------------------------------ */

function buildHelpSchema() {
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: HELP_CATEGORIES.flatMap((category) =>
      category.articles.map((article) => ({
        '@type': 'Question',
        name: article.q,
        acceptedAnswer: {
          '@type': 'Answer',
          text: article.a,
        },
      }))
    ),
  };

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://vireek.com/' },
      { '@type': 'ListItem', position: 2, name: 'Help Center', item: 'https://vireek.com/help' },
    ],
  };

  return [faqSchema, breadcrumbSchema];
}

function SEO() {
  useSEO({
    title: 'Help Center — Vireek Docs & Support',
    description:
      'Find answers about Vireek setup, call handling, billing, integrations, notifications, security, and troubleshooting — or reach our support team directly.',
    canonical: 'https://vireek.com/help',
  });

  useEffect(() => {
    const scripts = buildHelpSchema().map((schema) => {
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.text = JSON.stringify(schema);
      document.head.appendChild(script);
      return script;
    });
    return () => {
      scripts.forEach((script) => script.remove());
    };
  }, []);

  return null;
}

/* ------------------------------------------------------------------ */
/*  Article accordion item                                             */
/* ------------------------------------------------------------------ */

function HelpArticleItem({
  question,
  answer,
  href,
  id,
  isOpen,
  onToggle,
}: {
  question: string;
  answer: string;
  href?: string;
  id: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const panelId = `${id}-panel`;
  const buttonId = `${id}-button`;

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary/90 shadow-card transition-colors dark:shadow-card-dark">
      <h3>
        <button
          id={buttonId}
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className="focus-ring flex w-full items-center justify-between gap-5 rounded-2xl px-5 py-5 text-left sm:px-6"
        >
          <span className="text-base font-semibold leading-7 text-text-primary sm:text-lg">{question}</span>
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-colors ${
              isOpen ? 'border-accent/30 bg-accent/10 text-accent' : 'border-border bg-bg-tertiary text-text-secondary'
            }`}
          >
            <ChevronDown className={`h-5 w-5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
          </span>
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id={panelId}
            role="region"
            aria-labelledby={buttonId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: EASE }}
            className="overflow-hidden"
          >
            <p className="px-5 pb-3 text-base leading-8 text-text-secondary sm:px-6">{answer}</p>
            {href && (
              <Link
                to={href}
                className="focus-ring mx-5 mb-5 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-accent hover:underline sm:mx-6"
              >
                Open full article <ArrowRight className="h-4 w-4" />
              </Link>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main page                                                           */
/* ------------------------------------------------------------------ */

export function HelpCenterPage() {
  const [query, setQuery] = useState('');
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>(HELP_CATEGORIES[0].id);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredCategories = useMemo(() => {
    if (!normalizedQuery) return HELP_CATEGORIES;

    return HELP_CATEGORIES.map((category) => ({
      ...category,
      articles: category.articles.filter(
        (article) =>
          article.q.toLowerCase().includes(normalizedQuery) ||
          article.a.toLowerCase().includes(normalizedQuery) ||
          category.name.toLowerCase().includes(normalizedQuery)
      ),
    })).filter((category) => category.articles.length > 0);
  }, [normalizedQuery]);

  const totalResults = useMemo(
    () => filteredCategories.reduce((sum, category) => sum + category.articles.length, 0),
    [filteredCategories]
  );

  const scrollToCategory = (id: string) => {
    setActiveCategory(id);
    const el = document.getElementById(id);
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - 104;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  };

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero + search */}
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
                  Help Center &amp; Docs
                </div>
                <h1 className="text-balance text-5xl font-extrabold tracking-tight text-text-primary sm:text-6xl lg:text-7xl">
                  How can we help?
                </h1>
                <p className="mx-auto mt-6 max-w-3xl text-xl leading-8 text-text-secondary sm:text-2xl">
                  Search setup guides, dashboard how-tos, billing answers, and security details — or reach our team
                  directly.
                </p>

                {/* Search */}
                <div className="mx-auto mt-10 max-w-2xl">
                  <div className="group relative flex items-center rounded-2xl border border-border bg-bg-secondary shadow-card transition-colors focus-within:border-accent/50 dark:shadow-card-dark">
                    <Search className="ml-5 h-5 w-5 shrink-0 text-text-secondary/60 group-focus-within:text-accent" />
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search for call forwarding, billing, notifications…"
                      aria-label="Search the Help Center"
                      className="w-full bg-transparent py-4 pl-3 pr-5 text-base text-text-primary placeholder:text-text-secondary/50 focus:outline-none"
                    />
                  </div>
                  {normalizedQuery && (
                    <p className="mt-3 text-sm text-text-secondary" role="status">
                      {totalResults > 0
                        ? `${totalResults} article${totalResults === 1 ? '' : 's'} matching "${query.trim()}"`
                        : `No articles matching "${query.trim()}" — try a different term or contact support below.`}
                    </p>
                  )}
                </div>

                {/* Quick links */}
                <div className="mx-auto mt-8 flex max-w-3xl flex-wrap items-center justify-center gap-3">
                  {QUICK_LINKS.map(({ label, href, icon: Icon }) => (
                    <Link
                      key={href}
                      to={href}
                      className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary/80 px-4 py-2.5 text-sm font-semibold text-text-secondary backdrop-blur transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:text-accent"
                    >
                      <Icon className="h-4 w-4" />
                      {label}
                    </Link>
                  ))}
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Category nav + articles */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.85fr_1.5fr]">
            <aside className="lg:sticky lg:top-28 lg:self-start">
              <div className="rounded-3xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Browse by topic</p>
                <h2 className="mt-3 text-2xl font-bold tracking-tight text-text-primary">Jump to a category</h2>
                <nav className="mt-6 flex flex-col gap-1.5" aria-label="Help Center categories">
                  {HELP_CATEGORIES.map((category) => {
                    const Icon = category.icon;
                    const isActive = activeCategory === category.id && !normalizedQuery;
                    return (
                      <button
                        key={category.id}
                        type="button"
                        onClick={() => scrollToCategory(category.id)}
                        className={`focus-ring flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors ${
                          isActive
                            ? 'bg-accent/10 text-accent'
                            : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                        }`}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {category.name}
                      </button>
                    );
                  })}
                </nav>
                <div className="mt-6 border-t border-border pt-6">
                  <p className="text-sm font-semibold text-text-primary">Still stuck?</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">
                    Our team typically replies within one business day.
                  </p>
                  <a
                    href={`mailto:${SUPPORT_EMAIL}`}
                    className="focus-ring mt-4 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline"
                  >
                    <Mail className="h-4 w-4" />
                    {SUPPORT_EMAIL}
                  </a>
                </div>
              </div>
            </aside>

            <div className="space-y-10">
              {filteredCategories.length === 0 && (
                <div className="rounded-3xl border border-border bg-bg-secondary p-10 text-center shadow-card dark:shadow-card-dark">
                  <p className="text-lg font-semibold text-text-primary">No matching articles</p>
                  <p className="mt-2 text-text-secondary">
                    Try a shorter search term, or{' '}
                    <Link to="/contact" className="text-accent hover:underline">
                      contact support
                    </Link>{' '}
                    directly.
                  </p>
                </div>
              )}

              {filteredCategories.map((category, categoryIndex) => {
                const Icon = category.icon;
                return (
                  <motion.section
                    key={category.id}
                    id={category.id}
                    initial={{ opacity: 0, y: 18 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={viewport}
                    transition={{ duration: 0.45, ease: EASE, delay: Math.min(categoryIndex * 0.06, 0.24) }}
                    className="scroll-mt-28"
                  >
                    <div className="mb-5 flex items-start gap-4">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <h2 className="text-2xl font-bold tracking-tight text-text-primary">{category.name}</h2>
                        <p className="mt-1 text-base leading-7 text-text-secondary">{category.description}</p>
                      </div>
                    </div>
                    <div className="space-y-4">
                      {category.articles.map((article, articleIndex) => {
                        const id = `${category.id}-${articleIndex}`;
                        const slug = getHelpArticleSlug(article);
                        return (
                          <HelpArticleItem
                            key={article.q}
                            id={id}
                            question={article.q}
                            answer={article.a}
                            href={slug ? `/help/${slug}` : undefined}
                            isOpen={openItem === id}
                            onToggle={() => setOpenItem(openItem === id ? null : id)}
                          />
                        );
                      })}
                    </div>
                  </motion.section>
                );
              })}
            </div>
          </div>
        </section>

        {/* Industry-specific guides */}
        <section className="px-6 pb-4 pt-4">
          <div className="mx-auto max-w-7xl rounded-[2rem] border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark sm:p-10">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">By industry</p>
            <h2 className="mt-3 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
              Looking for trade-specific guidance?
            </h2>
            <p className="mt-3 max-w-2xl text-base leading-7 text-text-secondary">
              Each industry page covers the exact call scenarios, qualifying questions, and setup tips for that trade.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {INDUSTRIES.map((industry) => {
                const Icon = industry.icon;
                return (
                  <Link
                    key={industry.slug}
                    to={`/industries/${industry.slug}`}
                    className="focus-ring group flex items-center gap-3 rounded-xl border border-border bg-bg-tertiary/60 p-4 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/20 bg-accent/10 text-accent">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-text-primary">{industry.name}</span>
                      <span className="block truncate text-xs text-text-secondary">{industry.tagline}</span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-text-secondary/30 transition-all group-hover:translate-x-0.5 group-hover:text-accent" />
                  </Link>
                );
              })}
            </div>
          </div>
        </section>

        {/* Contact support CTA */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Can&apos;t find your answer?</p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Talk to a real person on our team.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary">
              Email, call, or send us a message — we&apos;ll help you get Sarah set up and answering calls correctly.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link to="/contact">
                <Button variant="primary" size="lg">
                  Contact Support
                </Button>
              </Link>
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
              >
                <Mail className="h-4 w-4" />
                {SUPPORT_EMAIL}
              </a>
              <a
                href={SARAH_PHONE}
                className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
              >
                <Phone className="h-4 w-4" />
                {PHONE_DISPLAY}
              </a>
            </div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
