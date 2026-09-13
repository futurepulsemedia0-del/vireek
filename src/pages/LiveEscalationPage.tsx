import { motion } from 'framer-motion';
import {
  ArrowRight,
  CheckCircle2,
  Ear,
  Gauge,
  Languages,
  PhoneForwarded,
  ShieldAlert,
  Users,
  Workflow,
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

const WHAT_IT_DOES = [
  {
    icon: PhoneForwarded,
    title: 'Warm transfer, not a cold handoff',
    body: 'Sarah briefs whoever picks up — caller name, reason for the call, anything already gathered — before connecting. The caller never repeats themselves.',
  },
  {
    icon: Ear,
    title: 'Barge-in when a second set of ears helps',
    body: 'A team member can drop into a call already in progress and listen live before deciding whether to speak up — useful for judgment calls on an urgent or high-value job.',
  },
  {
    icon: ShieldAlert,
    title: 'Trigger conditions you control',
    body: 'Escalate when a caller explicitly asks for a person, when frustration is detected, or for specific job types you flag as always-escalate.',
  },
  {
    icon: Users,
    title: 'Escalate to a number or a ring group',
    body: 'Send escalations to a single cell phone, a front-desk line, or a ring group so the first available team member picks up.',
  },
  {
    icon: Workflow,
    title: 'Graceful fallback if no one answers',
    body: "If the escalation isn't picked up, Sarah doesn't just drop the caller — it falls back to text-back and a logged lead, so nothing is lost.",
  },
  {
    icon: Gauge,
    title: 'Logged like any other call',
    body: 'Every escalation — who it went to, whether it was answered, how long it took — shows up in your call log, not in a separate, invisible channel.',
  },
  {
    icon: Languages,
    title: 'Routed by language, not just answered in it',
    body: 'Set which languages each technician speaks on the Team page, and a Spanish-speaking caller escalates straight to your Spanish-speaking technician — not just to whoever picks up first.',
  },
];

const STEPS = [
  {
    title: 'Sarah detects a trigger',
    detail: "An explicit ask for a human, rising frustration, or a job type you've flagged as always-escalate.",
  },
  {
    title: 'The handoff happens live',
    detail: 'Warm transfer briefs your team before connecting; barge-in lets a team member listen in and jump on the line.',
  },
  {
    title: 'Nothing falls through the cracks',
    detail: 'If no one answers the escalation, it automatically falls back to text-back and a logged lead — not a dropped call.',
  },
];

const FAQ = [
  {
    q: "What's the difference between warm transfer and barge-in?",
    a: "Warm transfer hands the call fully to a team member after briefing them on what's happened so far — Sarah steps out of the call. Barge-in lets a team member join a call that's still in progress and listen before deciding whether to speak, without interrupting Sarah's flow unless they choose to.",
  },
  {
    q: 'What triggers an escalation?',
    a: 'You control this: an explicit request to speak to a person, detected caller frustration, or specific job types or situations you flag as always-escalate. Trigger conditions are tuned with your onboarding contact so it fires only when it should — not on every call.',
  },
  {
    q: 'What happens if nobody answers the escalation number?',
    a: "Sarah doesn't leave the caller stranded. If the escalation isn't picked up within a configurable window, it falls back automatically to the same text-back and lead-logging safety net as any unanswered call.",
  },
  {
    q: 'Can I send escalations to more than one person?',
    a: 'Yes — point the escalation number at a ring group or a forwarding line that reaches multiple team members, so the first person available takes the call.',
  },
  {
    q: 'Does an escalated call still count against my included minutes?',
    a: "Yes, the call itself is billed the same as any other call handled by Sarah — escalation changes who's on the line, not how the call is metered.",
  },
];

function LiveEscalationSEO() {
  useSEO({
    title: 'Live Escalation — Barge-In & Warm Transfer | Vireek',
    description:
      "How Vireek's AI receptionist Sarah brings a real team member into a call — warm transfer with full context, or live barge-in — so nothing that needs a human misses one.",
    canonical: 'https://vireek.com/features/live-escalation',
  });
  return null;
}

export function LiveEscalationPage() {
  return (
    <>
      <LiveEscalationSEO />
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
                <PhoneForwarded className="h-4 w-4 text-accent" />
                Call Handling
              </div>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Escalation to a Live Human, Mid-Call
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Sarah handles the call — but knows exactly when to bring in a real person, warm
                transfer the context along with it, or let your team listen in live.
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
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>AI that knows its own limits</h2>
              <p className={bodyClass()}>
                Most calls, Sarah handles start to finish. For the ones that need a person, the
                handoff is instant and the context comes with it.
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
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>From AI to human, without a gap</h2>
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
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>Questions about live escalation</h2>
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
            <span className="text-sm font-medium text-text-secondary">See also:</span>
            <Link
              to="/features/lead-qualification"
              className="focus-ring rounded-full border border-border px-4 py-1.5 text-sm font-medium text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
            >
              AI Lead Qualification
            </Link>
            <Link
              to="/features/sms-text-back"
              className="focus-ring rounded-full border border-border px-4 py-1.5 text-sm font-medium text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
            >
              SMS Text-Back
            </Link>
          </motion.div>
        </section>

        {/* Final CTA */}
        <section className="px-6 pb-20 pt-12 sm:pb-24">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="mx-auto max-w-4xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12"
          >
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Ready to try it?</p>
            <h2 className="mt-4 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl md:text-4xl">
              Set up your escalation number in minutes.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-text-secondary sm:text-base">
              Start your free trial, then configure warm transfer or barge-in from your dashboard
              settings whenever you're ready.
            </p>
            <div className="mt-8">
              <Link to="/login">
                <Button variant="primary" size="lg">
                  Start Free Trial <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </motion.div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
