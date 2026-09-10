import { motion } from 'framer-motion';
import {
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  Clock,
  MessageSquareText,
  Reply,
  Send,
  Tag,
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
// Standalone deep-dive for "Missed-Call Text-Back", which previously only
// appeared as a single bullet on FeaturesPage.tsx (Customer Communication
// category) with no page of its own. Reuses the glossary definition
// published at /glossary#sms-text-back (src/lib/glossary.ts) as the single
// source of truth for the term, same pattern as LeadQualificationPage.tsx.

const WHAT_IT_DOES = [
  {
    icon: Send,
    title: 'Sent within seconds',
    body: 'The moment a call goes unanswered, a text goes out automatically — before the caller has time to dial the next business on their list.',
  },
  {
    icon: Tag,
    title: 'Branded with your business',
    body: 'The message comes from your business number and opens with your name, not a generic "we missed your call" from an unknown sender.',
  },
  {
    icon: MessageSquareText,
    title: 'A direct booking link',
    body: 'Every text includes a link straight to booking — the caller doesn\u2019t need to call back or wait for a callback to get on your calendar.',
  },
  {
    icon: Reply,
    title: 'Two-way conversation',
    body: 'If the caller replies, it doesn\u2019t vanish into a phone\u2019s inbox — it lands in your Vireek lead inbox like any other conversation.',
  },
  {
    icon: Clock,
    title: 'Hours-aware messaging',
    body: 'The text can reflect whether you\u2019re currently open or closed, so the tone matches reality instead of sounding automated.',
  },
  {
    icon: BadgeCheck,
    title: 'Logged to the lead record',
    body: 'Every text sent and every reply received syncs to the same lead record as the call itself — nothing lives in a separate, disconnected channel.',
  },
];

const STEPS = [
  {
    title: 'A call goes unanswered',
    detail: 'A rare miss — an overflow moment, a dropped line, or before your number is fully connected to Sarah.',
  },
  {
    title: 'A text goes out automatically',
    detail: 'Within seconds, the caller gets a message from your business number, not a silent missed-call notification.',
  },
  {
    title: 'The lead is recovered',
    detail: 'The booking link and any reply bring the conversation back into your dashboard instead of losing the job to a competitor.',
  },
];

const FAQ = [
  {
    q: 'Sarah already answers every call — why do I need text-back too?',
    a: 'Text-back is the safety net for the rare edge case: an overflow moment, a dropped line, or the window before your number is fully connected. It makes sure a lead is never lost just because one specific call didn\u2019t get picked up live.',
  },
  {
    q: 'Can I customize the message and the link?',
    a: 'Yes. The wording and the destination link (your booking page, a specific service page, or a phone number) are configured for your business, not a fixed generic template.',
  },
  {
    q: 'Does this work with my existing business number?',
    a: 'Yes — it uses the same SMS-enabled number connected to Vireek, so customers keep texting the number they already know.',
  },
  {
    q: 'What happens when the customer replies?',
    a: 'The reply comes into your Vireek lead inbox, tied to that caller\u2019s record, so your team can pick up the conversation without hunting through a phone.',
  },
];

function SmsTextBackSEO() {
  useSEO({
    title: 'SMS Text-Back — Vireek',
    description:
      'How Vireek automatically texts a caller within seconds of a missed call, with a direct booking link, so a lead is never lost to silence.',
    canonical: 'https://vireek.com/features/sms-text-back',
  });
  return null;
}

export function SmsTextBackPage() {
  const glossaryTerm = getTermBySlug('sms-text-back');

  return (
    <>
      <SmsTextBackSEO />
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
                <MessageSquareText className="h-4 w-4 text-accent" />
                Customer Communication
              </div>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                SMS Text-Back
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                The instant a call goes unanswered, Vireek sends a text with an apology and a booking link — so
                one missed call never quietly becomes a lost job.
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
                  to="/glossary#sms-text-back"
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
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>No missed call goes silent</h2>
              <p className={bodyClass()}>
                Text-back happens automatically, in the background, the moment a call isn\u2019t answered live.
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
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>From silence to a recovered lead</h2>
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
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>Questions about text-back</h2>
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
              to="/features/lead-qualification"
              className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-3.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary"
            >
              Lead Qualification
            </Link>
            <Link
              to="/glossary#missed-call"
              className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-3.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary"
            >
              Missed Call
            </Link>
            <Link
              to="/calculator"
              className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-3.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary"
            >
              Revenue Calculator
            </Link>
          </motion.div>
        </section>

        {/* Final CTA */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Stop losing leads to silence</p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Never let a missed call go quiet again
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary">
              A text goes out automatically, every time — no setup per call, no manual follow-up.
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
