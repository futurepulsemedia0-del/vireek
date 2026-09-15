import { Navigate, useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Check, ShieldCheck, Sparkles, Clock } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { SWITCH_GUIDES, getSwitchGuideBySlug } from '@/lib/switchGuides';

export function SwitchGuidePage() {
  const { slug } = useParams<{ slug: string }>();
  const guide = getSwitchGuideBySlug(slug);

  // Hooks run unconditionally before the early return — see CompetitorPage.tsx
  // for the same pattern and reasoning.
  useSEO({
    title: guide?.seoTitle ?? 'Switching to Vireek | Vireek',
    description: guide?.seoDescription ?? 'Everything it takes to switch your business to Vireek, the AI voice receptionist for home-service trades.',
    canonical: `https://vireek.com/switch/${slug ?? ''}`,
  });

  if (!guide) {
    return <Navigate to="/switch" replace />;
  }

  const { fromName, category, summary, icon: Icon, whatCarriesOver, steps, timeEstimate, faq } = guide;
  const otherGuides = SWITCH_GUIDES.filter((g) => g.slug !== guide.slug);

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <BackButton fallback="/switch" />
            </div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
              className="text-center"
            >
              <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-1.5 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <Icon className="h-4 w-4 text-accent" />
                {category}
              </div>
              <p className={eyebrowClass()}>Switching Guide</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Switching From {fromName} to Vireek
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                {summary}
              </p>
              <div className="mt-8 inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/5 px-4 py-1.5 text-sm font-semibold text-accent">
                <Clock size={14} />
                {timeEstimate}
              </div>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/login">
                  <Button variant="primary" size="lg">Start Free Trial</Button>
                </Link>
                <a
                  href="mailto:ali@vireek.com?subject=Switching%20to%20Vireek"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  Ask us anything first
                  <ArrowRight className="h-4 w-4" />
                </a>
              </div>
            </motion.div>
          </div>
        </section>

        {/* What carries over */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="rounded-2xl border border-accent/25 bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
            >
              <p className={eyebrowClass()}>Before You Worry About It</p>
              <h2 className="mt-2 text-xl font-bold text-text-primary sm:text-2xl">What stays exactly the same</h2>
              <ul className="mt-5 space-y-3">
                {whatCarriesOver.map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm leading-relaxed text-text-secondary sm:text-base">
                    <Check size={18} className="mt-0.5 shrink-0 text-success-500" strokeWidth={2.5} />
                    {item}
                  </li>
                ))}
              </ul>
            </motion.div>
          </div>
        </section>

        {/* Steps */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>Step by Step</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center text-2xl sm:text-3xl`}>
                How the switch actually works
              </h2>
            </motion.div>

            <div className="mt-12 space-y-8">
              {steps.map((step, index) => (
                <motion.div
                  key={step.title}
                  initial={{ opacity: 0, y: 18 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.45, delay: index * 0.06, ease: EASE }}
                  className="flex gap-4 sm:gap-5"
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-bold text-accent">
                    {index + 1}
                  </span>
                  <div className="pt-1.5">
                    <h3 className="text-base font-semibold text-text-primary sm:text-lg">{step.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-text-secondary sm:text-base">{step.body}</p>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        {faq.length > 0 && (
          <section className="px-6 py-16 sm:py-20">
            <div className="mx-auto max-w-3xl">
              <p className={`${eyebrowClass()} text-center`}>FAQ</p>
              <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>
                Questions about switching from {fromName}
              </h2>
              <div className="mt-8 space-y-3 sm:mt-10 sm:space-y-4">
                {faq.map((item) => (
                  <div key={item.q} className="rounded-2xl border border-border bg-bg-secondary/90 p-5 shadow-card dark:shadow-card-dark sm:p-6">
                    <h3 className="text-base font-semibold text-text-primary">{item.q}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">{item.a}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Other switch guides */}
        {otherGuides.length > 0 && (
          <section className="px-6 py-16 sm:py-20">
            <div className="mx-auto max-w-5xl">
              <p className={`${eyebrowClass()} text-center`}>More Switching Guides</p>
              <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>Coming from somewhere else?</h2>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                {otherGuides.map((other) => (
                  <Link
                    key={other.slug}
                    to={`/switch/${other.slug}`}
                    className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
                  >
                    <other.icon className="h-4 w-4" />
                    From {other.fromName}
                  </Link>
                ))}
                <Link
                  to="/compare"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
                >
                  See full comparisons
                </Link>
              </div>
            </div>
          </section>
        )}

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
                Ready when you are
              </p>
              <h2 className="mt-4 text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                Make the switch at your own pace
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Set up Vireek, test it on a real call, and switch your number over whenever you're ready &mdash; not before.
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
