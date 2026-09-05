import { useEffect } from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Check, PhoneCall, Sparkles } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';
import { getIndustryBySlug, INDUSTRIES } from '@/lib/industries';

function SEO({ name, audience, tagline }: { name: string; audience: string; tagline: string }) {
  useEffect(() => {
    const title = `AI Receptionist for ${name} ${name === 'HVAC' ? 'Companies' : ''} | Vireek`.replace(/\s+/g, ' ').trim();
    const description = `${tagline} Vireek answers every call, books appointments, and captures leads for ${audience} — 24/7, no missed calls.`;
    const previousTitle = document.title;

    const upsertMeta = (name_: string, content: string) => {
      let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name_}"]`);
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', name_);
        document.head.appendChild(meta);
      }
      const previous = meta.getAttribute('content');
      meta.setAttribute('content', content);
      return () => {
        if (previous === null) meta?.remove();
        else meta?.setAttribute('content', previous);
      };
    };

    document.title = title;
    const cleanupDescription = upsertMeta('description', description);
    const cleanupRobots = upsertMeta('robots', 'index, follow');

    return () => {
      document.title = previousTitle;
      cleanupDescription();
      cleanupRobots();
    };
  }, [name, audience, tagline]);

  return null;
}

export function IndustryPage() {
  const { slug } = useParams<{ slug: string }>();
  const industry = getIndustryBySlug(slug);

  if (!industry) {
    return <Navigate to="/#industries" replace />;
  }

  const { name, audience, tagline, painPoints, capabilities, faq, icon: Icon } = industry;
  const otherIndustries = INDUSTRIES.filter((i) => i.slug !== industry.slug);

  return (
    <>
      <SEO name={name} audience={audience} tagline={tagline} />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl text-center">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <Icon className="h-4 w-4 text-accent" />
                Built for {audience}
              </div>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                The AI Receptionist for {name}
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">{tagline}</p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/signup">
                  <Button variant="primary" size="lg">
                    Start Free Trial
                  </Button>
                </Link>
                <a
                  href="/#pricing"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  View pricing <ArrowRight className="h-4 w-4" />
                </a>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Pain points vs capabilities */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-2">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
            >
              <Card className="h-full">
                <p className={eyebrowClass()}>The Problem</p>
                <h2 className="mt-2 text-2xl font-bold text-text-primary">
                  What {audience} deal with every day
                </h2>
                <ul className="mt-6 space-y-4">
                  {painPoints.map((point) => (
                    <li key={point} className="flex gap-3 text-sm leading-relaxed text-text-secondary">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
                      {point}
                    </li>
                  ))}
                </ul>
              </Card>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
            >
              <Card className="h-full border-accent/25">
                <p className={eyebrowClass()}>How Vireek Helps</p>
                <h2 className="mt-2 text-2xl font-bold text-text-primary">Built specifically for {name.toLowerCase()}</h2>
                <ul className="mt-6 space-y-4">
                  {capabilities.map((cap) => (
                    <li key={cap} className="flex gap-3 text-sm leading-relaxed text-text-secondary">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                      {cap}
                    </li>
                  ))}
                </ul>
              </Card>
            </motion.div>
          </div>
        </section>

        {/* Common call types */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl text-center">
            <p className={eyebrowClass()}>Common Calls</p>
            <h2 className={sectionHeadingClass()}>Calls Vireek handles for {audience}</h2>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              {industry.terms.map((term) => (
                <span
                  key={term}
                  className="rounded-lg border border-border bg-bg-tertiary px-4 py-2 text-sm text-text-secondary"
                >
                  {term}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        {faq.length > 0 && (
          <section className="px-6 py-16 sm:py-20">
            <div className="mx-auto max-w-3xl">
              <p className={`${eyebrowClass()} text-center`}>FAQ</p>
              <h2 className={`${sectionHeadingClass()} text-center`}>
                Questions {audience} ask us
              </h2>
              <div className="mt-10 space-y-4">
                {faq.map((item) => (
                  <div key={item.q} className="rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark">
                    <h3 className="text-base font-semibold text-text-primary">{item.q}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">{item.a}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Explore other trades — internal linking for SEO + discovery */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl">
            <p className={`${eyebrowClass()} text-center`}>Other Trades</p>
            <h2 className={`${sectionHeadingClass()} text-center`}>Vireek also works for</h2>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              {otherIndustries.map((other) => (
                <Link
                  key={other.slug}
                  to={`/industries/${other.slug}`}
                  className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
                >
                  <other.icon className="h-4 w-4" />
                  {other.name}
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-6 pb-24">
          <div className="mx-auto max-w-5xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
              <Sparkles className="mr-1.5 inline h-4 w-4" />
              Ready when your phone rings
            </p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Stop losing {name.toLowerCase()} leads to voicemail.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary">
              Set up Vireek in minutes and start answering every call today.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link to="/signup">
                <Button variant="primary" size="lg">
                  Start Free Trial
                </Button>
              </Link>
              <a href="tel:+16509106703" className="focus-ring inline-flex items-center gap-2 text-sm font-semibold text-text-secondary hover:text-accent">
                <PhoneCall className="h-4 w-4" /> Or call our demo line
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
