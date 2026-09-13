import { motion } from 'framer-motion';
import { ArrowRight, ShieldCheck, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { SWITCH_GUIDES } from '@/lib/switchGuides';

export function SwitchGuidesPage() {
  useSEO({
    title: 'Switching to Vireek: Step-by-Step Guides | Vireek',
    description:
      'Moving from voicemail, a live answering service, or bringing your existing customer data over from a platform like ServiceTitan? See exactly what switching to Vireek involves, step by step.',
    canonical: 'https://vireek.com/switch',
  });

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <BackButton />
            </div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>Switching Guides</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Exactly What It Takes to Switch
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                No vague "reach out and we'll figure it out." Pick what you're switching from below and see
                the actual steps &mdash; what carries over, what changes, and how long it really takes.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/login">
                  <Button variant="primary" size="lg">Start Free Trial</Button>
                </Link>
                <Link
                  to="/compare"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  See full comparisons
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Guides grid */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={eyebrowClass()}>Find Your Starting Point</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>What are you switching from?</h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                Every path keeps your existing business number and works at your own pace.
              </p>
            </motion.div>

            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {SWITCH_GUIDES.map((guide, index) => (
                <motion.div
                  key={guide.slug}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.45, delay: index * 0.08, ease: EASE }}
                >
                  <Link
                    to={`/switch/${guide.slug}`}
                    className="group flex h-full flex-col justify-between gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
                  >
                    <div className="flex items-start gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-tertiary text-text-secondary transition-colors group-hover:border-accent/30 group-hover:bg-accent/10 group-hover:text-accent">
                        <guide.icon size={18} />
                      </span>
                      <span>
                        <span className="block text-sm font-semibold text-text-primary">
                          From {guide.fromName}
                        </span>
                        <span className="mt-0.5 block text-xs text-text-secondary">{guide.category}</span>
                      </span>
                    </div>
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-accent">
                      See the guide
                      <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                </motion.div>
              ))}
            </div>

            <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-text-secondary">
              Switching from something else, or not sure where you fit?{' '}
              <a href="mailto:ali@vireek.com?subject=Switching%20to%20Vireek" className="font-semibold text-accent hover:underline">
                Email the team
              </a>{' '}
              and we'll walk you through it directly.
            </p>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-6 py-16 md:py-20">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="bg-noise relative mx-auto flex max-w-6xl flex-col items-center overflow-hidden rounded-3xl bg-gradient-to-br from-accent-800 via-accent-700 to-cta-800 px-6 py-16 text-center shadow-glow-accent md:px-16 md:py-24"
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage:
                  'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.14), transparent 45%), radial-gradient(circle at 85% 80%, rgb(var(--accent-secondary) / 0.20), transparent 45%)',
              }}
            />
            <div className="relative">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-white/80">
                <Sparkles className="mr-1.5 inline h-4 w-4" />
                No contracts, no risk
              </p>
              <h2 className="mt-4 text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                Try it before you switch anything
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Set up Vireek and test it on a real call before you touch your existing number or cancel anything.
              </p>
              <div className="mt-9 flex justify-center">
                <Link to="/login">
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    Start Free Trial
                    <ArrowRight size={18} />
                  </Button>
                </Link>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-white/70">
                <ShieldCheck size={13} className="shrink-0" />
                Cancel anytime. No contracts.
              </p>
            </div>
          </motion.div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
