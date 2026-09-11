import { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Check, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { CurrencySwitcher } from '@/components/CurrencySwitcher';
import { useCurrency } from '@/contexts/CurrencyContext';
import { formatPrice } from '@/lib/currency';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import {
  PRICING_PLANS,
  getPlanHref,
  isExternalLink,
  type BillingCycle,
} from '@/lib/pricing';

const CORE_PLANS = PRICING_PLANS.filter((plan) => plan.core);

export function Pricing() {
  const [billing, setBilling] = useState<BillingCycle>('annual');
  const { currency } = useCurrency();

  return (
    <section id="pricing" className="py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-3xl text-center"
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-cta/40 bg-cta/10 px-4 py-1.5 text-sm font-semibold text-cta">
            <ShieldCheck size={16} />
            {'Start Your 14-Day Free Trial \u2014 No Credit Card Required'}
          </span>
          <p className={`${eyebrowClass()} mt-8`}>Pricing</p>
          <h2 className={sectionHeadingClass()}>Simple Pricing. No Surprises.</h2>
          <p className={`${bodyClass()} mx-auto`}>Pick a plan, cancel anytime.</p>
        </motion.div>

        {/* Billing toggle + currency switcher */}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <CurrencySwitcher />
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

        <div className="mx-auto mt-10 grid max-w-4xl items-start gap-6 md:grid-cols-2">
          {CORE_PLANS.map((plan, index) => {
            const price = billing === 'annual' ? plan.annual! : plan.monthly!;
            const displayPrice = billing === 'annual' ? Math.round(price / 12) : price;
            const href = getPlanHref(plan.id, billing);
            const external = isExternalLink(plan.id);

            return (
              <motion.div
                key={plan.id}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, delay: index * 0.06, ease: EASE }}
                className={
                  plan.recommended
                    ? 'relative flex h-full flex-col rounded-2xl border-2 border-accent bg-bg-secondary p-8 shadow-glow-accent'
                    : 'flex h-full flex-col rounded-2xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark'
                }
              >
                {plan.recommended && (
                  <span className="animate-glow-slow absolute -top-3 right-6 inline-flex items-center rounded-full bg-accent px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
                    Most popular
                  </span>
                )}

                <h3 className="text-lg font-semibold text-text-primary">{plan.name}</h3>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-4xl font-bold tracking-tight text-text-primary">
                    {formatPrice(displayPrice, currency)}
                  </span>
                  <span className="text-text-secondary">/month</span>
                </div>
                <p className="mt-1 text-xs font-medium text-text-secondary/70">
                  {billing === 'annual' ? `billed ${formatPrice(price, currency)}/year` : 'billed monthly'}
                </p>

                {plan.recommended && (
                  <div className="mt-4 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3">
                    <p className="text-sm font-semibold text-accent">{plan.minutes} included</p>
                    <p className="mt-0.5 text-xs text-text-secondary">
                      Enough for 300+ calls a month — most contractors never reach the limit.
                    </p>
                  </div>
                )}

                <p className="mt-3 text-sm leading-relaxed text-text-secondary">{plan.tagline}</p>

                <ul className="mt-6 flex flex-1 flex-col gap-3">
                  {plan.features.slice(0, 5).map((f) => (
                    <li key={f} className="flex items-start gap-3 text-sm text-text-primary">
                      <Check
                        size={18}
                        className={`mt-0.5 shrink-0 ${plan.recommended ? 'text-cta' : 'text-accent'}`}
                      />
                      {f}
                    </li>
                  ))}
                </ul>

                {external ? (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="mt-8">
                    <Button
                      variant={plan.recommended ? 'primary' : 'secondary'}
                      size="lg"
                      className="w-full gap-2"
                    >
                      {plan.ctaLabel}
                      {plan.recommended && <ArrowRight size={18} />}
                    </Button>
                  </a>
                ) : (
                  <Link to={href} className="mt-8">
                    <Button
                      variant={plan.recommended ? 'primary' : 'secondary'}
                      size="lg"
                      className="w-full"
                    >
                      {plan.ctaLabel}
                    </Button>
                  </Link>
                )}
                <p className="mt-2 flex items-center justify-center gap-1.5 text-center text-xs font-medium text-text-secondary/70">
                  <ShieldCheck size={13} className="shrink-0 text-text-secondary/50" />
                  {plan.ctaHint}
                </p>
              </motion.div>
            );
          })}
        </div>

        {/* See full comparison */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.15, ease: EASE }}
          className="mt-10 flex justify-center"
        >
          <Link
            to="/pricing"
            className="focus-ring inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary px-6 py-3 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
          >
            See all plans &amp; full comparison
            <ArrowRight size={16} />
          </Link>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
          className="mx-auto mt-8 flex max-w-2xl items-center justify-center gap-2 text-center"
        >
          <ShieldCheck size={15} className="shrink-0 text-accent" />
          <p className="text-xs font-medium leading-relaxed text-text-secondary/70">
            No contracts, no hidden fees, cancel anytime. Need more minutes, seats, or locations?
            Compare Free, Starter, Professional, Business and Enterprise on the full pricing page.
          </p>
        </motion.div>
      </div>
    </section>
  );
}
