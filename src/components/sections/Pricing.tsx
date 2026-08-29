import { motion } from 'framer-motion';
import { Check, ShieldCheck, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';

const STRIPE_CHECKOUT_URL = 'https://buy.stripe.com/5kQ7sK450c57checve5wI00';

const STARTER_FEATURES = [
  '50 Minutes Included',
  'Basic Call Answering',
  'Standard Support',
  '14-Day Trial',
];

const PRO_FEATURES = [
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
          <h2 className={sectionHeadingClass()}>Start small. Scale call coverage when it proves ROI.</h2>
          <p className={`${bodyClass()} mx-auto`}>Transparent plans for validating Vireek quickly, then standardizing AI call coverage across your business.</p>
        </motion.div>

        <div className="mx-auto mt-14 grid max-w-5xl items-stretch gap-6 md:grid-cols-2">
          {/* Trial */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="flex h-full flex-col rounded-3xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark"
          >
            <h3 className="text-lg font-semibold text-text-primary">Starter</h3>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-bold tracking-tight text-text-primary">$0</span>
              <span className="text-text-secondary">/month</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-text-secondary">
              Validate Sarah risk-free with 50 included minutes and hear exactly how she handles your real callers.
            </p>
            <ul className="mt-6 flex flex-1 flex-col gap-3">
              {STARTER_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-3 text-sm text-text-primary">
                  <Check size={18} className="mt-0.5 shrink-0 text-accent" />
                  {f}
                </li>
              ))}
            </ul>
            <Link to="/login" className="mt-8">
              <Button variant="secondary" size="lg" className="w-full">
                Start Free
              </Button>
            </Link>
          </motion.div>

          {/* Growth */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, delay: 0.08, ease: EASE }}
            className="relative flex h-full flex-col rounded-3xl border-2 border-accent bg-bg-secondary p-8 shadow-glow-accent"
          >
            <span className="absolute -top-3 right-6 inline-flex items-center rounded-full bg-accent px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white shadow-glow-accent animate-pulse">
              Most popular
            </span>
            <h3 className="text-lg font-semibold text-text-primary">Professional</h3>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-bold tracking-tight text-text-primary">$297</span>
              <span className="text-text-secondary">/month</span>
            </div>
            <div className="mt-4 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3">
              <p className="text-sm font-semibold text-accent">1,500 Minutes Included</p>
              <p className="mt-0.5 text-xs text-text-secondary">
                Enough for 300+ calls a month — most contractors never reach the limit.
              </p>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-text-secondary">
              A complete AI receptionist system for teams ready to capture after-hours demand, route emergencies, and reduce admin work.
            </p>
            <ul className="mt-6 flex flex-1 flex-col gap-3">
              {PRO_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-3 text-sm text-text-primary">
                  <Check size={18} className="mt-0.5 shrink-0 text-cta" />
                  {f}
                </li>
              ))}
            </ul>
            <a
              href={STRIPE_CHECKOUT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-8"
            >
              <Button variant="primary" size="lg" className="w-full gap-2">
                Start Free Trial
                <ArrowRight size={18} />
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
          1,500 minutes covers roughly 300+ calls a month for most contractors. Most businesses
          never reach the limit. Additional usage is a clear $0.15/minute shown on your bill. No
          contracts, no hidden fees, cancel anytime.
        </motion.p>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
          className="mx-auto mt-4 flex max-w-2xl items-center justify-center gap-2 text-center"
        >
          <ShieldCheck size={15} className="shrink-0 text-accent" />
          <p className="text-xs font-medium leading-relaxed text-text-secondary/70">
            Vireek includes 1,500 minutes/month so contractors can handle more customer calls confidently.
          </p>
        </motion.div>
      </div>
    </section>
  );
}
