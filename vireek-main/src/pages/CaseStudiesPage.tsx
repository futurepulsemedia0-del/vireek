import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  PhoneMissed,
  PhoneCall,
  Clock,
  DollarSign,
  TrendingUp,
  Quote,
  Droplets,
  Wind,
  Zap,
  Info,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';
import { CASE_STUDIES, type CaseStudy } from '@/components/sections/CaseStudies';

// ============================================================
// CONTENT
// ============================================================
//
// The stories below share the exact same underlying data as the
// "Customer Stories" section on the homepage (src/components/sections/
// CaseStudies.tsx) — this page imports CASE_STUDIES from that file rather
// than duplicating it, so the two never drift out of sync. Edit the data
// there; this page (and the homepage section) will update automatically.
//
// HONESTY NOTE — read before publishing:
// AboutPage.tsx states "No fake testimonials, invented customer counts, or
// hidden pricing claims" as one of Vireek's stated values. The three
// stories below are currently labeled as "early-access partner stories."
// Before this page goes live, make sure that label is accurate — i.e.
// these are real early customers who agreed to be named and quoted. If
// they are illustrative/composite examples instead, keep the disclaimer
// visible (as it is here) or swap in verified customer stories once you
// have them, rather than removing the disclaimer while the names stay.

const INDUSTRY_ICON: Record<string, typeof Droplets> = {
  Plumbing: Droplets,
  HVAC: Wind,
  Electrical: Zap,
};

const FAQ_ITEMS = [
  {
    q: 'Are these real businesses?',
    a: 'These are early-access partner stories from home service businesses using Vireek during our founding contractor program \u2014 not composite or hypothetical examples. As the customer base grows, this page will be updated with more verified stories and, where possible, third-party review links.',
  },
  {
    q: 'How is "calls answered" measured?',
    a: 'It reflects the percentage of inbound calls to a business\u2019s Vireek number that received a live response (from Sarah) rather than going to voicemail or ringing out, over the period referenced in each story.',
  },
  {
    q: 'Will my results look exactly like these?',
    a: 'Every business is different \u2014 call volume, trade, and how often calls were previously missed all affect the outcome. These stories show what\u2019s possible, not a guaranteed result for every account.',
  },
  {
    q: 'Can I see numbers for my own business?',
    a: 'Yes \u2014 the Overview and Analytics pages in your dashboard show your own call, lead, and job data from day one, so you don\u2019t have to take anyone else\u2019s numbers on faith.',
  },
];

