import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowRight,
  BarChart3,
  Building2,
  Check,
  ChevronDown,
  Clock,
  Landmark,
  MapPin,
  Minus,
  PhoneIncoming,
  PlugZap,
  Rocket,
  ShieldCheck,
  Siren,
  Sparkles,
  Users,
  Voicemail,
  Zap,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { CurrencySwitcher } from '@/components/CurrencySwitcher';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useExperiment } from '@/contexts/ExperimentContext';
import { formatPrice } from '@/lib/currency';
import { EASE, eyebrowClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import {
  PRICING_PLANS,
  PRICING_FAQS,
  COMPARE_ROWS,
  COMPARE_VALUES,
  getPlanHref,
  isExternalLink,
  type BillingCycle,
  type PricingPlan,
  type CompareRow,
} from '@/lib/pricing';

/** Icon shown on each plan card. Purely presentational — keyed by plan id. */
const PLAN_ICONS: Record<PricingPlan['id'], typeof Sparkles> = {
  free: Sparkles,
  starter: Zap,
  professional: Rocket,
  business: Building2,
  enterprise: Landmark,
};

/** Icon shown next to each row label in the full comparison table — purely presentational. */
const COMPARE_ROW_ICONS: Record<CompareRow['key'], typeof PhoneIncoming> = {
  minutes: PhoneIncoming,
  overage: BarChart3,
  seats: Users,
  locations: MapPin,
  dispatch: Siren,
  crm: PlugZap,
  recording: Voicemail,
  analytics: BarChart3,
  api: PlugZap,
};

/**
 * Base comparison rows (minutes/overage/seats/locations) live directly on each
 * plan object; everything else (dispatch/crm/recording/analytics/api) lives in
 * COMPARE_VALUES. This merges both into a single lookup for the table below.
 */
function getCompareValue(plan: PricingPlan, key: CompareRow['key']): string | boolean {
  switch (key) {
    case 'minutes':
      return plan.minutes;
    case 'overage':
      return plan.overage ?? '\u2014';
    case 'seats':
      return plan.seats;
    case 'locations':
      return plan.locations;
    default:
      return COMPARE_VALUES[key]?.[plan.id] ?? false;
  }
}

function CompareCell({ value }: { value: string | boolean }) {
  if (typeof value === 'boolean') {
    return value ? (
      <Check className="mx-auto h-5 w-5 text-success" strokeWidth={2.5} />
    ) : (
      <Minus className="mx-auto h-4 w-4 text-text-secondary/30" />
    );
  }
  return <span className="text-sm font-medium text-text-primary">{value}</span>;
}

function PlanCard({
  plan,
  billing,
  index,
}: {
  plan: PricingPlan;
  billing: BillingCycle;
  index: number;
}) {
  const { currency } = useCurrency();
  const Icon = PLAN_ICONS[plan.id];
  const isCustomPrice = plan.monthly === null;
  const price = billing === 'annual' ? plan.annual : plan.monthly;
  const displayPrice = isCustomPrice ? null : billing === 'annual' ? Math.round((price ?? 0) / 12) : price;
  const href = getPlanHref(plan.id, billing);
  const external = isExternalLink(plan.id);

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewport}
      transition={{ duration: 0.5, delay: index * 0.07, ease: EASE }}
      whileHover={{ y: -6 }}
      className={`group relative flex h-full flex-col rounded-3xl p-7 transition-shadow duration-300 ${
        plan.recommended
          ? 'border-2 border-accent bg-bg-secondary shadow-glow-accent xl:-translate-y-3'
          : 'border border-border bg-bg-secondary shadow-card hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark'
      }`}
    >
      {plan.recommended && (
        <motion.span
          initial={{ opacity: 0, scale: 0.85 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={viewport}
          transition={{ duration: 0.4, delay: 0.15, ease: EASE }}
          className="absolute -top-3.5 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-gradient-to-r from-accent to-cta px-3.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-white shadow-glow-accent"
        >
          <Sparkles size={12} />
          Most popular
        </motion.span>
      )}

      <div
        className={`flex h-11 w-11 items-center justify-center rounded-2xl border ${
          plan.recommended
            ? 'border-accent/30 bg-accent/10 text-accent'
            : 'border-border bg-bg-tertiary text-text-secondary'
        }`}
      >
        <Icon size={20} />
      </div>

      <h3 className="mt-4 text-xl font-bold tracking-tight text-text-primary">{plan.name}</h3>
      <p className="mt-1.5 min-h-[40px] text-sm leading-relaxed text-text-secondary">{plan.tagline}</p>

      <div className="mt-5 flex items-baseline gap-1.5">
        {isCustomPrice ? (
          <span className="text-4xl font-bold tracking-tight text-text-primary">Custom</span>
        ) : (
          <>
            <span className="text-4xl font-bold tracking-tight text-text-primary">{formatPrice(displayPrice!, currency)}</span>
            <span className="text-sm text-text-secondary">/month</span>
          </>
        )}
      </div>
      <p className="mt-1 text-xs font-medium text-text-secondary/70">
        {isCustomPrice
          ? `Starting from ${formatPrice(plan.startingAt!, currency)}/mo`
          : billing === 'annual'
            ? `billed ${formatPrice(price!, currency)}/year`
            : plan.monthly === 0
              ? 'Free forever'
              : 'billed monthly'}
      </p>

      <div
        className={`mt-5 rounded-xl border px-4 py-3 ${
          plan.recommended ? 'border-accent/30 bg-accent/10' : 'border-border bg-bg-tertiary'
        }`}
      >
        <p className={`text-sm font-semibold ${plan.recommended ? 'text-accent' : 'text-text-primary'}`}>
          {plan.minutes} included
        </p>
        <p className="mt-0.5 text-xs text-text-secondary">
          {plan.seats} · {plan.locations}
        </p>
      </div>

      <ul className="mt-6 flex flex-1 flex-col gap-3">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-3 text-sm text-text-primary">
            <Check
              size={17}
              className={`mt-0.5 shrink-0 ${plan.recommended ? 'text-cta' : 'text-accent'}`}
            />
            <span>{f}</span>
          </li>
        ))}
      </ul>

      {external ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="mt-8 block">
          <Button
            variant={plan.recommended ? 'primary' : 'secondary'}
            size="lg"
            className="w-full gap-2"
          >
            {plan.ctaLabel}
            <ArrowRight size={18} className="transition-transform duration-200 group-hover:translate-x-1" />
          </Button>
        </a>
      ) : (
        <Link to={href} className="mt-8 block">
          <Button variant={plan.recommended ? 'primary' : 'secondary'} size="lg" className="w-full gap-2">
            {plan.ctaLabel}
            <ArrowRight size={18} className="transition-transform duration-200 group-hover:translate-x-1" />
          </Button>
        </Link>
      )}
      <p className="mt-2 flex items-center justify-center gap-1.5 text-center text-xs font-medium text-text-secondary/70">
        <ShieldCheck size={13} className="shrink-0 text-text-secondary/50" />
        {plan.ctaHint}
      </p>
    </motion.div>
  );
}

