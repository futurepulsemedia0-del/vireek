import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowRight, Plug, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { useSEO } from '@/lib/seo';
import { EASE, eyebrowClass, sectionHeadingClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { INTEGRATIONS } from '@/lib/integrations';

export function IntegrationsHubPage() {
  useSEO({
    title: 'Integrations | Vireek',
    description:
      'Connect Vireek to QuickBooks, Google Calendar, Stripe, and Zapier. Keep your books, calendar, billing, and other tools in sync with every call Sarah answers.',
    canonical: 'https://vireek.com/integrations',
  });

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-20 sm:pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-5 py-16 sm:px-6 sm:py-20 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl text-center">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-3 py-1.5 text-xs font-semibold text-text-secondary shadow-sm backdrop-blur sm:mb-6 sm:px-4 sm:text-sm">
                <Plug className="h-4 w-4 text-accent" />
                Integrations
              </div>
              <h1 className="text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl lg:text-6xl">
                Vireek Fits Into The Tools You Already Use
              </h1>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary sm:mt-6 sm:text-lg sm:leading-8 lg:text-xl">
                Connect your accounting, calendar, billing, and automation tools so every call Sarah
                answers turns into clean, synced data — with no manual re-entry.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:mt-10 sm:flex-row sm:gap-4">
                <Link to="/login" className="w-full sm:w-auto">
                  <Button variant="primary" size="lg" className="w-full sm:w-auto">
                    Start Free Trial
                  </Button>
                </Link>
                <Link
                  to="/trust"
                  className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent sm:w-auto"
                >
                  <ShieldCheck className="h-4 w-4" /> Visit our Trust Center
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Integration cards */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>Available Now</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>Connect Your Stack</h2>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-8 grid gap-5 sm:mt-12 sm:grid-cols-2"
            >
              {INTEGRATIONS.map((integration) => {
                const Icon = integration.icon;
                return (
                  <motion.div key={integration.slug} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                    <Link
                      to={`/integrations/${integration.slug}`}
                      className="focus-ring group flex h-full flex-col rounded-2xl border border-border bg-bg-secondary p-6 shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-card-hover dark:shadow-card-dark sm:p-7"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                          <Icon className="h-5 w-5" />
                        </span>
                        <span className="rounded-full border border-border bg-bg-tertiary px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-wider text-text-secondary">
                          {integration.category}
                        </span>
                      </div>
                      <h3 className="mt-4 text-lg font-bold text-text-primary sm:text-xl">{integration.name}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-text-secondary">{integration.tagline}</p>
                      <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
                        See how it works
                        <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                      </span>
                    </Link>
                  </motion.div>
                );
              })}
            </motion.div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-5 pb-16 sm:px-6 sm:pb-24">
          <div className="relative mx-auto max-w-5xl overflow-hidden rounded-2xl border border-accent/30 bg-bg-secondary p-6 text-center shadow-card dark:shadow-card-dark sm:rounded-3xl sm:p-12">
            <div className="absolute inset-0 -z-10 bg-gradient-to-br from-accent/[0.04] via-transparent to-cta/[0.04]" />
            <h2 className="text-2xl font-bold tracking-tight text-text-primary sm:text-3xl md:text-4xl">
              Don&rsquo;t see the tool you use?
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-text-secondary sm:text-base">
              Zapier alone connects Vireek to thousands of other apps. Reach out and we&rsquo;ll help you
              wire up the rest.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
              <Link to="/contact" className="w-full sm:w-auto">
                <Button variant="primary" size="lg" className="w-full sm:w-auto">
                  Talk to Us
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