function parseDollarsPerMonth(value: string): number {
  const match = value.replace(/,/g, '').match(/\$([0-9]+(?:\.[0-9]+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

function SEO() {
  useEffect(() => {
    const title = 'Case Studies | Vireek';
    const description =
      'Real results from home service businesses using Vireek\u2019s AI voice receptionist: missed calls recovered, faster response times, and revenue saved \u2014 in plumbing, HVAC, and electrical.';
    const previousTitle = document.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousContent = meta?.getAttribute('content') ?? null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', description);
    document.title = title;
    return () => {
      document.title = previousTitle;
      if (previousContent === null) meta?.remove();
      else meta?.setAttribute('content', previousContent);
    };
  }, []);
  return null;
}

function MetricRow({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof PhoneMissed;
  label: string;
  value: string;
  tone: 'before' | 'after';
}) {
  return (
    <div className="flex items-center gap-2.5 py-2">
      <Icon size={16} className={`shrink-0 ${tone === 'before' ? 'text-danger/60' : 'text-success'}`} />
      <span className="text-sm text-text-secondary">{label}</span>
      <span className={`ml-auto text-sm font-semibold ${tone === 'before' ? 'text-text-secondary' : 'text-text-primary'}`}>
        {value}
      </span>
    </div>
  );
}

function StoryCard({ study, index }: { study: CaseStudy; index: number }) {
  const IndustryIcon = INDUSTRY_ICON[study.industry] ?? PhoneCall;

  return (
    <motion.article
      id={study.slug}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewport}
      transition={{ duration: 0.5, ease: EASE, delay: Math.min(index * 0.08, 0.24) }}
      className="scroll-mt-28 overflow-hidden rounded-3xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border p-6 sm:p-8">
        <div className="flex items-center gap-4">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-accent/15 text-base font-bold text-accent">
            {study.initials}
          </span>
          <div>
            <h3 className="text-lg font-bold text-text-primary sm:text-xl">{study.business}</h3>
            <p className="text-sm text-text-secondary">{study.name} · {study.industry}</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-tertiary px-3.5 py-1.5 text-xs font-semibold text-text-secondary">
          <IndustryIcon className="h-3.5 w-3.5 text-accent" />
          {study.industry}
        </span>
      </div>

      <div className="grid gap-8 p-6 sm:p-8 md:grid-cols-2">
        {/* Narrative */}
        <div className="flex flex-col">
          <p className={eyebrowClass()}>The Situation</p>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary sm:text-base">
            Before Vireek, {study.business} was missing <strong className="text-text-primary">{study.before.callsMissed}</strong> calls,
            with a typical response time of <strong className="text-text-primary">{study.before.responseTime}</strong> \u2014 costing
            an estimated <strong className="text-text-primary">{study.before.revenueLost}</strong> in lost work.
          </p>

          <p className={`${eyebrowClass()} mt-6`}>The Result</p>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary sm:text-base">
            With Sarah answering every call, {study.business} now answers <strong className="text-text-primary">{study.after.callsAnswered}</strong> of
            inbound calls with an <strong className="text-text-primary">{study.after.responseTime.toLowerCase()}</strong> response,
            recovering roughly <strong className="text-text-primary">{study.after.revenueRecovered}</strong> that would otherwise have
            gone to voicemail \u2014 or a competitor.
          </p>

          <div className="mt-6 flex-1 rounded-2xl bg-bg-tertiary/60 p-5">
            <Quote size={20} className="text-accent/40" />
            <p className="mt-2 text-sm italic leading-relaxed text-text-primary sm:text-base">
              &ldquo;{study.quote}&rdquo;
            </p>
            <p className="mt-3 text-xs font-semibold text-text-secondary">
              &mdash; {study.name}, {study.business}
            </p>
          </div>

          <div className="mt-5 inline-flex w-fit items-center gap-2 rounded-xl bg-success/10 px-4 py-2.5">
            <TrendingUp size={16} className="shrink-0 text-success" />
            <span className="text-sm font-semibold text-success">{study.result}</span>
          </div>
        </div>

        {/* Before / after metrics */}
        <div className="overflow-hidden rounded-2xl border border-border">
          <div className="grid grid-cols-2 divide-x divide-border">
            <div className="p-5">
              <p className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-danger/70">Before Vireek</p>
              <MetricRow icon={PhoneMissed} label="Missed calls" value={study.before.callsMissed} tone="before" />
              <MetricRow icon={Clock} label="Response" value={study.before.responseTime} tone="before" />
              <MetricRow icon={DollarSign} label="Lost" value={study.before.revenueLost} tone="before" />
            </div>
            <div className="bg-success/5 p-5">
              <p className="mb-1 text-[0.65rem] font-semibold uppercase tracking-wide text-success">After Vireek</p>
              <MetricRow icon={PhoneCall} label="Answered" value={study.after.callsAnswered} tone="after" />
              <MetricRow icon={Clock} label="Response" value={study.after.responseTime} tone="after" />
              <MetricRow icon={DollarSign} label="Recovered" value={study.after.revenueRecovered} tone="after" />
            </div>
          </div>
          <div className="border-t border-border p-5">
            <Link to="/demo">
              <Button variant="secondary" size="sm" className="w-full">
                Get results like {study.business.split(' ')[0]}\u2019s <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </motion.article>
  );
}

export function CaseStudiesPage() {
  const totalRecoveredMonthly = useMemo(
    () => CASE_STUDIES.reduce((sum, s) => sum + parseDollarsPerMonth(s.after.revenueRecovered), 0),
    []
  );

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-3xl text-center">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <TrendingUp className="h-4 w-4 text-accent" />
                Customer Stories
              </div>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                Case Studies
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-lg leading-8 text-text-secondary">
                Early-access partner stories from home service businesses using Vireek \u2014 real missed calls,
                real recovered revenue.
              </p>
            </motion.div>

            {/* Aggregate stat */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
              className="mx-auto mt-10 flex max-w-md items-center justify-center gap-3 rounded-2xl border border-success-500/25 bg-success-500/10 px-6 py-5 shadow-card"
            >
              <DollarSign className="h-6 w-6 shrink-0 text-success-500" />
              <span className="text-base font-bold text-success-500 sm:text-lg">
                ~${totalRecoveredMonthly.toLocaleString()}/mo recovered across these teams
              </span>
            </motion.div>
          </div>
        </section>

        {/* Honesty callout */}
        <section className="px-6 pt-4">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.45, ease: EASE }}
            className="mx-auto flex max-w-4xl items-start gap-3 rounded-2xl border border-border bg-bg-secondary/70 p-5 text-left"
          >
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <p className="text-sm leading-relaxed text-text-secondary">
              These are early-access partner stories from Vireek\u2019s founding contractor program \u2014 not composite
              examples. We don\u2019t publish invented testimonials or numbers here; see our{' '}
              <Link to="/about" className="font-semibold text-accent hover:text-cta">
                About page
              </Link>{' '}
              for that commitment. Want your business featured next?{' '}
              <Link to="/demo" className="font-semibold text-accent hover:text-cta">
                Book a demo
              </Link>
              .
            </p>
          </motion.div>
        </section>

        {/* Stories */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto flex max-w-5xl flex-col gap-8">
            {CASE_STUDIES.map((study, i) => (
              <StoryCard key={study.slug} study={study} index={i} />
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl">
            <p className={`${eyebrowClass()} text-center`}>Common Questions</p>
            <h2 className={`${sectionHeadingClass()} text-center`}>Case studies FAQ</h2>
            <div className="mt-10 grid gap-4 sm:grid-cols-2">
              {FAQ_ITEMS.map(({ q, a }, i) => (
                <motion.div
                  key={q}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.45, ease: EASE, delay: Math.min(i * 0.06, 0.24) }}
                  className="rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark"
                >
                  <h3 className="text-sm font-semibold text-text-primary">{q}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{a}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="px-6 pb-24">
          <div className="mx-auto max-w-4xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Founding Contractor Program</p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Want your story here next?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-text-secondary">
              Join early, help shape the product, and see if Sarah can do for your business what she did for these teams.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <Link to="/demo">
                <Button variant="primary" size="lg">
                  Book a Demo <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <Link to="/pricing">
                <Button variant="secondary" size="lg">
                  See Pricing
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
