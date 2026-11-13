// Recreated: verify against original intent (recovered verbatim from homepage-redesign.patch)
import { useState } from 'react';
import { Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ButtonAnchor, ButtonLink } from '@/components/ui/ButtonLink';
import { useCurrency } from '@/contexts/CurrencyContext';
import { useExperiment } from '@/contexts/ExperimentContext';
import { formatPrice } from '@/lib/currency';
import { HOME_PLAN_IDS } from '@/lib/homeContent';
import { trackHomeCta } from '@/lib/homeAnalytics';
import { PRICING_PLANS, getPlanHref, isExternalLink, type BillingCycle, type PricingPlan } from '@/lib/pricing';
import { container, eyebrow, h2, panel, sectionY, textLink } from './sectionStyles';

const PLANS = HOME_PLAN_IDS.map((id) => PRICING_PLANS.find((p) => p.id === id)).filter(
  (p): p is PricingPlan => p !== undefined,
);

export function HomePricing() {
  const { currency } = useCurrency();
  const variant = useExperiment('pricing_default_billing');
  const [billing, setBilling] = useState<BillingCycle>(variant === 'monthly' ? 'monthly' : 'annual');

  return (
    <section id="pricing" aria-labelledby="pricing-heading" className={`${sectionY} border-t border-border`}>
      <div className={container}>
        <p className={eyebrow}>Pricing</p>
        <h2 id="pricing-heading" className={h2}>Pick the plan that fits your call volume</h2>

        <div role="group" aria-label="Billing period" className="mt-6 inline-flex rounded-xl border border-border bg-bg-tertiary p-1">
          {(['monthly', 'annual'] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={billing === c}
              onClick={() => setBilling(c)}
              className={`focus-ring min-h-[44px] rounded-lg px-4 text-sm font-semibold ${
                billing === c ? 'bg-bg-secondary text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {c === 'monthly' ? 'Monthly' : 'Annual'}
            </button>
          ))}
        </div>

        <ul className="mt-8 grid gap-6 md:grid-cols-3">
          {PLANS.map((plan) => {
            const total = billing === 'annual' ? plan.annual : plan.monthly;
            const perMonth = total === null ? null : billing === 'annual' ? Math.round(total / 12) : total;
            const href = getPlanHref(plan.id, billing);
            const label = plan.ctaLabel;
            return (
              <li key={plan.id} className={`${panel} flex flex-col p-6 ${plan.recommended ? 'border-text-primary' : ''}`}>
                <h3 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
                  {plan.name}
                  {plan.recommended && (
                    <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-text-secondary">Most popular</span>
                  )}
                </h3>
                <p className="mt-1 min-h-[2.5rem] text-sm text-text-secondary">{plan.tagline}</p>
                <p className="mt-4 font-display text-4xl font-semibold text-text-primary">
                  {perMonth === null ? 'Custom' : formatPrice(perMonth, currency)}
                  {perMonth !== null && <span className="text-sm font-normal text-text-secondary"> /mo</span>}
                </p>
                <p className="mt-1 text-xs text-text-secondary">
                  {billing === 'annual' && total !== null ? `Billed ${formatPrice(total, currency)} a year` : 'Billed monthly'} · {plan.minutes} included
                </p>
                <ul className="mt-4 flex-1 space-y-2 text-sm text-text-primary">
                  {plan.features.slice(0, 4).map((f) => (
                    <li key={f} className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden="true" />{f}</li>
                  ))}
                </ul>
                {isExternalLink(plan.id) ? (
                  <ButtonAnchor href={href} variant={plan.recommended ? 'primary' : 'secondary'} className="mt-6 w-full" onClick={() => trackHomeCta('pricing_plan', { plan: plan.id, billing })}>
                    {label}<span className="sr-only"> — {plan.name}</span>
                  </ButtonAnchor>
                ) : (
                  <ButtonLink to={href} variant={plan.recommended ? 'primary' : 'secondary'} className="mt-6 w-full" onClick={() => trackHomeCta('pricing_plan', { plan: plan.id, billing })}>
                    {label}<span className="sr-only"> — {plan.name}</span>
                  </ButtonLink>
                )}
              </li>
            );
          })}
        </ul>

        <p className="mt-6 text-sm text-text-secondary">
          14-day free trial, no credit card. No contracts, cancel anytime. There is also a Free plan with 50 minutes.
        </p>
        <Link to="/pricing" className={textLink}>Compare every plan</Link>
      </div>
    </section>
  );
}
