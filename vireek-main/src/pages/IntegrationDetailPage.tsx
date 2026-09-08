import { useParams, Link, Navigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, CheckCircle2, Plug } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { useSEO } from '@/lib/seo';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';
import { getIntegrationBySlug, INTEGRATIONS } from '@/lib/integrations';

export function IntegrationDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const integration = getIntegrationBySlug(slug);

  if (!integration) {
    return <Navigate to="/integrations" replace />;
  }

  const { name, category, tagline, summary, capabilities, steps, faq, icon: Icon } = integration;
  const otherIntegrations = INTEGRATIONS.filter((i) => i.slug !== integration.slug);

  return (
    <>
      <IntegrationSEO name={name} category={category} tagline={tagline} summary={summary} slug={integration.slug} />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-20 sm:pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-5 py-16 sm:px-6 sm:py-20 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl text-center">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-3 py-1.5 text-xs font-semibold text-text-secondary shadow-sm backdrop-blur sm:mb-6 sm:px-4 sm:text-sm">
                <Icon className="h-4 w-4 text-accent" />
                {category} Integration
              </div>
              <h1 className="text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl lg:text-6xl">
                Vireek + {name}
              </h1>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary sm:mt-6 sm:text-lg sm:leading-8 lg:text-xl">
                {tagline}
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:mt-10 sm:flex-row sm:gap-4">
                <Link to="/login" className="w-full sm:w-auto">
                  <Button variant="primary" size="lg" className="w-full sm:w-auto">
                    Start Free Trial
                  </Button>
                </Link>
                <Link
                  to="/integrations"
                  className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent sm:w-auto"
                >
                  <Plug className="h-4 w-4" /> All integrations
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Summary */}
        <section className="px-5 py-4 sm:px-6">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="mx-auto max-w-3xl rounded-2xl border border-border bg-bg-secondary p-6 text-center shadow-card dark:shadow-card-dark sm:p-8"
          >
            <p className="text-base leading-relaxed text-text-secondary sm:text-lg">{summary}</p>
          </motion.div>
        </section>

        {/* Capabilities */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>What It Does</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>What Changes With {name}</h2>
            </motion.div>

            <div className="mt-8 space-y-3 sm:mt-12 sm:space-y-4">
              {capabilities.map((cap) => (
                <motion.div
                  key={cap}
                  initial={{ opacity: 0, y: 12 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.4, ease: EASE }}
                  className="flex items-start gap-3 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:p-6"
                >
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
                  <p className="text-sm leading-relaxed text-text-secondary sm:text-base">{cap}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Setup steps */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>Setup</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>How To Connect {name}</h2>
            </motion.div>

            <div className="mt-8 grid gap-4 sm:mt-12 sm:grid-cols-3 sm:gap-6">
              {steps.map((step, i) => (
                <motion.div
                  key={step.title}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.4, delay: i * 0.08, ease: EASE }}
                  className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/10 text-sm font-bold text-accent">
                    {i + 1}
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-text-primary">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{step.detail}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        {faq.length > 0 && (
          <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
            <div className="mx-auto max-w-3xl">
              <p className={`${eyebrowClass()} text-center`}>FAQ</p>
              <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>
                Questions about the {name} integration
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

        {/* Other integrations */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-5xl">
            <p className={`${eyebrowClass()} text-center`}>More Integrations</p>
            <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>Vireek also connects to</h2>
            <div className="mt-6 flex flex-wrap justify-center gap-2 sm:mt-8 sm:gap-3">
              {otherIntegrations.map((other) => (
                <Link
                  key={other.slug}
                  to={`/integrations/${other.slug}`}
                  className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent sm:px-4"
                >
                  <other.icon className="h-4 w-4" />
                  {other.name}
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-5 pb-16 sm:px-6 sm:pb-24">
          <div className="relative mx-auto max-w-5xl overflow-hidden rounded-2xl border border-accent/30 bg-bg-secondary p-6 text-center shadow-card dark:shadow-card-dark sm:rounded-3xl sm:p-12">
            <div className="absolute inset-0 -z-10 bg-gradient-to-br from-accent/[0.04] via-transparent to-cta/[0.04]" />
            <h2 className="mt-4 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl md:text-4xl">
              Ready to connect {name}?
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-text-secondary sm:text-base">
              Start your free trial, then connect {name} from Settings → Integrations in minutes.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
              <Link to="/login" className="w-full sm:w-auto">
                <Button variant="primary" size="lg" className="w-full sm:w-auto">
                  Start Free Trial <ArrowRight className="h-4 w-4" />
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

function IntegrationSEO({
  name,
  category,
  tagline,
  summary,
  slug,
}: {
  name: string;
  category: string;
  tagline: string;
  summary: string;
  slug: string;
}) {
  useSEO({
    title: `${name} Integration | Vireek`,
    description: `${tagline} ${summary}`.slice(0, 160),
    canonical: `https://vireek.com/integrations/${slug}`,
  });
  void category;
  return null;
}