function PricingFAQItem({
  q,
  a,
  isOpen,
  onToggle,
}: {
  q: string;
  a: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`rounded-2xl border bg-bg-secondary/90 shadow-card transition-all duration-200 dark:shadow-card-dark ${
        isOpen ? 'border-accent/30 shadow-card-hover dark:shadow-card-hover-dark' : 'border-border hover:border-accent/20'
      }`}
    >
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={onToggle}
        className="focus-ring flex w-full items-center justify-between gap-5 rounded-2xl px-5 py-5 text-left sm:px-6"
      >
        <span className="text-base font-semibold leading-7 text-text-primary">{q}</span>
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-colors ${
            isOpen ? 'border-accent/30 bg-accent/10 text-accent' : 'border-border bg-bg-tertiary text-text-secondary'
          }`}
        >
          <ChevronDown className={`h-5 w-5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: EASE }}
            className="overflow-hidden"
          >
            <p className="px-5 pb-6 text-base leading-8 text-text-secondary sm:px-6">{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function PricingPage() {
  useSEO({
    title: 'Pricing \u2014 Simple, Transparent Plans | Vireek',
    description:
      "Compare Vireek's Free, Starter, Professional, Business, and Enterprise plans, including included minutes and transparent overage rates.",
    canonical: 'https://vireek.com/pricing',
  });

  const defaultBillingVariant = useExperiment('pricing_default_billing');
const [billing, setBilling] = useState<BillingCycle>(defaultBillingVariant as BillingCycle);
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-16 sm:py-20 lg:py-24">
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
              <span className="inline-flex items-center gap-2 rounded-full border border-cta/40 bg-cta/10 px-4 py-1.5 text-sm font-semibold text-cta">
                <ShieldCheck size={16} />
                {'Start Your 14-Day Free Trial \u2014 No Credit Card Required'}
              </span>
              <p className={`${eyebrowClass()} mt-8`}>Pricing</p>
              <h1 className="mt-3 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Simple Pricing. No Surprises.
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Every plan includes 24/7 AI call answering. Pick the tier that matches your
                call volume, cancel anytime.
              </p>
            </motion.div>

                        {/* Billing toggle + currency switcher */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.15, ease: EASE }}
              className="mt-10 flex flex-wrap items-center justify-center gap-3"
            >
              <CurrencySwitcher />
              <div
                role="group"
                aria-label="Billing period"
                className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-secondary p-1 shadow-sm"
              >
                {(['monthly', 'annual'] as const).map((cycle) => (
                  <button
                    key={cycle}
                    type="button"
                    aria-pressed={billing === cycle}
                    onClick={() => setBilling(cycle)}
                    className={`relative rounded-full px-5 py-2.5 text-sm font-semibold transition-colors ${
                      billing === cycle ? 'text-white' : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {billing === cycle && (
                      <motion.span
                        layoutId="billing-pill"
                        transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                        className="absolute inset-0 rounded-full bg-accent shadow-sm"
                      />
                    )}
                    <span className="relative inline-flex items-center gap-2">
                      {cycle === 'monthly' ? (
                        'Monthly'
                      ) : (
                        <>
                          Annual
                          <span className={`text-xs font-semibold ${billing === cycle ? 'text-white/85' : 'text-success'}`}>
                            2 months free
                          </span>
                        </>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </motion.div>
          </div>
        </section>

        {/* Plan cards */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-[1400px]">
            <div className="grid grid-cols-1 items-stretch gap-6 sm:grid-cols-2 xl:grid-cols-5">
              {PRICING_PLANS.map((plan, index) => (
                <PlanCard key={plan.id} plan={plan} billing={billing} index={index} />
              ))}
            </div>

            <motion.div
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={viewport}
              transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
              className="mx-auto mt-10 flex max-w-2xl flex-wrap items-center justify-center gap-x-6 gap-y-2 text-center"
            >
              {[
                { icon: ShieldCheck, label: 'No contracts, cancel anytime' },
                { icon: Clock, label: '14-day free trial on every paid plan' },
                { icon: Check, label: 'No hidden fees' },
              ].map(({ icon: TrustIcon, label }) => (
                <span key={label} className="inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary/70">
                  <TrustIcon size={14} className="shrink-0 text-accent" />
                  {label}
                </span>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Full comparison table */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={eyebrowClass()}>Full comparison</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-text-primary md:text-4xl">
                Every plan, side by side.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-text-secondary md:text-lg">
                A closer look at what changes as you scale from a solo operator to a multi-location team.
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.55, delay: 0.1, ease: EASE }}
              className="relative mt-12 overflow-hidden rounded-3xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark"
            >
              {/* Scroll-fade hint on mobile, purely visual */}
              <div className="pointer-events-none absolute inset-y-0 right-0 z-20 w-8 bg-gradient-to-l from-bg-secondary to-transparent sm:hidden" />

              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="sticky left-0 z-10 bg-bg-secondary px-6 py-5 text-sm font-semibold text-text-secondary">
                        Plan
                      </th>
                      {PRICING_PLANS.map((plan) => (
                        <th
                          key={plan.id}
                          className={`relative px-4 py-5 text-center transition-colors ${
                            plan.recommended ? 'bg-accent/[0.06]' : ''
                          }`}
                        >
                          {plan.recommended && (
                            <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-gradient-to-r from-accent to-cta" />
                          )}
                          <div
                            className={`mx-auto inline-flex flex-col items-center gap-1 ${
                              plan.recommended ? 'text-accent' : 'text-text-primary'
                            }`}
                          >
                            <span className="text-sm font-bold">{plan.name}</span>
                            {plan.recommended && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-accent">
                                <Sparkles size={10} />
                                Popular
                              </span>
                            )}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {COMPARE_ROWS.map((row, rowIndex) => {
                      const RowIcon = COMPARE_ROW_ICONS[row.key];
                      return (
                        <motion.tr
                          key={row.key}
                          initial={{ opacity: 0, x: -8 }}
                          whileInView={{ opacity: 1, x: 0 }}
                          viewport={viewport}
                          transition={{ duration: 0.4, delay: rowIndex * 0.04, ease: EASE }}
                          className={`group border-b border-border/60 transition-colors last:border-b-0 hover:bg-accent/[0.04] ${
                            rowIndex % 2 === 1 ? 'bg-bg-tertiary/40' : ''
                          }`}
                        >
                          <td
                            className={`sticky left-0 z-10 px-6 py-4 text-sm font-medium text-text-primary transition-colors group-hover:bg-accent/[0.04] ${
                              rowIndex % 2 === 1 ? 'bg-bg-tertiary/40' : 'bg-bg-secondary'
                            }`}
                          >
                            <span className="inline-flex items-center gap-2.5">
                              <RowIcon size={15} className="shrink-0 text-text-secondary/60" />
                              {row.label}
                            </span>
                          </td>
                          {PRICING_PLANS.map((plan) => (
                            <td
                              key={plan.id}
                              className={`px-4 py-4 text-center ${plan.recommended ? 'bg-accent/[0.06]' : ''}`}
                            >
                              <CompareCell value={getCompareValue(plan, row.key)} />
                            </td>
                          ))}
                        </motion.tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Pricing FAQ */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>Questions</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-text-primary md:text-4xl">
                Pricing FAQ
              </h2>
            </motion.div>

            <div className="mt-10 space-y-4">
              {PRICING_FAQS.map((faq, index) => (
                <motion.div
                  key={faq.q}
                  initial={{ opacity: 0, y: 14 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.4, delay: index * 0.06, ease: EASE }}
                >
                  <PricingFAQItem
                    q={faq.q}
                    a={faq.a}
                    isOpen={openFaq === index}
                    onToggle={() => setOpenFaq(openFaq === index ? null : index)}
                  />
                </motion.div>
              ))}
            </div>

            <p className="mt-8 text-center text-sm text-text-secondary">
              Have a question we didn&apos;t cover?{' '}
              <Link to="/faq" className="font-semibold text-accent hover:underline">
                Visit the full FAQ
              </Link>{' '}
              or{' '}
              <Link to="/contact" className="font-semibold text-accent hover:underline">
                contact us
              </Link>
              .
            </p>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-6 pb-24">
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
              <h2 className="text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                Stop losing jobs to voicemail
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Start your 14-day free trial today — no credit card required.
              </p>
              <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/login">
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    Start Free Trial
                    <ArrowRight size={18} />
                  </Button>
                </Link>
                                  <Link
                  to="/enterprise"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white/90 transition-colors hover:text-white"
                >
                  Talk to sales
                  <ArrowRight size={16} />
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
