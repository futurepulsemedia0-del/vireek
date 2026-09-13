import { FormEvent, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight, BarChart3, CheckCircle2, Database, FileText,
  Mail, Newspaper, ShieldCheck, Sparkles, Users,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

// IMPORTANT — before this page goes live, or once real data exists:
// this page intentionally contains ZERO invented statistics. Every
// number in a published "State of X" report has to be sourced and
// defensible, or it becomes a liability the moment a journalist or
// competitor asks for methodology. Replace the "Coming in the First
// Edition" section with real findings once data collection is
// complete, and add a methodology footnote with your actual sample
// size and date range at that time.

const EMAIL = 'ali@vireek.com';
// Swap for a dedicated form endpoint before launch — do not reuse the
// contact-page endpoint, so report signups don't mix with support inbox.
const FORM_ENDPOINT = 'https://formspree.io/f/xrpgweza';

const METHODOLOGY_POINTS = [
  {
    icon: Database,
    title: 'Aggregated, anonymized call data',
    body: 'Sourced from calls handled on the Vireek platform and, where partners opt in, other participating home-service phone systems. No individual business or customer is ever identifiable in the published report.',
  },
  {
    icon: BarChart3,
    title: 'Full calendar year of data',
    body: 'The first edition will cover a full 12-month period so seasonal trends (like HVAC call spikes in summer) are represented fairly rather than skewed by a short sample window.',
  },
  {
    icon: ShieldCheck,
    title: 'Independent methodology, published in full',
    body: 'Sample size, data sources, and how each metric is calculated will be published alongside the findings — not just the headline numbers — so the report can be verified and cited with confidence.',
  },
];

const PLANNED_TOPICS = [
  'What share of inbound calls to home-service businesses go unanswered, and when',
  'How response speed affects whether a caller becomes a booked job',
  'Which call types most often turn into emergencies vs. routine bookings',
  'How after-hours and weekend call volume compares to business-hours volume',
  'Regional and seasonal patterns across HVAC, plumbing, electrical, and roofing',
];

type FormState = 'idle' | 'loading' | 'success' | 'error';

function EarlyAccessForm() {
  const [email, setEmail] = useState('');
  const [isDataPartner, setIsDataPartner] = useState(false);
  const [state, setState] = useState<FormState>('idle');
  const [error, setError] = useState('');

  const validateEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (state === 'loading' || state === 'success') return;

    if (!email.trim() || !validateEmail(email)) {
      setState('error');
      setError('Please enter a valid email address.');
      return;
    }

    setState('loading');
    setError('');
    try {
      const response = await fetch(FORM_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, isDataPartner, source: 'report-early-access' }),
      });
      if (response.ok) {
        setState('success');
      } else {
        setState('error');
        setError('Something went wrong. Please try again.');
      }
    } catch {
      setState('error');
      setError('Something went wrong. Please try again.');
    }
  };

  if (state === 'success') {
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-success">
          <CheckCircle2 size={30} />
        </span>
        <h3 className="mt-5 text-xl font-bold text-text-primary">You&rsquo;re on the list</h3>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-text-secondary">
          We&rsquo;ll email you the first edition the moment it publishes &mdash; and nothing else in
          the meantime.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="mt-2">
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (state === 'error') setState('idle');
          }}
          placeholder="you@company.com"
          aria-label="Email address"
          disabled={state === 'loading'}
          className="focus-ring w-full flex-1 rounded-xl border border-border bg-bg-primary px-4 py-3.5 text-base text-text-primary placeholder:text-text-secondary/50 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={state === 'loading'}
          className="focus-ring inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-accent px-6 py-3.5 font-semibold text-white shadow-glow-accent transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-80"
        >
          {state === 'loading' ? 'Submitting…' : 'Notify Me'}
          {state !== 'loading' && <ArrowRight size={16} />}
        </button>
      </div>
      <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={isDataPartner}
          onChange={(e) => setIsDataPartner(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-accent focus:ring-accent"
        />
        <span>
          I run a home-service business or platform and I&rsquo;m interested in contributing
          anonymized call data as a data partner.
        </span>
      </label>
      {state === 'error' && <p className="mt-2 text-sm text-danger">{error}</p>}
      <p className="mt-3 text-xs text-text-secondary/60">No spam. Unsubscribe anytime.</p>
    </form>
  );
}

