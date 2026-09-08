import { useEffect } from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowRight, Check, PhoneCall, Sparkles, XCircle, CheckCircle2,
  PhoneIncoming, Brain, Siren, CalendarCheck, DatabaseZap,
  Clock, DollarSign, TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { EASE, eyebrowClass, sectionHeadingClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { getIndustryBySlug, INDUSTRIES } from '@/lib/industries';

/* ------------------------------------------------------------------ */
/*  SEO                                                                */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Workflow steps                                                     */
/* ------------------------------------------------------------------ */

const WORKFLOW_STEPS: { icon: LucideIcon; label: string; detail: string }[] = [
  { icon: PhoneIncoming, label: 'Call Answered', detail: 'Sarah picks up instantly, 24/7' },
  { icon: Brain, label: 'Issue Understood', detail: 'Trade-specific language recognized' },
  { icon: Siren, label: 'Emergency Triaged', detail: 'Urgent calls flagged for dispatch' },
  { icon: CalendarCheck, label: 'Appointment Booked', detail: 'Calendar checked, slot confirmed' },
  { icon: DatabaseZap, label: 'CRM Synced', detail: 'Customer + job data written automatically' },
];

const BENEFITS = [
  { icon: Clock, title: 'Zero missed calls', body: 'Every call answered instantly — day or night.' },
  { icon: DollarSign, title: 'More revenue', body: 'Every answered call becomes a potential booked job.' },
  { icon: TrendingUp, title: 'Higher close rate', body: 'Qualified leads captured before they call a competitor.' },
  { icon: DatabaseZap, title: 'No manual entry', body: 'CRM and calendar updated automatically.' },
];

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export function IndustryPage() {
  const { slug } = useParams<{ slug: string }>();
  const industry = getIndustryBySlug(slug);

  if (!industry) {
    return <Navigate to="/#industries" replace />;
  }

  const { name, audience, tagline, painPoints, capabilities, faq, icon: Icon, terms } = industry;
  const otherIndustries = INDUSTRIES.filter((i) => i.slug !== industry.slug);

  return (
    <>
      <SEO name={name} audience={audience} tagline={tagline} />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-20 sm:pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-5 py-16 sm:px-6 sm:py-20 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl text-center">
            <div className="mb-5 text-left sm:mb-6">
              <BackButton />
            </div>
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-3 py-1.5 text-xs font-semibold text-text-secondary shadow-sm backdrop-blur sm:mb-6 sm:px-4 sm:text-sm">
                <Icon className="h-4 w-4 text-accent" />
                Built for {audience}
              </div>
              <h1 className="text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl lg:text-6xl">
                AI Receptionist Built For {name}
              </h1>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary sm:mt-6 sm:text-lg sm:leading-8 lg:text-xl">{tagline}</p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:mt-10 sm:flex-row sm:gap-4">
                <Link to="/login" className="w-full sm:w-auto">
                  <Button variant="primary" size="lg" className="w-full sm:w-auto">
                    Start Free Trial
                  </Button>
                </Link>
                <a
                  href="/#pricing"
                  className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent sm:w-auto"
                >
                  View pricing <ArrowRight className="h-4 w-4" />
                </a>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Pain points vs capabilities */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-2 lg:gap-8">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
            >
              <p className={eyebrowClass()}>{'The Problem'}</p>
              <h2 className="mt-2 text-xl font-bold text-text-primary sm:text-2xl">
                What {audience} deal with every day
              </h2>
              <ul className="mt-5 space-y-3 sm:mt-6 sm:space-y-4">
                {painPoints.map((point) => (
                  <li key={point} className="flex gap-3 text-sm leading-relaxed text-text-secondary">
                    <XCircle size={18} className="mt-0.5 h-4 w-4 shrink-0 text-danger/60 sm:size-[18px]" />
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
              <p className={eyebrowClass()}>{'How Vireek Helps'}</p>
              <h2 className="mt-2 text-xl font-bold text-text-primary sm:text-2xl">Built specifically for {name.toLowerCase()}</h2>
              <ul className="mt-5 space-y-3 sm:mt-6 sm:space-y-4">
                {capabilities.map((cap) => (
                  <li key={cap} className="flex gap-3 text-sm leading-relaxed text-text-secondary">
                    <CheckCircle2 size={18} className="mt-0.5 h-4 w-4 shrink-0 text-success sm:size-[18px]" />
                    {cap}
                  </li>
                ))}
              </ul>
            </motion.div>
          </div>
        </section>

        {/* Workflow */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>{'The Workflow'}</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>{'How Sarah Handles Every Call'}</h2>
            </motion.div>

            <div className="mt-8 grid gap-3 sm:mt-12 sm:grid-cols-5 sm:gap-2">
              {WORKFLOW_STEPS.map((step, i) => {
                const StepIcon = step.icon;
                return (
                  <motion.div
                    key={step.label}
                    initial={{ opacity: 0, y: 12 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={viewport}
                    transition={{ duration: 0.4, delay: i * 0.08, ease: EASE }}
                    className="flex items-center gap-3 sm:flex-col sm:text-center"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent sm:h-12 sm:w-12">
                      <StepIcon size={18} className="sm:size-5" />
                    </span>
                    <div className="sm:mt-2">
                      <p className="text-sm font-semibold text-text-primary">{step.label}</p>
                      <p className="text-xs text-text-secondary">{step.detail}</p>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Benefits */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>{'The Benefits'}</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>{'What Changes With Vireek'}</h2>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-8 grid gap-4 sm:mt-12 sm:grid-cols-2 lg:grid-cols-4"
            >
              {BENEFITS.map((benefit) => {
                const BenefitIcon = benefit.icon;
                return (
                  <motion.div
                    key={benefit.title}
                    variants={fadeUpItem}
                    transition={{ duration: 0.4, ease: EASE }}
                    className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:border-accent/20 dark:shadow-card-dark sm:p-6"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent sm:h-11 sm:w-11">
                      <BenefitIcon size={18} className="sm:size-5" />
                    </span>
                    <h3 className="mt-3 text-sm font-semibold text-text-primary sm:text-base">{benefit.title}</h3>
                    <p className="mt-1.5 text-xs leading-relaxed text-text-secondary sm:text-sm">{benefit.body}</p>
                  </motion.div>
                );
              })}
            </motion.div>
          </div>
        </section>

        {/* Common call types */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-4xl text-center">
            <p className={eyebrowClass()}>{'Common Calls'}</p>
            <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>{'Calls Vireek handles for '}{audience}</h2>
            <div className="mt-6 flex flex-wrap justify-center gap-2 sm:mt-8 sm:gap-3">
              {terms.map((term) => (
                <span
                  key={term}
                  className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary sm:px-4 sm:py-2 sm:text-sm"
                >
                  {term}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        {faq.length > 0 && (
          <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
            <div className="mx-auto max-w-3xl">
              <p className={`${eyebrowClass()} text-center`}>{'FAQ'}</p>
              <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>
                Questions {audience} ask us
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

        {/* Explore other trades */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-5xl">
            <p className={`${eyebrowClass()} text-center`}>{'Other Trades'}</p>
            <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>{'Vireek also works for'}</h2>
            <div className="mt-6 flex flex-wrap justify-center gap-2 sm:mt-8 sm:gap-3">
              {otherIndustries.map((other) => (
                <Link
                  key={other.slug}
                  to={`/industries/${other.slug}`}
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
          <div className="mx-auto max-w-5xl overflow-hidden rounded-2xl border border-accent/30 bg-bg-secondary p-6 text-center shadow-card dark:shadow-card-dark sm:rounded-3xl sm:p-12">
            <div className="absolute inset-0 -z-10 bg-gradient-to-br from-accent/[0.04] via-transparent to-cta/[0.04]" />
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
              <Sparkles className="mr-1.5 inline h-4 w-4" />
              Ready when your phone rings
            </p>
            <h2 className="mt-4 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl md:text-4xl">
              Stop losing {name.toLowerCase()} leads to voicemail.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-text-secondary sm:text-base">
              Set up Vireek in minutes and start answering every call today.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
              <Link to="/login" className="w-full sm:w-auto">
                <Button variant="primary" size="lg" className="w-full sm:w-auto">
                  Start Free Trial
                </Button>
              </Link>
              <a href="tel:+16509106703" className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-secondary transition-colors hover:text-accent sm:w-auto">
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
