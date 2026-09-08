import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import {
  XCircle, TrendingUp, Clock, DollarSign,
  PhoneMissed, PhoneCall, Quote, ArrowRight,
} from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

export interface CaseStudy {
  slug: string;
  name: string;
  business: string;
  industry: string;
  initials: string;
  before: { callsMissed: string; responseTime: string; revenueLost: string };
  after: { callsAnswered: string; responseTime: string; revenueRecovered: string };
  quote: string;
  result: string;
}

export const CASE_STUDIES: CaseStudy[] = [
  {
    slug: 'ramirez-plumbing',
    name: 'Marcus R.',
    business: 'Ramirez Plumbing',
    industry: 'Plumbing',
    initials: 'MR',
    before: { callsMissed: '14/week', responseTime: '4+ hours', revenueLost: '$3,200/mo' },
    after: { callsAnswered: '100%', responseTime: 'Instant', revenueRecovered: '$3,200/mo' },
    quote: 'Sarah caught a burst pipe call at 1am that would have gone to voicemail. The customer was booked and dispatched before I even woke up.',
    result: 'Saved a $2,800 emergency job',
  },
  {
    slug: 'apex-heating-air',
    name: 'Jenna T.',
    business: 'Apex Heating & Air',
    industry: 'HVAC',
    initials: 'JT',
    before: { callsMissed: '9/day on-site', responseTime: 'End of day', revenueLost: '$2,100/mo' },
    after: { callsAnswered: '100%', responseTime: 'Instant', revenueRecovered: '$2,100/mo' },
    quote: 'I was on a roof all day and missed 9 calls. Sarah booked 6 of them. That\'s a week of work I would have lost.',
    result: '6 jobs booked while on-site',
  },
  {
    slug: 'volt-electric',
    name: 'Steve K.',
    business: 'Volt Electric',
    industry: 'Electrical',
    initials: 'SK',
    before: { callsMissed: '11/day', responseTime: 'Next day', revenueLost: '$1,800/mo' },
    after: { callsAnswered: '100%', responseTime: 'Instant', revenueRecovered: '$1,800/mo' },
    quote: 'Setup took 15 minutes. By the end of the first day, Sarah had answered 11 calls and booked 4 appointments. I was skeptical — not anymore.',
    result: '4 appointments on day one',
  },
];

function MetricRow({ icon: Icon, label, value, tone }: {
  icon: typeof XCircle; label: string; value: string; tone: 'before' | 'after';
}) {
  return (
    <div className="flex items-center gap-2.5 py-2">
      <Icon size={15} className={`shrink-0 ${tone === 'before' ? 'text-danger/60' : 'text-success'}`} />
      <span className="text-xs text-text-secondary">{label}</span>
      <span className={`ml-auto text-xs font-semibold ${tone === 'before' ? 'text-text-secondary' : 'text-text-primary'}`}>
        {value}
      </span>
    </div>
  );
}

export function CaseStudies() {
  return (
    <section id="case-studies" className="py-16 sm:py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-3xl text-center"
        >
          <p className={eyebrowClass()}>{'Customer Stories'}</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>
            Contractors Recover Lost Revenue With Vireek
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-text-secondary sm:mt-5 sm:text-base md:text-lg">
            Real businesses, real results. See the difference Vireek makes from day one.
          </p>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-10 grid gap-5 sm:mt-14 lg:grid-cols-3"
        >
          {CASE_STUDIES.map((study) => (
            <motion.div
              key={study.name}
              id={study.slug}
              variants={fadeUpItem}
              transition={{ duration: 0.5, ease: EASE }}
              className="flex h-full scroll-mt-28 flex-col overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card transition-all duration-300 hover:-translate-y-1 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
            >
              {/* Profile header */}
              <div className="flex items-center gap-3 border-b border-border p-5">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-bold text-accent">
                  {study.initials}
                </span>
                <div>
                  <p className="text-sm font-semibold text-text-primary">{study.name}</p>
                  <p className="text-xs text-text-secondary">{study.business} · {study.industry}</p>
                </div>
              </div>

              {/* Before / After metrics */}
              <div className="grid grid-cols-2 divide-x divide-border">
                <div className="p-4">
                  <p className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-danger/70">Before</p>
                  <MetricRow icon={PhoneMissed} label="Missed calls" value={study.before.callsMissed} tone="before" />
                  <MetricRow icon={Clock} label="Response" value={study.before.responseTime} tone="before" />
                  <MetricRow icon={DollarSign} label="Lost" value={study.before.revenueLost} tone="before" />
                </div>
                <div className="bg-success/5 p-4">
                  <p className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-success">After</p>
                  <MetricRow icon={PhoneCall} label="Answered" value={study.after.callsAnswered} tone="after" />
                  <MetricRow icon={Clock} label="Response" value={study.after.responseTime} tone="after" />
                  <MetricRow icon={DollarSign} label="Recovered" value={study.after.revenueRecovered} tone="after" />
                </div>
              </div>

              {/* Quote */}
              <div className="flex flex-1 flex-col p-5">
                <Quote size={20} className="text-accent/30" />
                <p className="mt-2 flex-1 text-xs leading-relaxed text-text-primary sm:text-sm">
                  &ldquo;{study.quote}&rdquo;
                </p>
                <div className="mt-4 flex items-center gap-1.5 rounded-lg bg-success/10 px-3 py-2">
                  <TrendingUp size={14} className="shrink-0 text-success" />
                  <span className="text-xs font-semibold text-success">{study.result}</span>
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
          className="mt-6 text-center text-xs text-text-secondary/60 sm:mt-8"
        >
          These are early-access partner stories. Want to be featured here? Join our founding contractor program.
        </motion.p>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.28, ease: EASE }}
          className="mt-4 text-center"
        >
          <Link
            to="/case-studies"
            className="focus-ring inline-flex items-center gap-1.5 rounded text-sm font-semibold text-accent transition-colors hover:text-cta"
          >
            View all case studies <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
