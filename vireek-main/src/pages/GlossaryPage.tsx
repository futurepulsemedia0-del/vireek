import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, ArrowUpRight, BookOpen, Search, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { GLOSSARY_CATEGORIES, GLOSSARY_TERMS, getCategoryBySlug, getSortedTerms, type GlossaryTerm } from '@/lib/glossary';

function SEO() {
  useSEO({
    title: 'Glossary — AI Voice Receptionist & Home Service Terms | Vireek',
    description:
      'A complete glossary of AI voice, call handling, home service industry, CRM, and security terms — explained in plain language by the Vireek team.',
    canonical: 'https://vireek.com/glossary',
  });

  useEffect(() => {
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'DefinedTermSet',
      name: 'Vireek Glossary',
      url: 'https://vireek.com/glossary',
      hasDefinedTerm: GLOSSARY_TERMS.map((t) => ({
        '@type': 'DefinedTerm',
        name: t.term,
        description: t.definition,
        url: `https://vireek.com/glossary#${t.slug}`,
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

function TermCard({ term, index }: { term: GlossaryTerm; index: number }) {
  const category = getCategoryBySlug(term.category);
  const Icon = category?.icon ?? Sparkles;

  return (
    <motion.div
      id={term.slug}
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewport}
      transition={{ duration: 0.4, ease: EASE, delay: Math.min(index * 0.02, 0.2) }}
      className="scroll-mt-28"
    >
      <Card className="flex h-full flex-col p-6 hover:-translate-y-0">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
            <Icon className="h-4 w-4" />
          </span>
          <span className="text-xs font-semibold uppercase tracking-wider text-accent">
            {category?.name ?? 'Glossary'}
          </span>
        </div>
        <h3 className="mt-4 text-lg font-bold leading-snug tracking-tight text-text-primary">{term.term}</h3>
        <p className="mt-2.5 flex-1 text-sm leading-relaxed text-text-secondary">{term.definition}</p>
        {term.relatedLinks && term.relatedLinks.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
            {term.relatedLinks.map((link) => (
              <Link
                key={link.href}
                to={link.href}
                className="focus-ring inline-flex items-center gap-1 rounded-full border border-border bg-bg-tertiary px-3 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:border-accent/30 hover:text-accent"
              >
                {link.label}
                <ArrowUpRight className="h-3 w-3" />
              </Link>
            ))}
          </div>
        )}
      </Card>
    </motion.div>
  );
}

export function GlossaryPage() {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const sortedTerms = useMemo(() => getSortedTerms(), []);
  const normalizedQuery = query.trim().toLowerCase();

  const filteredTerms = useMemo(() => {
    return sortedTerms.filter((term) => {
      const matchesCategory = !activeCategory || term.category === activeCategory;
      const matchesQuery =
        !normalizedQuery ||
        term.term.toLowerCase().includes(normalizedQuery) ||
        term.definition.toLowerCase().includes(normalizedQuery);
      return matchesCategory && matchesQuery;
    });
  }, [sortedTerms, normalizedQuery, activeCategory]);

  const availableLetters = useMemo(() => {
    const letters = new Set(filteredTerms.map((t) => t.term[0].toUpperCase()));
    return Array.from(letters).sort();
  }, [filteredTerms]);

  const groupedByLetter = useMemo(() => {
    const groups = new Map<string, GlossaryTerm[]>();
    for (const term of filteredTerms) {
      const letter = term.term[0].toUpperCase();
      const list = groups.get(letter) ?? [];
      list.push(term);
      groups.set(letter, list);
    }
    return groups;
  }, [filteredTerms]);

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
                  <BookOpen className="h-4 w-4 text-accent" />
                  Vireek Glossary
                </div>
                <h1 className="text-balance text-5xl font-extrabold tracking-tight text-text-primary sm:text-6xl lg:text-7xl">
                  Every term, explained in plain language
                </h1>
                <p className="mx-auto mt-6 max-w-3xl text-xl leading-8 text-text-secondary sm:text-2xl">
                  AI voice technology, call handling, home service operations, CRM integrations, and security —
                  {' '}{GLOSSARY_TERMS.length} terms, written for business owners, not engineers.
                </p>

                {/* Search */}
                <div className="mx-auto mt-10 max-w-2xl">
                  <div className="group relative flex items-center rounded-2xl border border-border bg-bg-secondary shadow-card transition-colors focus-within:border-accent/50 dark:shadow-card-dark">
                    <Search className="ml-5 h-5 w-5 shrink-0 text-text-secondary/60 group-focus-within:text-accent" />
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search terms…"
                      aria-label="Search the glossary"
                      className="w-full bg-transparent py-4 pl-3 pr-5 text-base text-text-primary placeholder:text-text-secondary/50 focus:outline-none"
                    />
                  </div>
                </div>

                {/* Category filters */}
                <div className="mx-auto mt-8 flex max-w-4xl flex-wrap items-center justify-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setActiveCategory(null)}
                    className={`focus-ring inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold transition-all duration-200 ease-out ${
                      activeCategory === null
                        ? 'border-accent/40 bg-accent/10 text-accent'
                        : 'border-border bg-bg-secondary/80 text-text-secondary hover:border-accent/30 hover:text-text-primary'
                    }`}
                  >
                    All terms
                  </button>
                  {GLOSSARY_CATEGORIES.map((category) => {
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

        {/* A–Z jump nav */}
        {availableLetters.length > 0 && (
          <section className="sticky top-20 z-30 border-y border-border bg-bg-primary/95 px-6 py-3 backdrop-blur sm:top-24">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-1.5">
              {availableLetters.map((letter) => (
                <a
                  key={letter}
                  href={`#letter-${letter}`}
                  className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold text-text-secondary transition-colors hover:bg-accent/10 hover:text-accent"
                >
                  {letter}
                </a>
              ))}
            </div>
          </section>
        )}

        {/* Terms */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-7xl">
            {filteredTerms.length === 0 ? (
              <div className="rounded-3xl border border-border bg-bg-secondary p-10 text-center shadow-card dark:shadow-card-dark">
                <p className="text-lg font-semibold text-text-primary">No terms found</p>
                <p className="mt-2 text-text-secondary">Try a different search term or category.</p>
              </div>
            ) : (
              <div className="space-y-14">
                {Array.from(groupedByLetter.entries()).map(([letter, terms]) => (
                  <div key={letter} id={`letter-${letter}`} className="scroll-mt-32">
                    <div className="mb-6 flex items-center gap-4">
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-lg font-extrabold text-accent">
                        {letter}
                      </span>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                      {terms.map((term, index) => (
                        <TermCard key={term.slug} term={term} index={index} />
                      ))}
                    </div>
                  </div>
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
              See these terms in action.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary">
              Launch Vireek to answer calls, qualify demand, and help your team follow up with confidence.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link to="/login">
                <Button variant="primary" size="lg">
                  Start Free Trial
                </Button>
              </Link>
              <Link
                to="/blog"
                className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
              >
                Read the blog <ArrowRight className="h-4 w-4" />
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
