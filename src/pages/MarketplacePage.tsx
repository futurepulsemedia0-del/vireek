import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Mail, ShieldCheck, Store } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { useSEO } from '@/lib/seo';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { MARKETPLACE_LISTINGS, MARKETPLACE_CATEGORIES, MARKETPLACE_SUBMISSION_EMAIL } from '@/lib/marketplace';

function SEO() {
  useSEO({
    title: 'App Marketplace | Vireek',
    description:
      'Browse apps and integrations built for Vireek by our team and by partners, and list your own app in the Vireek Marketplace.',
    canonical: 'https://vireek.com/marketplace',
  });
  return null;
}

export function MarketplacePage() {
  const [activeCategory, setActiveCategory] = useState('All');

  const visibleListings = useMemo(
    () =>
      activeCategory === 'All'
        ? MARKETPLACE_LISTINGS
        : MARKETPLACE_LISTINGS.filter((listing) => listing.category === activeCategory),
    [activeCategory],
  );

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-20 sm:pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-5 py-16 sm:px-6 sm:py-20 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <BackButton />
            </div>
            <div className="text-center">
              <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
                <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-3 py-1.5 text-xs font-semibold text-text-secondary shadow-sm backdrop-blur sm:mb-6 sm:px-4 sm:text-sm">
                  <Store className="h-4 w-4 text-accent" />
                  Marketplace
                </div>
                <h1 className="text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl lg:text-6xl">
                  Apps Built for Vireek
                </h1>
                <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary sm:mt-6 sm:text-lg sm:leading-8 lg:text-xl">
                  Browse apps and integrations built by our team and by partners. Every listing is
                  reviewed before it ships — building something worth listing?{' '}
                  <a
                    href={`mailto:${MARKETPLACE_SUBMISSION_EMAIL}?subject=${encodeURIComponent('Marketplace app submission')}`}
                    className="font-semibold text-accent hover:text-cta"
                  >
                    Submit your app
                  </a>
                  .
                </p>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Filters + grid */}
        <section className="px-5 py-16 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-7xl">
            <div className="flex flex-wrap items-center justify-center gap-2.5">
              {MARKETPLACE_CATEGORIES.map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => setActiveCategory(category)}
                  className={`focus-ring rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
                    activeCategory === category
                      ? 'border-accent bg-accent text-white'
                      : 'border-border bg-bg-secondary text-text-secondary hover:border-accent/40 hover:text-text-primary'
                  }`}
                >
                  {category}
                </button>
              ))}
            </div>

            <motion.div
              key={activeCategory}
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
            >
              {visibleListings.map((listing) => {
                const Icon = listing.icon;
                const content = (
                  <Card className="h-full">
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                        <Icon size={22} />
                      </span>
                      {listing.kind === 'first_party' ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-tertiary px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
                          <ShieldCheck size={12} /> Built by Vireek
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-border bg-bg-tertiary px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
                          By {listing.developer}
                        </span>
                      )}
                    </div>
                    <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-text-secondary/70">
                      {listing.category}
                    </p>
                    <h3 className="mt-1.5 text-lg font-semibold text-text-primary">{listing.name}</h3>
                    <p className="mt-3 text-sm leading-relaxed text-text-secondary">{listing.tagline}</p>
                    <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
                      {listing.href ? 'View listing' : 'Visit site'}
                      {listing.href ? <ArrowRight className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                    </span>
                  </Card>
                );

                return (
                  <motion.div key={listing.slug} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                    {listing.href ? (
                      <Link to={listing.href} className="block h-full">
                        {content}
                      </Link>
                    ) : (
                      <a href={listing.externalUrl} target="_blank" rel="noopener noreferrer" className="block h-full">
                        {content}
                      </a>
                    )}
                  </motion.div>
                );
              })}
            </motion.div>

            {visibleListings.length === 0 && (
              <p className="mt-16 text-center text-sm text-text-secondary">
                No listings in this category yet.
              </p>
            )}
          </div>
        </section>

        {/* Submit an app CTA */}
        <section className="px-5 pb-24 sm:px-6">
          <div className="mx-auto max-w-4xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className={eyebrowClass()}>For partners</p>
            <h2 className={`${sectionHeadingClass()} mt-3`}>List your app in the Vireek Marketplace</h2>
            <p className={`${bodyClass()} mx-auto mt-4 max-w-xl`}>
              Built something that connects to Vireek? Tell us what it does and who it's for. Every
              submission is reviewed by our team before it goes live — there's no self-serve
              publishing yet, so a real person will get back to you.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <a href={`mailto:${MARKETPLACE_SUBMISSION_EMAIL}?subject=${encodeURIComponent('Marketplace app submission')}`}>
                <Button variant="primary" size="lg">
                  <Mail className="h-4 w-4" /> Submit Your App
                </Button>
              </a>
              <Link to="/docs">
                <Button variant="secondary" size="lg">
                  Read the API Docs <ArrowRight className="h-4 w-4" />
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