export function ReportPage() {
  useSEO({
    title: 'The State of Home Service Calls Report | Vireek',
    description:
      'An annual, independently-methodologied report on how home-service businesses handle inbound calls — response times, missed-call rates, and booking outcomes. Get notified when the first edition publishes.',
    canonical: 'https://vireek.com/report',
  });

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
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
              <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-1.5 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <FileText className="h-4 w-4 text-accent" />
                Annual Industry Report &mdash; First Edition in Progress
              </div>
              <p className={eyebrowClass()}>Vireek Research</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                The State of Home Service Calls
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                An annual, independently-methodologied look at how home-service businesses
                actually handle inbound calls &mdash; response speed, missed-call rates, and what
                turns a call into a booked job. Built on real, anonymized call data, not survey
                guesses.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Early access form */}
        <section className="px-6 pb-16">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="mx-auto max-w-2xl rounded-2xl border border-accent/25 bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Mail size={20} />
              </span>
              <h2 className="text-lg font-bold text-text-primary sm:text-xl">
                Get the first edition, the day it publishes
              </h2>
            </div>
            <EarlyAccessForm />
          </motion.div>
        </section>

        {/* Why this report */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
            >
              <p className={eyebrowClass()}>Why We&rsquo;re Building This</p>
              <h2 className={sectionHeadingClass()}>
                Most decisions about phone coverage are made on gut feel
              </h2>
              <p className={bodyClass()}>
                Home-service businesses make real staffing and budget decisions &mdash; whether to
                hire a receptionist, pay for an answering service, or accept missed calls &mdash;
                largely without industry-wide data on what&rsquo;s actually happening on the other
                end of the phone. We think that deserves a real, citable answer, updated every
                year as calling patterns change.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Methodology */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Methodology</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                Built to be cited, not just read
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                A report is only as useful as its methodology. Here&rsquo;s what will back every
                number in the first edition.
              </p>
            </motion.div>

            <div className="mt-12 grid gap-6 md:grid-cols-3">
              {METHODOLOGY_POINTS.map((point, index) => (
                <motion.div
                  key={point.title}
                  initial={{ opacity: 0, y: 18 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.45, delay: index * 0.08, ease: EASE }}
                  className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-tertiary text-text-secondary">
                    <point.icon size={18} />
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-text-primary">{point.title}</h3>
                  <p className="mt-3 text-sm leading-relaxed text-text-secondary">{point.body}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Planned topics */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
            >
              <div className="flex items-center gap-3">
                <Sparkles className="h-5 w-5 text-accent" />
                <h2 className="text-lg font-bold text-text-primary sm:text-xl">
                  What the first edition will cover
                </h2>
              </div>
              <ul className="mt-5 space-y-3">
                {PLANNED_TOPICS.map((topic) => (
                  <li key={topic} className="flex items-start gap-3 text-sm leading-relaxed text-text-secondary sm:text-base">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    {topic}
                  </li>
                ))}
              </ul>
            </motion.div>
          </div>
        </section>

        {/* Data partners */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="grid gap-8 rounded-2xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark md:grid-cols-[auto_1fr] md:items-center md:p-10"
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
                <Users size={26} />
              </span>
              <div>
                <h2 className="text-xl font-bold text-text-primary sm:text-2xl">
                  Run a home-service business or platform? Become a data partner.
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-text-secondary sm:text-base">
                  A report built on one company&rsquo;s data reflects one company. A report built
                  across many businesses and platforms reflects the industry &mdash; and gets cited
                  by the outlets that matter. If you&rsquo;d like to contribute anonymized call
                  volume data, check the box in the form above or email us directly.
                </p>
                <a
                  href={`mailto:${EMAIL}?subject=Data%20Partner%20-%20State%20of%20Home%20Service%20Calls`}
                  className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline"
                >
                  {EMAIL}
                  <ArrowRight size={14} />
                </a>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Press */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl text-center">
            <Newspaper className="mx-auto h-8 w-8 text-accent" />
            <h2 className="mt-4 text-xl font-bold text-text-primary sm:text-2xl">
              Reporter or researcher?
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-text-secondary sm:text-base">
              Reach out ahead of publication for early access to findings, a custom data cut for
              your region or trade, or to speak with our team on the record.
            </p>
            <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a href={`mailto:${EMAIL}`}>
                <Button variant="secondary" size="lg">Contact for Press</Button>
              </a>
              <Link
                to="/blog"
                className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
              >
                Read our blog in the meantime
                <ArrowRight className="h-4 w-4" />
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
