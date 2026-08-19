import { motion } from 'framer-motion';
import { Check, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { TRIAL_URL } from '@/lib/site';

const STARTER_FEATURES = [
  '50 Minutes Included',
  'Basic Call Answering',
  'Standard Support',
  '14-Day Trial',
];

const PRO_FEATURES = [
  '1,500 Minutes Included',
  'Emergency Detection & Dispatch',
  'Smart Calendar Booking',
  'SMS Confirmations',
  'Call Summaries & CRM Sync',
  'Priority Support',
];

export function Pricing() {
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
            {"Start Your 14-Day Free Trial \u2014 No Credit Card Required"}
          </span>
          <p className={`${eyebrowClass()} mt-8`}>Pricing</p>
          <h2 className={sectionHeadingClass()}>Simple Pricing. No Surprises.</h2>
          <p className={`${bodyClass()} mx-auto`}>One powerful plan. Cancel anytime.</p>
        </motion.div>

        <div className="mx-auto mt-14 grid max-w-4xl items-start gap-6 md:grid-cols-2">
          {/* Starter */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="flex h-full flex-col rounded-2xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark"
          >
            <h3 className="text-lg font-semibold text-text-primary">Starter</h3>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-bold tracking-tight text-text-primary">$0</span>
              <span className="text-text-secondary">/month</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-text-secondary">
              Try Sarah risk-free. Perfect for seeing how AI answering works for your business.
            </p>
            <ul className="mt-6 flex flex-1 flex-col gap-3">
              {STARTER_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-3 text-sm text-text-primary">
                  <Check size={18} className="mt-0.5 shrink-0 text-accent" />
                  {f}
                </li>
              ))}
            </ul>
            <a href={TRIAL_URL} target="_blank" rel="noreferrer" className="mt-8">
              <Button variant="secondary" size="lg" className="w-full">
                Start Free
              </Button>
            </a>
          </motion.div>

          {/* Professional */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, delay: 0.08, ease: EASE }}
            className="relative flex h-full flex-col rounded-2xl border-2 border-accent bg-bg-secondary p-8 shadow-glow-accent"
          >
            <span className="absolute -top-3 right-6 inline-flex items-center rounded-full bg-accent px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white shadow-glow-accent animate-pulse">
              Recommended
            </span>
            <h3 className="text-lg font-semibold text-text-primary">Professional</h3>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-bold tracking-tight text-text-primary">$297</span>
              <span className="text-text-secondary">/month</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-text-secondary">
              Everything you need to never miss a call again. Replaces a $3,000/month receptionist.
            </p>
            <ul className="mt-6 flex flex-1 flex-col gap-3">
              {PRO_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-3 text-sm text-text-primary">
                  <Check size={18} className="mt-0.5 shrink-0 text-cta" />
                  {f}
                </li>
              ))}
            </ul>
            <a href={TRIAL_URL} target="_blank" rel="noreferrer" className="mt-8">
              <Button variant="primary" size="lg" className="w-full">
                Start Free Trial
              </Button>
            </a>
          </motion.div>
        </div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto mt-8 max-w-2xl text-center text-sm leading-relaxed text-text-secondary/80"
        >
          Fair use: 1,500 minutes/month included on Professional. Overage: $0.15/minute. No hidden
          fees, cancel anytime. Professional pays for itself with a single booked emergency job.
        </motion.p>
      </div>
    </section>
  );
}
