import { motion } from 'framer-motion';
import {
  ArrowRight,
  BadgeCheck,
  Ban,
  CalendarClock,
  CheckCircle2,
  Database,
  MapPin,
  MessageSquareText,
  Siren,
  UserPlus,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { Card } from '@/components/ui/Card';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { getTermBySlug } from '@/lib/glossary';

// ============================================================
// CONTENT
// ============================================================
// This page is the standalone deep-dive for the "Lead Qualification"
// feature that already appears as a bullet on FeaturesPage.tsx (Lead
// Management category). It reuses the same glossary definition already
// published at /glossary#lead-qualification (src/lib/glossary.ts) as its
// single source of truth for what the term means, instead of writing a
// second, possibly-drifting definition here.

const WHAT_IT_DOES = [
  {
    icon: MapPin,
    title: 'Service-area check',
    body: 'Sarah confirms the caller is inside the area you actually cover before a job ever reaches your calendar.',
  },
  {
    icon: Siren,
    title: 'Urgency triage',
    body: 'Trade-relevant questions separate a same-day emergency from a routine service request, so the right jobs get priority.',
  },
  {
    icon: Ban,
    title: 'Spam & robocall filtering',
    body: 'Calls with no real job behind them are identified and kept out of your lead list instead of cluttering the dashboard.',
  },
  {
    icon: MessageSquareText,
    title: 'Structured intake',
    body: 'Issue type, address, and preferred timing are captured in the caller\u2019s own words and turned into clean, structured fields.',
  },
  {
    icon: Database,
    title: 'CRM-ready records',
    body: 'Every qualified lead lands in your CRM with the qualifying answers attached — no re-typing notes from a voicemail.',
  },
  {
    icon: CalendarClock,
    title: 'Straight to booking',
    body: 'Once a lead is qualified, Sarah moves straight into checking your calendar and booking the appointment.',
  },
];

const STEPS = [
  {
    title: 'Caller reaches Sarah',
    detail: 'Every inbound call is answered instantly, 24/7 — no hold music, no voicemail.',
  },
  {
    title: 'Sarah asks qualifying questions',
    detail: 'A trade-specific question set (set up for your business) covers location, issue, and urgency.',
  },
  {
    title: 'The lead is scored and routed',
    detail: 'Qualified leads move to booking; low-fit or spam calls are flagged instead of taking up your team\u2019s time.',
  },
];

const FAQ = [
  {
    q: 'What counts as a "qualified" lead?',
    a: 'One inside your service area, tied to a real job you offer, with enough detail (issue, location, timing) for your team to act on it without calling the customer back to ask basic questions.',
  },
  {
    q: 'Can the qualifying questions be different per trade?',
    a: 'Yes. Plumbing, HVAC, electrical, and other trades each have different urgent-vs-routine signals, so the question set is configured for your business rather than a single generic script.',
  },
  {
    q: 'What happens to calls that don\u2019t qualify?',
    a: 'They\u2019re still logged, so nothing is silently dropped — but they\u2019re marked separately from real jobs instead of mixing into the same lead list your team works from.',
  },
  {
    q: 'Does this replace my CRM?',
    a: 'No. Qualified leads and the answers Sarah collected sync into the CRM you already use — see the Integrations page for supported systems.',
  },
];

function LeadQualificationSEO() {
  useSEO({
    title: 'AI Lead Qualification — Vireek',
    description:
      'How Sarah, Vireek\u2019s AI voice receptionist, qualifies every inbound call by service area, urgency, and issue type before it reaches your calendar.',
    canonical: 'https://vireek.com/features/lead-qualification',
  });
  return null;
}

export function LeadQualificationPage() {
  const glossaryTerm = getTermBySlug('lead-qualification');

  return (
    <>
      <LeadQualificationSEO />
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
              <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <UserPlus className="h-4 w-4 text-accent" />
                Lead Management
              </div>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                AI Lead Qualification
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Sarah asks trade-relevant questions on every call to separate a real, in-area job from a routine
                question or a spam call — before anything reaches your calendar.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/login">
                  <Button variant="primary" size="lg">
                    Start Free Trial
                  </Button>
                </Link>
                <Link
                  to="/features"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  All features <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Glossary definition, reused from /glossary */}
        {glossaryTerm && (
          <section className="px-6 py-4">
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto flex max-w-3xl items-start gap-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
            >
              <BadgeCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
              <div>
                <p className="text-sm font-semibold text-text-primary">In plain terms</p>
                <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{glossaryTerm.definition}</p>
                <Link
                  to="/glossary#lead-qualification"
                  className="focus-ring mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-accent transition-colors hover:text-accent/80"
                >
                  See it in the glossary <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </motion.div>
          </section>
        )}

        {/* What it does */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-7xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={eyebrowClass()}>What It Does</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>Every call, checked before it counts</h2>
              <p className={bodyClass()}>
                Qualification happens inside the same call — no follow-up form, no second phone call.
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
            >
              {WHAT_IT_DOES.map((item) => (
                <motion.div key={item.title} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="h-full">
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                      <item.icon size={19} />
                    </span>
                    <h3 className="mt-4 text-base font-semibold text-text-primary">{item.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">{item.body}</p>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* How it works */}
        <section className="bg-bg-tertiary/50 px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>How It Works</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>From ring to routed lead</h2>
            </motion.div>

            <div className="mt-12 grid gap-6 sm:grid-cols-3">
              {STEPS.map((step, i) => (
                <motion.div
                  key={step.title}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.4, delay: i * 0.08, ease: EASE }}
                  className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/10 text-sm font-bold text-accent">
                    {i + 1}
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-text-primary">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{step.detail}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>FAQ</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>Questions about lead qualification</h2>
            </motion.div>

            <div className="mt-10 space-y-4">
              {FAQ.map((item) => (
                <motion.div
                  key={item.q}
                  initial={{ opacity: 0, y: 12 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.4, ease: EASE }}
                  className="rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark"
                >
                  <h3 className="flex items-start gap-2.5 text-base font-semibold text-text-primary">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                    {item.q}
                  </h3>
                  <p className="mt-2 pl-6.5 text-sm leading-relaxed text-text-secondary">{item.a}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Related */}
        <section className="px-6 pb-4">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-3 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
          >
            <span className="text-sm font-semibold text-text-primary">Keep exploring:</span>
            <Link
              to="/features"
              className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-3.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary"
            >
              All Features
            </Link>
            <Link
              to="/glossary#lead-scoring"
              className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-3.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary"
            >
              Lead Scoring
            </Link>
            <Link
              to="/case-studies"
              className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-3.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary"
            >
              Case Studies
            </Link>
            <Link
              to="/integrations"
              className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-3.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary"
            >
              CRM Integrations
            </Link>
          </motion.div>
        </section>

        {/* Final CTA */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Stop guessing which calls matter</p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Let Sarah qualify every call for you
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary">
              Real jobs move straight to booking. Everything else stays out of your team\u2019s way.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link to="/login">
                <Button variant="primary" size="lg">
                  Start Free Trial <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <Link
                to="/demo"
                className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
              >
                Book a demo <ArrowRight className="h-4 w-4" />
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
