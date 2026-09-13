import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Webhook, Package, Zap, AlertTriangle, ArrowRight, Mail } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { useSEO } from '@/lib/seo';
import { EASE, viewport } from '@/lib/motion';
import { DEVELOPER_CHANGELOG_RELEASES, type DeveloperEntryType } from '@/lib/developerChangelog';

const TYPE_META: Record<DeveloperEntryType, { label: string; icon: typeof Zap; text: string; ring: string }> = {
  api: { label: 'API', icon: Zap, text: 'text-accent', ring: 'border-accent/25 bg-accent/10' },
  sdk: { label: 'SDK', icon: Package, text: 'text-success-500', ring: 'border-success-500/25 bg-success-500/10' },
  webhook: { label: 'Webhook', icon: Webhook, text: 'text-warning-500', ring: 'border-warning-500/25 bg-warning-500/10' },
  breaking: { label: 'Breaking Change', icon: AlertTriangle, text: 'text-danger', ring: 'border-danger/25 bg-danger/10' },
};

const EMAIL = 'ali@vireek.com';

function SEO() {
  useSEO({
    title: 'Developer Changelog — API, SDK & Webhook Updates | Vireek',
    description:
      'Release notes for the Vireek API, official SDKs, and webhooks — separate from the product changelog, for people integrating with Vireek programmatically.',
    canonical: 'https://vireek.com/developers/changelog',
  });
  return null;
}

export function DeveloperChangelogPage() {
  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-8 flex justify-center">
              <BackButton />
            </div>
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <Zap className="h-4 w-4 text-accent" />
                Developer Changelog
              </div>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                API, SDK &amp; Webhook Updates
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-lg leading-8 text-text-secondary">
                Everything that ships to the API, the official SDKs, and webhook payloads —
                separate from the{' '}
                <Link to="/changelog" className="font-semibold text-accent hover:text-cta">
                  product changelog
                </Link>
                . Breaking changes are always called out explicitly.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Timeline */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl">
            {DEVELOPER_CHANGELOG_RELEASES.length === 0 ? (
              <p className="text-center text-sm text-text-secondary">Nothing shipped yet — check back soon.</p>
            ) : (
              <ol className="relative space-y-12 border-s border-border ps-8 sm:ps-10">
                {DEVELOPER_CHANGELOG_RELEASES.map((release, ri) => (
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
            )}
          </div>
        </section>

        {/* CTA */}
        <section className="px-6 pb-24">
          <div className="mx-auto max-w-4xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <h2 className="text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Building on the API?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-text-secondary">
              Get notified the moment something changes that affects your integration.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <a href={`mailto:${EMAIL}?subject=${encodeURIComponent('Subscribe to Vireek developer changelog')}`}>
                <Button variant="primary" size="lg">
                  <Mail className="h-4 w-4" /> Get Notified
                </Button>
              </a>
              <Link to="/sdks">
                <Button variant="secondary" size="lg">
                  See the SDKs <ArrowRight className="h-4 w-4" />
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
