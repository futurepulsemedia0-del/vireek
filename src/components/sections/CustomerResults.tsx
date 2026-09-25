import { motion } from 'framer-motion';
import { Info, TrendingUp, DollarSign, Clock, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { CountUp } from '@/components/ui/CountUp';

/* ------------------------------------------------------------------ */
/*  Data                                                                */
/* ------------------------------------------------------------------ */
//
// IMPORTANT — read before editing:
// If the business below is a real Vireek customer with verified numbers,
// remove the disclaimer banner in this section and replace `business`
// with their real name. Until then, this stays labeled as illustrative,
// matching the exact convention already established in CaseStudiesPage.tsx
// and TestimonialsPage.tsx — Vireek does not publish fabricated verified
// testimonials. See /about for that commitment.

interface ResultMetric {
  business: string;
  industry: string;
  timeframe: string;
  conversionBefore: string;
  conversionAfter: string;
  conversionChange: string;
  revenueRecovered: string;
  summary: string;
}

const RESULT: ResultMetric = {
  business: 'Coastal Plumbing Co.',
  industry: 'Plumbing',
  timeframe: '60 days',
  conversionBefore: '31%',
  conversionAfter: '73%',
  conversionChange: '+42%',
  revenueRecovered: '$18,000',
  summary:
    'Every estimate that used to sit unanswered now gets an automatic follow-up call and text within hours — not whenever someone remembers.',
};

/* ------------------------------------------------------------------ */
/*  Main section                                                       */
/* ------------------------------------------------------------------ */

export function CustomerResults() {
  return (
    <section className="py-16 sm:py-24 md:py-28">
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-2xl text-center"
        >
          <p className={eyebrowClass()}>Customer Results</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>
            The Numbers, Not Just a Quote
          </h2>
          <p className={`${bodyClass()} mx-auto text-sm sm:text-base md:text-lg`}>
            No vague praise — just what changed, measured in dollars and conversion rate.
          </p>
        </motion.div>

        {/* Disclaimer — required whenever the figures below aren't yet a verified,
            named customer. See CaseStudiesPage.tsx for the source of this convention. */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.45, ease: EASE }}
          className="mx-auto mt-8 flex max-w-3xl items-start gap-3 rounded-2xl border border-border bg-bg-secondary/70 p-4 text-left sm:mt-10"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <p className="text-xs leading-relaxed text-text-secondary sm:text-sm">
            This is an illustrative example of the kind of outcome Vireek is designed to produce
            — Vireek is early-stage and doesn&apos;t publish invented customer counts or
            fabricated verified testimonials; see our{' '}
            <Link to="/about" className="font-semibold text-accent hover:text-cta">
              About page
            </Link>{' '}
            for that commitment. Want your business featured next, with real numbers?{' '}
            <Link to="/demo" className="font-semibold text-accent hover:text-cta">
              Book a demo
            </Link>
            .
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.55, ease: EASE, delay: 0.1 }}
          className="mx-auto mt-8 max-w-4xl overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark sm:mt-10"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-bg-tertiary/60 px-6 py-4">
            <div>
              <p className="text-sm font-semibold text-text-primary">{RESULT.business}</p>
              <p className="text-xs text-text-secondary">{RESULT.industry}</p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
              <Clock size={12} />
              First {RESULT.timeframe} on Vireek
            </span>
          </div>

          <div className="grid gap-6 p-6 sm:grid-cols-2 sm:p-10">
            {/* Conversion metric */}
            <div>
              <div className="flex items-center gap-2 text-text-secondary">
                <TrendingUp size={16} className="text-success" />
                <p className="text-sm font-medium">Estimate conversion rate</p>
              </div>
              <div className="mt-3 flex items-end gap-3">
                <span className="text-lg font-medium text-text-secondary/60 line-through">
                  {RESULT.conversionBefore}
                </span>
                <ArrowRight size={16} className="mb-1.5 text-text-secondary/40" />
                <span className="text-4xl font-bold tracking-tight text-success sm:text-5xl">
                  <CountUp value={RESULT.conversionAfter} />
                </span>
              </div>
              <p className="mt-2 text-sm font-semibold text-success">
                {RESULT.conversionChange} in {RESULT.timeframe}
              </p>
            </div>

            {/* Revenue metric */}
            <div className="border-t border-border pt-6 sm:border-l sm:border-t-0 sm:pl-8 sm:pt-0">
              <div className="flex items-center gap-2 text-text-secondary">
                <DollarSign size={16} className="text-accent" />
                <p className="text-sm font-medium">Revenue recovered</p>
              </div>
              <div className="mt-3">
                <span className="text-4xl font-bold tracking-tight text-accent sm:text-5xl">
                  <CountUp value={RESULT.revenueRecovered} />
                </span>
              </div>
              <p className="mt-2 text-sm text-text-secondary">
                From estimates that would otherwise have gone cold.
              </p>
            </div>
          </div>

          <p className="border-t border-border bg-bg-tertiary/40 px-6 py-4 text-sm leading-relaxed text-text-secondary sm:px-10">
            {RESULT.summary}
          </p>
        </motion.div>
      </div>
    </section>
  );
}
