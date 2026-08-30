import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Check, ChevronDown, ShieldCheck, Sparkles, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { EASE, viewport } from '@/lib/motion';
import {
  PRICING_PLANS,
  COMPARE_ROWS,
  COMPARE_VALUES,
  PRICING_FAQS,
  getPlanHref,
  isStripeCheckout,
  type BillingCycle,
  type PlanId,
} from '@/lib/pricing';

/* ------------------------------------------------------------------ */
/*  SEO                                                                 */
/* ------------------------------------------------------------------ */

function SEO() {
  useEffect(() => {
    const title = 'Pricing | Vireek AI Voice Receptionist';
    const description =
      'Compare Vireek plans — Free, Starter, Professional, Business and Enterprise — and choose the AI voice receptionist plan that fits your call volume.';
    const previousTitle = document.title;
    const upsertMeta = (name: string, content: string) => {
      let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', name);
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
  }, []);

  return null;
}

/* ------------------------------------------------------------------ */
/*  Small building blocks                                              */
/* ------------------------------------------------------------------ */

function CompareCell({ value }: { value: string | boolean | undefined }) {
  if (value === true) return <Check size={16} strokeWidth={2.5} className="mx-auto text-success" />;
  if (value === false || value === undefined)
    return <X size={15} strokeWidth={2} className="mx-auto text-text-secondary/40" />;
  return <span className="font-mono text-xs text-text-primary">{value}</span>;
}

function PlanCard({ planId, billing }: { planId: PlanId; billing: BillingCycle }) {
  const plan = PRICING_PLANS.find((p) => p.id === planId)!;
  const isEnterprise = plan.id === 'enterprise';
  const isFree = plan.id === 'free';
  const price = billing === 'annual' ? plan.annual : plan.monthly;
  const displayPrice = isEnterprise ? plan.startingAt : billing === 'annual' ? Math.round((price ?? 0) / 12) : price;
  const href = getPlanHref(plan.id, billing);
  const external = isStripeCheckout(plan.id);

  const cardClass = plan.recommended
    ? 'relative flex h-full flex-col rounded-2xl border-2 border-accent bg-bg-secondary p-7 shadow-glow-accent lg:-translate-y-3'
    : isEnterprise
    ? 'flex h-full flex-col rounded-2xl border border-text-primary/20 bg-bg-secondary p-7 shadow-card dark:shadow-card-dark'
    : isFree
    ? 'flex h-full flex-col rounded-2xl border border-border bg-bg-tertiary p-7'
    : 'flex h-full flex-col rounded-2xl border border-border bg-bg-secondary p-7 shadow-card dark:shadow-card-dark';

  const CtaButton = (
    <Button
      variant={plan.recommended ? 'primary' : isEnterprise || isFree ? 'secondary' : 'primary'}
      size="lg"
      className="w-full gap-2"
    >
      {plan.ctaLabel}
      <ArrowRight size={16} />
    </Button>
  );

  return (
    <div className={cardClass}>
      {plan.recommended && (
        <span className="absolute -top-3 left-6 inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white shadow-glow-accent">
          <Sparkles size={12} /> Most popular
        </span>
      )}

      <h3 className="text-lg font-semibold text-text-primary">{plan.name}</h3>
      <p className="mt-2 min-h-[44px] text-sm leading-relaxed text-text-secondary">{plan.tagline}</p>

      <div className="mt-2 flex items-baseline gap-1">
        {isEnterprise && <span className="text-sm text-text-secondary">from</span>}
        <span className="text-3xl font-bold tracking-tight text-text-primary">${displayPrice}</span>
        <span className="text-sm text-text-secondary">/mo</span>
      </div>
      <p className="mt-1 text-xs font-medium text-text-secondary/70">
        {isEnterprise
          ? 'Custom annual contract'
          : isFree
          ? 'Free forever'
          : billing === 'annual'
          ? `billed $${price}/year · save $${(plan.monthly ?? 0) * 12 - (plan.annual ?? 0)}`
          : 'billed monthly'}
      </p>

      <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-text-secondary">
        <span>{plan.minutes}</span>
        <span>·</span>
        <span>{plan.seats}</span>
      </div>

      <div className="mt-6">
        {external ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {CtaButton}
          </a>
        ) : (
          <Link to={href}>{CtaButton}</Link>
        )}
        <p className="mt-2 text-center text-xs text-text-secondary/70">{plan.ctaHint}</p>
      </div>

      <ul className="mt-6 flex flex-1 flex-col gap-2.5">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm text-text-primary">
            <Check size={15} strokeWidth={2.5} className="mt-0.5 shrink-0 text-success" />
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                                */
/* ------------------------------------------------------------------ */

export function PricingPage() {
  const [billing, setBilling] = useState<BillingCycle>('annual');
  const [openFaq, setOpenFaq] = useState<number>(0);
  const compareIds: PlanId[] = ['free', 'starter', 'professional', 'business', 'enterprise'];

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-16 sm:py-20">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: EASE }}
            className="mx-auto max-w-3xl text-center"
          >
            <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-cta/40 bg-cta/10 px-4 py-1.5 text-sm font-semibold text-cta">
              <ShieldCheck size={16} />
              14-day free trial — no credit card required
            </div>
            <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
              Pricing built for how service businesses actually grow
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-text-secondary">
              Start free. Upgrade only once your call volume proves it&apos;s worth it. No
              contracts, no seat minimums, no hidden overage fees.
            </p>
          </motion.div>

          {/* Billing toggle */}
          <div className="mt-10 flex justify-center">
            <div
              role="group"
              aria-label="Billing period"
              className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-secondary p-1"
            >
              {(['monthly', 'annual'] as const).map((cycle) => (
                <button
                  key={cycle}
                  type="button"
                  aria-pressed={billing === cycle}
                  onClick={() => setBilling(cycle)}
                  className={`rounded-full px-5 py-2 text-sm font-semibold transition-colors ${
                    billing === cycle
                      ? 'bg-accent text-white shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {cycle === 'monthly' ? 'Monthly' : (
                    <span className="inline-flex items-center gap-2">
                      Annual
                      <span
                        className={`text-xs font-semibold ${
                          billing === cycle ? 'text-white/85' : 'text-success'
                        }`}
                      >
                        2 months free
                      </span>
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Plan cards */}
        <section className="px-6 pb-4 pt-4">
          <div className="mx-auto grid max-w-7xl gap-5 md:grid-cols-2 lg:grid-cols-5">
            {compareIds.map((id, index) => (
              <motion.div
                key={id}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.45, ease: EASE, delay: Math.min(index * 0.06, 0.24) }}
              >
                <PlanCard planId={id} billing={billing} />
              </motion.div>
            ))}
          </div>
        </section>

        {/* Full comparison table */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <h2 className="text-center text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
              Compare every plan
            </h2>
            <div className="mt-8 overflow-x-auto rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
              <table className="w-full min-w-[720px] border-collapse">
                <thead>
                  <tr>
                    <th className="border-b border-border bg-bg-tertiary px-4 py-4 text-left text-sm font-semibold text-text-primary">
                      Plan
                    </th>
                    {compareIds.map((id) => (
                      <th
                        key={id}
                        className="border-b border-border bg-bg-tertiary px-4 py-4 text-center text-sm font-semibold text-text-primary"
                      >
                        {PRICING_PLANS.find((p) => p.id === id)!.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COMPARE_ROWS.map((row) => (
                    <tr key={row.key} className="last:[&>td]:border-b-0">
                      <td className="border-b border-border px-4 py-3.5 text-left text-sm text-text-secondary">
                        {row.label}
                      </td>
                      {compareIds.map((id) => {
                        const plan = PRICING_PLANS.find((p) => p.id === id)!;
                        const value = COMPARE_VALUES[row.key]
                          ? COMPARE_VALUES[row.key][id]
                          : (plan as unknown as Record<string, string>)[row.key];
                        return (
                          <td key={id} className="border-b border-border px-4 py-3.5 text-center">
                            <CompareCell value={value} />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Trust bar */}
        <section className="px-6 pb-4">
          <div className="mx-auto flex max-w-5xl flex-wrap justify-center gap-x-8 gap-y-3">
            {[
              'No long-term contracts',
              'Cancel anytime',
              'Encrypted call storage',
              '99.9% uptime SLA',
            ].map((item) => (
              <div key={item} className="flex items-center gap-2 text-sm text-text-secondary">
                <ShieldCheck size={16} className="text-accent" />
                {item}
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-center text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
              Frequently asked questions
            </h2>
            <div className="mt-8 space-y-2">
              {PRICING_FAQS.map((item, i) => (
                <div key={item.q} className="border-b border-border">
                  <button
                    type="button"
                    onClick={() => setOpenFaq(openFaq === i ? -1 : i)}
                    aria-expanded={openFaq === i}
                    className="focus-ring flex w-full items-center justify-between gap-4 py-4 text-left text-sm font-semibold text-text-primary"
                  >
                    {item.q}
                    <ChevronDown
                      size={16}
                      className={`shrink-0 text-text-secondary transition-transform duration-200 ${
                        openFaq === i ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  <AnimatePresence initial={false}>
                    {openFaq === i && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: EASE }}
                        className="overflow-hidden"
                      >
                        <p className="pb-4 text-sm leading-relaxed text-text-secondary">{item.a}</p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-6 pb-24">
          <div className="mx-auto max-w-5xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
              Ready when your customers call
            </p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Start free, upgrade when it pays for itself.
            </h2>
            <div className="mt-8">
              <Link to="/login">
                <Button variant="primary" size="lg">
                  Start Free Trial
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
