import { motion } from 'framer-motion';
import { ArrowRight, Check, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { PRICING_PLANS } from '@/lib/pricing';

const TEASER_PLAN_IDS = ['free', 'starter', 'professional', 'business'] as const;
const TEASER_PLANS = TEASER_PLAN_IDS
  .map((id) => PRICING_PLANS.find((p) => p.id === id))
  .filter((p): p is NonNullable<typeof p> => p !== undefined);

export function PricingTeaser() {
  return (
    <section id="pricing" className="py-16 sm:py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-3xl text-center"
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-cta/40 bg-cta/10 px-3 py-1.5 text-xs font-semibold text-cta sm:px-4">
            <ShieldCheck size={14} className="sm:size-4" />
            {'14-Day Free Trial — No Credit Card Required'}
          </span>
          <p className={`${eyebrowClass()} mt-6 sm:mt-8`}>{'Pricing'}</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>{'Simple Pricing. No Surprises.'}</h2>
          <p className={`${bodyClass()} text-sm sm:text-base md:text-lg`}>{'Pick a plan, cancel anytime.'}</p>
        </motion.div>

        {/* Mobile: horizontal scroll cards */}
        <div className="mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-4 sm:mt-12 sm:hidden">
          {TEASER_PLANS.map((plan, index) => (
            <motion.div
              key={plan.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.4, delay: index * 0.05, ease: EASE }}
              className={`flex w-[75%] shrink-0 snap-center flex-col rounded-2xl p-5 ${
                plan.recommended
                  ? 'border-2 border-accent bg-bg-secondary shadow-glow-accent'
                  : 'border border-border bg-bg-secondary shadow-card dark:shadow-card-dark'
              }`}
            >
              {plan.recommended && (
                <span className="absolute -top-3 right-4 inline-flex items-center rounded-full bg-accent px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-white">
                  Most popular
                </span>
              )}
              <h3 className="text-base font-semibold text-text-primary">{plan.name}</h3>
              <div className="mt-3 flex items-baseline gap-1">
                {plan.monthly === 0 ? (
                  <span className="text-3xl font-bold tracking-tight text-text-primary">Free</span>
                ) : plan.monthly === null ? (
                  <span className="text-3xl font-bold tracking-tight text-text-primary">Custom</span>
                ) : (
                  <>
                    <span className="text-3xl font-bold tracking-tight text-text-primary">${plan.monthly}</span>
                    <span className="text-sm text-text-secondary">/mo</span>
                  </>
                )}
              </div>
              <p className="mt-1 text-xs font-medium text-text-secondary/70">
                {plan.monthly === 0
                  ? 'No card required'
                  : plan.monthly === null
                    ? `from $${plan.startingAt}/mo`
                    : `or $${plan.annual}/yr`}
              </p>
              <p className="mt-3 text-xs font-medium text-accent">{plan.minutes} included</p>
              <ul className="mt-4 flex flex-1 flex-col gap-2">
                {plan.features.slice(0, 3).map((f) => (
                  <li key={f} className="flex items-start gap-2 text-xs text-text-primary">
                    <Check size={14} className={`mt-0.5 shrink-0 ${plan.recommended ? 'text-cta' : 'text-accent'}`} />
                    {f}
                  </li>
                ))}
              </ul>
              <Link to="/pricing" className="mt-5">
                <Button variant={plan.recommended ? 'primary' : 'secondary'} size="sm" className="w-full">
                  {plan.ctaLabel}
                </Button>
              </Link>
            </motion.div>
          ))}
        </div>

        {/* Desktop: grid */}
        <div className="mt-12 hidden max-w-5xl gap-5 sm:grid sm:grid-cols-2 lg:grid-cols-4">
          {TEASER_PLANS.map((plan, index) => (
            <motion.div
              key={plan.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.4, delay: index * 0.05, ease: EASE }}
              className={
                plan.recommended
                  ? 'relative flex h-full flex-col rounded-2xl border-2 border-accent bg-bg-secondary p-6 shadow-glow-accent'
                  : 'flex h-full flex-col rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark'
              }
            >
              {plan.recommended && (
                <span className="absolute -top-3 right-4 inline-flex items-center rounded-full bg-accent px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-white">
                  Most popular
                </span>
              )}
              <h3 className="text-base font-semibold text-text-primary">{plan.name}</h3>
              <div className="mt-3 flex items-baseline gap-1">
                {plan.monthly === 0 ? (
                  <span className="text-3xl font-bold tracking-tight text-text-primary">Free</span>
                ) : plan.monthly === null ? (
                  <span className="text-3xl font-bold tracking-tight text-text-primary">Custom</span>
                ) : (
                  <>
                    <span className="text-3xl font-bold tracking-tight text-text-primary">${plan.monthly}</span>
                    <span className="text-sm text-text-secondary">/mo</span>
                  </>
                )}
              </div>
              <p className="mt-1 text-xs font-medium text-text-secondary/70">
                {plan.monthly === 0
                  ? 'No card required'
                  : plan.monthly === null
                    ? `from $${plan.startingAt}/mo`
                    : `or $${plan.annual}/yr`}
              </p>
              <p className="mt-3 text-xs font-medium text-accent">{plan.minutes} included</p>
              <ul className="mt-4 flex flex-1 flex-col gap-2">
                {plan.features.slice(0, 3).map((f) => (
                  <li key={f} className="flex items-start gap-2 text-xs text-text-primary">
                    <Check size={14} className={`mt-0.5 shrink-0 ${plan.recommended ? 'text-cta' : 'text-accent'}`} />
                    {f}
                  </li>
                ))}
              </ul>
              <Link to="/pricing" className="mt-5">
                <Button variant={plan.recommended ? 'primary' : 'secondary'} size="sm" className="w-full">
                  {plan.ctaLabel}
                </Button>
              </Link>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.15, ease: EASE }}
          className="mt-8 flex flex-col items-center justify-center gap-3 sm:mt-10 sm:flex-row sm:gap-4"
        >
          <Link
            to="/pricing"
            className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-full border border-border bg-bg-secondary px-6 py-3 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent sm:w-auto"
          >
            See Full Pricing &amp; Plans
            <ArrowRight size={16} />
          </Link>
          <p className="flex items-center gap-1.5 text-xs font-medium text-text-secondary/70">
            <ShieldCheck size={13} className="shrink-0 text-accent" />
            No contracts, no hidden fees, cancel anytime.
          </p>
        </motion.div>
      </div>
    </section>
  );
}
