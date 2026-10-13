import { Link, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, CheckCircle2, Clock, Sparkles, XCircle } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { EASE, eyebrowClass, sectionHeadingClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { USE_CASES, getUseCaseBySlug, useCasePath, type UseCase } from '@/lib/useCases';
import { useSEO } from '@/lib/seo';
import { NotFoundPage } from '@/pages/NotFoundPage';

const SITE = 'https://vireek.com';

function UseCaseContent({ useCase }: { useCase: UseCase }) {
  const { name, icon: Icon, headline, tagline, situation, withoutVireek, withVireek, steps, outcomes, planNote, related, faq, ctaHeadline } =
    useCase;
  const canonical = `${SITE}${useCasePath(useCase.slug)}`;
  const otherUseCases = USE_CASES.filter((other) => other.slug !== useCase.slug);

  useSEO({
    title: useCase.metaTitle,
    description: useCase.metaDescription,
    canonical,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: name, item: canonical },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faq.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
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
                <Icon className="h-4 w-4 text-accent" aria-hidden="true" />
                Use case: {name}
              </div>
              <h1 className="text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl lg:text-6xl">{headline}</h1>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary sm:mt-6 sm:text-lg sm:leading-8 lg:text-xl">{tagline}</p>
              {planNote && <p className="mx-auto mt-3 max-w-xl text-xs text-text-secondary sm:text-sm">{planNote}</p>}
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:mt-10 sm:flex-row sm:gap-4">
                <Link to="/login" className="w-full sm:w-auto">
                  <Button variant="primary" size="lg" className="w-full sm:w-auto">
                    Start Free Trial
                  </Button>
                </Link>
                <Link
                  to="/demo"
                  className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent sm:w-auto"
                >
                  Book a demo <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Scenario */}
        <section className="px-5 py-12 sm:px-6 sm:py-16">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="mx-auto max-w-3xl rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
          >
            <p className={`${eyebrowClass()} flex items-center gap-2`}>
              <Clock className="h-4 w-4" aria-hidden="true" /> The scenario
            </p>
            <p className="mt-3 text-base leading-7 text-text-primary sm:text-lg sm:leading-8">{situation}</p>
          </motion.div>
        </section>

        {/* Without vs with */}
        <section className="px-5 py-4 sm:px-6 sm:py-8">
          <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-2 lg:gap-8">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
            >
              <p className={eyebrowClass()}>Without Vireek</p>
              <ul className="mt-5 space-y-3 sm:space-y-4">
                {withoutVireek.map((point) => (
                  <li key={point} className="flex gap-3 text-sm leading-relaxed text-text-secondary">
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger/60" aria-hidden="true" />
                    {point}
                  </li>
                ))}
              </ul>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
              className="rounded-2xl border border-accent/25 bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
            >
              <p className={eyebrowClass()}>With Vireek</p>
              <ul className="mt-5 space-y-3 sm:space-y-4">
                {withVireek.map((point) => (
                  <li key={point} className="flex gap-3 text-sm leading-relaxed text-text-secondary">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                    {point}
                  </li>
                ))}
              </ul>
            </motion.div>
          </div>
        </section>

        {/* Steps */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-5xl">
            <div className="text-center">
              <p className={eyebrowClass()}>How it plays out</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>From first ring to next step</h2>
            </div>
            <ol className="mt-8 grid gap-4 sm:mt-12 sm:grid-cols-2 lg:grid-cols-4">
              {steps.map((step, index) => (
                <motion.li
                  key={step.title}
                  initial={{ opacity: 0, y: 12 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.4, delay: index * 0.08, ease: EASE }}
                  className="flex gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:flex-col sm:gap-3"
                >
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-sm font-bold text-accent"
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary sm:text-base">{step.title}</h3>
                    <p className="mt-1.5 text-xs leading-relaxed text-text-secondary sm:text-sm">{step.detail}</p>
                  </div>
                </motion.li>
              ))}
            </ol>
          </div>
        </section>

        {/* Outcomes */}
        <section className="px-5 py-12 sm:px-6 sm:py-16">
          <div className="mx-auto max-w-6xl">
            <div className="text-center">
              <p className={eyebrowClass()}>The outcome</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>What changes</h2>
            </div>
            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-8 grid gap-4 sm:mt-12 md:grid-cols-3"
            >
              {outcomes.map((outcome) => (
                <motion.div
                  key={outcome.title}
                  variants={fadeUpItem}
                  transition={{ duration: 0.4, ease: EASE }}
                  className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:border-accent/20 dark:shadow-card-dark sm:p-6"
                >
                  <h3 className="text-base font-semibold text-text-primary">{outcome.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{outcome.body}</p>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Related features */}
        <section className="px-5 py-8 sm:px-6 sm:py-12">
          <div className="mx-auto max-w-5xl">
            <p className={`${eyebrowClass()} text-center`}>Go deeper</p>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              {related.map((link) => (
                <Link
                  key={link.href}
                  to={link.href}
                  className="focus-ring group rounded-2xl border border-border bg-bg-secondary p-5 transition-colors hover:border-accent/40"
                >
                  <span className="flex items-center justify-between text-sm font-semibold text-text-primary group-hover:text-accent">
                    {link.label}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="mt-1.5 block text-xs leading-relaxed text-text-secondary">{link.blurb}</span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-3xl">
            <p className={`${eyebrowClass()} text-center`}>FAQ</p>
            <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>Common questions</h2>
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

        {/* Other use cases */}
        <section className="px-5 py-8 sm:px-6 sm:py-12">
          <div className="mx-auto max-w-5xl">
            <p className={`${eyebrowClass()} text-center`}>More use cases</p>
            <nav aria-label="Other use cases" className="mt-6 flex flex-wrap justify-center gap-2 sm:gap-3">
              {otherUseCases.map((other) => (
                <Link
                  key={other.slug}
                  to={useCasePath(other.slug)}
                  className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent sm:px-4"
                >
                  <other.icon className="h-4 w-4" aria-hidden="true" />
                  {other.name}
                </Link>
              ))}
            </nav>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-5 pb-16 sm:px-6 sm:pb-24">
          <div className="mx-auto max-w-5xl overflow-hidden rounded-2xl border border-accent/30 bg-bg-secondary p-6 text-center shadow-card dark:shadow-card-dark sm:rounded-3xl sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
              <Sparkles className="mr-1.5 inline h-4 w-4" aria-hidden="true" />
              Ready when your phone rings
            </p>
            <h2 className="mt-4 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl md:text-4xl">{ctaHeadline}</h2>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-text-secondary sm:text-base">
              Set up Vireek in minutes and start answering every call today.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
              <Link to="/login" className="w-full sm:w-auto">
                <Button variant="primary" size="lg" className="w-full sm:w-auto">
                  Start Free Trial
                </Button>
              </Link>
              <Link
                to="/pricing"
                className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-secondary transition-colors hover:text-accent sm:w-auto"
              >
                View pricing <ArrowRight className="h-4 w-4" aria-hidden="true" />
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

export function UseCasePage() {
  const { slug } = useParams<{ slug: string }>();
  const useCase = getUseCaseBySlug(slug);
  // Unknown slugs render the real 404 (noindex). SEO is set inside UseCaseContent so it
  // never overrides the 404's robots tag.
  if (!useCase) return <NotFoundPage />;
  return <UseCaseContent key={useCase.slug} useCase={useCase} />;
}
