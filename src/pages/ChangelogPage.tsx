import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Sparkles,
  Zap,
  ShieldCheck,
  Wrench,
  ArrowRight,
  Mail,
  Rss,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { EASE, viewport } from '@/lib/motion';
import { CHANGELOG_RELEASES, type EntryType } from '@/lib/changelog';

const TYPE_META: Record<EntryType, { label: string; icon: typeof Sparkles; text: string; ring: string }> = {
  new: { label: 'New', icon: Sparkles, text: 'text-accent', ring: 'border-accent/25 bg-accent/10' },
  improved: { label: 'Improved', icon: Zap, text: 'text-success-500', ring: 'border-success-500/25 bg-success-500/10' },
  security: { label: 'Security', icon: ShieldCheck, text: 'text-warning-500', ring: 'border-warning-500/25 bg-warning-500/10' },
  fixed: { label: 'Fixed', icon: Wrench, text: 'text-text-secondary', ring: 'border-border bg-bg-tertiary' },
};

const EMAIL = 'ali@vireek.com';

function SEO() {
  useEffect(() => {
    const title = "Changelog \u2014 What's New | Vireek";
    const description =
      "See what's new in Vireek: new features, performance improvements, and security updates to the AI voice receptionist platform, with dates for every release.";
    const previousTitle = document.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousContent = meta?.getAttribute('content') ?? null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', description);
    document.title = title;
    return () => {
      document.title = previousTitle;
      if (previousContent === null) meta?.remove();
      else meta?.setAttribute('content', previousContent);
    };
  }, []);
  return null;
}

export function ChangelogPage() {
  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-3xl text-center">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <Sparkles className="h-4 w-4 text-accent" />
                Changelog
              </div>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                What&rsquo;s New in Vireek
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-lg leading-8 text-text-secondary">
                Every feature, improvement, and fix we ship to the platform — in plain language, with real dates.
              </p>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
              className="mt-8 flex flex-wrap items-center justify-center gap-3"
            >
              <a href={`mailto:${EMAIL}?subject=Subscribe%20to%20Vireek%20changelog`}>
                <Button variant="secondary" size="sm">
                  <Mail className="h-3.5 w-3.5" /> Get notified of new releases
                </Button>
              </a>
              <a href="/changelog-rss.xml" target="_blank" rel="noopener noreferrer">
                <Button variant="secondary" size="sm">
                  <Rss className="h-3.5 w-3.5" /> RSS feed
                </Button>
              </a>
            </motion.div>
          </div>
        </section>

        {/* Timeline */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl">
            <ol className="relative space-y-12 border-s border-border ps-8 sm:ps-10">
              {CHANGELOG_RELEASES.map((release, ri) => (
                <motion.li
                  key={release.date}
                  initial={{ opacity: 0, y: 18 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.5, ease: EASE, delay: Math.min(ri * 0.05, 0.25) }}
                  className="relative"
                >
                  <span className="absolute -start-[2.55rem] top-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-bg-primary bg-accent sm:-start-[3.05rem]" />
                  <p className="text-sm font-semibold uppercase tracking-wide text-text-secondary/80">{release.date}</p>
                  <div className="mt-4 space-y-4">
                    {release.entries.map((entry, ei) => {
                      const meta = TYPE_META[entry.type];
                      const Icon = meta.icon;
                      return (
                        <div
                          key={`${release.date}-${ei}`}
                          className="rounded-2xl border border-border bg-bg-secondary/90 p-5 shadow-card dark:shadow-card-dark sm:p-6"
                        >
                          <div className="flex flex-wrap items-center gap-2.5">
                            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${meta.ring} ${meta.text}`}>
                              <Icon className="h-3 w-3" />
                              {meta.label}
                            </span>
                            <h3 className="text-base font-semibold text-text-primary">{entry.title}</h3>
                          </div>
                          <p className="mt-2.5 text-sm leading-relaxed text-text-secondary">{entry.body}</p>
                        </div>
                      );
                    })}
                  </div>
                </motion.li>
              ))}
            </ol>

            <motion.p
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mt-12 text-center text-sm text-text-secondary/70"
            >
              That&rsquo;s everything since launch on August 21, 2026. Have a feature request?{' '}
              <Link to="/roadmap" className="font-semibold text-accent hover:text-cta">
                Vote on the roadmap
              </Link>
.
              .
            </motion.p>
          </div>
        </section>

        {/* CTA */}
        <section className="px-6 pb-24">
          <div className="mx-auto max-w-4xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Shape what ships next</p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Missing something you need?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-text-secondary">
              Vireek is being built alongside the contractors using it. Tell us what would make the biggest
              difference for your business.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <a href={`mailto:${EMAIL}`}>
                <Button variant="primary" size="lg">
                  <Mail className="h-4 w-4" /> Email Your Idea
                </Button>
              </a>
              <Link to="/demo">
                <Button variant="secondary" size="lg">
                  Book a Demo <ArrowRight className="h-4 w-4" />
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
