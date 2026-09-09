import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Sparkles,
  ArrowRight,
  Clock,
  Phone,
  Building2,
  PhoneForwarded,
  PlayCircle,
  Users,
  LineChart,
  CheckCircle2,
  ChevronDown,
  ListChecks,
  ShieldCheck,
  Mail,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { CookieConsent } from '@/components/CookieConsent';
import { BackButton } from '@/components/ui/BackButton';
import { EASE, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { SARAH_PHONE } from '@/lib/site';

/* ------------------------------------------------------------------ */
/*  Content                                                             */
/* ------------------------------------------------------------------ */

const SUPPORT_EMAIL = 'ali@vireek.com';

const CHECKLIST = [
  'Your business phone number (the one customers already call)',
  'A list of the services you offer and your service area',
  'Your business hours, including any after-hours or emergency policy',
  'The name and number of whoever should be looped in for urgent calls',
];

interface Step {
  n: string;
  title: string;
  time: string;
  icon: LucideIcon;
  summary: string;
  details: string[];
}

const STEPS: Step[] = [
  {
    n: '01',
    title: 'Create your account',
    time: '~1 minute',
    icon: Building2,
    summary: 'Sign up with a work email and password — no credit card needed to get started.',
    details: [
      'Go to the Sign Up page and enter your business email and a password.',
      'You will land straight in a short setup flow — no separate "activation" step.',
      'One login covers your whole account; you can invite teammates later.',
    ],
  },
  {
    n: '02',
    title: 'Tell Sarah about your business',
    time: '~5 minutes',
    icon: ListChecks,
    summary: 'Fill out your Business Profile so your AI receptionist sounds like it works there.',
    details: [
      'Add your industry, services, and service area so Sarah qualifies callers correctly.',
      'Set your hours and how you want after-hours or emergency calls handled.',
      'Add common questions and answers (pricing ranges, service area limits, etc.) so Sarah can answer them on the spot.',
      'Set an escalation contact for anything Sarah should hand off to a real person.',
    ],
  },
  {
    n: '03',
    title: 'Forward your calls',
    time: '~2 minutes',
    icon: PhoneForwarded,
    summary: 'Keep the number your customers already know — just point it at Vireek.',
    details: [
      'You do not need a new phone number. Forward your existing line to the number Vireek gives you.',
      'Choose how much to forward: every call, only after-hours, or only overflow when your line is busy.',
      'Most carriers make this a quick settings change — we walk you through the exact steps for yours.',
    ],
  },
  {
    n: '04',
    title: 'Place a test call',
    time: '~2 minutes',
    icon: PlayCircle,
    summary: 'Hear exactly what your customers will hear before anyone else calls in.',
    details: [
      'Call your forwarded number yourself, or use the Live Demo on the site to preview Sarah.',
      'Check the greeting, the qualifying questions, and how urgent requests get handled.',
      'Not quite right? Adjust it from Business Profile — changes apply to the very next call.',
    ],
  },
  {
    n: '05',
    title: 'Invite your team',
    time: '~2 minutes (optional)',
    icon: Users,
    summary: 'Bring in dispatchers, technicians, or office staff with the right level of access.',
    details: [
      'From Dashboard → Team, send an email invite — it includes a secure sign-up link.',
      'Give each person only what they need to see, from a single technician\u2019s jobs to the full account.',
      'This step can wait — you can run solo at first and invite people whenever you\u2019re ready.',
    ],
  },
  {
    n: '06',
    title: 'Go live and monitor',
    time: 'Ongoing',
    icon: LineChart,
    summary: 'Calls, leads, and jobs land in your Dashboard the moment Sarah hangs up.',
    details: [
      'Dashboard → Calls shows a live transcript and outcome for every conversation.',
      'Leads and Jobs move from a captured inquiry to scheduled, confirmed work.',
      'Analytics and Insights show call volume, answer rate, and revenue recovered over time.',
    ],
  },
];

interface GuideFAQ {
  q: string;
  a: string;
}

const GUIDE_FAQS: GuideFAQ[] = [
  {
    q: 'How long does the whole process take?',
    a: 'Most businesses are live in about 15 minutes: create an account, complete the Business Profile, forward calls, and place one test call. Inviting a team is optional and can happen any time after.',
  },
  {
    q: 'Do I have to give up my current business number?',
    a: 'No. You keep the number your customers already have saved. You simply forward calls to Vireek — for all calls, after-hours only, or overflow when your line is busy.',
  },
  {
    q: 'What if I\u2019m not ready to answer every question in the Business Profile?',
    a: 'Fill in what you know and come back later — nothing has to be final on day one. Sarah works from whatever is saved, and you can refine hours, services, and FAQ answers at any point from the Dashboard.',
  },
  {
    q: 'Can I see what a call will sound like before customers do?',
    a: 'Yes. Use the Live Demo to preview Sarah before you forward any calls, then place a real test call to your forwarded number once setup is complete.',
  },
  {
    q: 'What happens after I go live?',
    a: 'Every call, lead, and job shows up in your Dashboard in real time. You can adjust the greeting, questions, or escalation rules at any point — changes take effect on the next call, with no downtime.',
  },
];

/* ------------------------------------------------------------------ */
/*  SEO + schema                                                        */
/* ------------------------------------------------------------------ */

function SEO() {
  useSEO({
    title: 'Onboarding Guide — Get Sarah Answering Calls in 15 Minutes | Vireek',
    description:
      'A step-by-step guide to Vireek onboarding: create your account, set up your Business Profile, forward your calls, test it live, and start capturing every job.',
    canonical: 'https://vireek.com/onboarding-guide',
  });
  return null;
}

/* ------------------------------------------------------------------ */
/*  Small pieces                                                        */
/* ------------------------------------------------------------------ */

function FAQItem({ q, a, isOpen, onToggle }: { q: string; a: string; isOpen: boolean; onToggle: () => void }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary/90 shadow-card dark:shadow-card-dark">
      <h3>
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={onToggle}
          className="focus-ring flex w-full items-center justify-between gap-5 rounded-2xl px-5 py-5 text-left sm:px-6"
        >
          <span className="text-base font-semibold leading-7 text-text-primary sm:text-lg">{q}</span>
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-colors ${
              isOpen ? 'border-accent/30 bg-accent/10 text-accent' : 'border-border bg-bg-tertiary text-text-secondary'
            }`}
          >
            <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
          </span>
        </button>
      </h3>
      {isOpen && (
        <div className="px-5 pb-5 sm:px-6">
          <p className="text-base leading-7 text-text-secondary">{a}</p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main page                                                           */
/* ------------------------------------------------------------------ */

export function OnboardingGuidePage() {
  const [openFAQ, setOpenFAQ] = useState<string | null>(null);

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-5xl">
            <div className="mb-8">
              <BackButton />
            </div>
            <div className="text-center">
              <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
                <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                  <Sparkles className="h-4 w-4 text-accent" />
                  Onboarding Guide
                </div>
                <h1 className="text-balance text-5xl font-extrabold tracking-tight text-text-primary sm:text-6xl lg:text-7xl">
                  Sarah can be answering calls in about 15 minutes.
                </h1>
                <p className="mx-auto mt-6 max-w-3xl text-xl leading-8 text-text-secondary sm:text-2xl">
                  Here is exactly what happens between creating your account and your first booked job —
                  no surprises, no new phone number, no waiting on a sales call.
                </p>
                <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                  <Link to="/signup">
                    <Button variant="primary" size="lg">
                      Start Free Trial
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                  </Link>
                  <Link to="/demo">
                    <Button variant="secondary" size="lg">
                      Preview the Live Demo
                    </Button>
                  </Link>
                </div>
                <div className="mx-auto mt-8 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/60 px-4 py-2 text-sm font-medium text-text-secondary">
                  <Clock className="h-4 w-4 text-accent" />
                  Total setup time: about 15 minutes
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Before you start checklist */}
        <section className="px-6 pb-4 pt-4">
          <div className="mx-auto max-w-5xl rounded-[2rem] border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark sm:p-10">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Before you start</p>
            <h2 className="mt-3 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
              Have these four things handy
            </h2>
            <p className="mt-3 max-w-2xl text-base leading-7 text-text-secondary">
              None of this has to be perfect on day one — you can refine every field later from your Dashboard.
              It just makes the walkthrough faster.
            </p>
            <ul className="mt-6 grid gap-3 sm:grid-cols-2">
              {CHECKLIST.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-3 rounded-xl border border-border bg-bg-tertiary/60 p-4"
                >
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                  <span className="text-sm leading-6 text-text-secondary">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Steps */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl">
            <div className="mb-12 text-center">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">The walkthrough</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
                Six steps, start to first call
              </h2>
            </div>
            <div className="space-y-5">
              {STEPS.map((step, i) => {
                const Icon = step.icon;
                return (
                  <motion.div
                    key={step.n}
                    initial={{ opacity: 0, y: 18 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={viewport}
                    transition={{ duration: 0.45, ease: EASE, delay: Math.min(i * 0.05, 0.25) }}
                    className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
                  >
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                      <div className="flex items-center gap-4 sm:flex-col sm:items-center sm:gap-2">
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                          <Icon className="h-5 w-5" />
                        </span>
                        <span className="text-xs font-bold tracking-wider text-text-secondary/50">{step.n}</span>
                      </div>
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center gap-3">
                          <h3 className="text-xl font-bold text-text-primary sm:text-2xl">{step.title}</h3>
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-3 py-1 text-xs font-semibold text-text-secondary">
                            <Clock className="h-3 w-3" />
                            {step.time}
                          </span>
                        </div>
                        <p className="mt-2 text-base leading-7 text-text-secondary">{step.summary}</p>
                        <ul className="mt-4 space-y-2.5">
                          {step.details.map((d) => (
                            <li key={d} className="flex items-start gap-2.5 text-sm leading-6 text-text-secondary">
                              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-accent/60" />
                              {d}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="px-6 pb-4">
          <div className="mx-auto max-w-4xl">
            <div className="mb-10 text-center">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Common questions</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
                Onboarding, answered
              </h2>
            </div>
            <div className="space-y-4">
              {GUIDE_FAQS.map((faq) => (
                <FAQItem
                  key={faq.q}
                  q={faq.q}
                  a={faq.a}
                  isOpen={openFAQ === faq.q}
                  onToggle={() => setOpenFAQ(openFAQ === faq.q ? null : faq.q)}
                />
              ))}
            </div>
            <p className="mt-6 text-center text-sm text-text-secondary">
              Have a setup question this didn&apos;t cover?{' '}
              <Link to="/help" className="font-semibold text-accent hover:underline">
                Visit the Help Center
              </Link>{' '}
              or{' '}
              <Link to="/contact" className="font-semibold text-accent hover:underline">
                contact us directly
              </Link>
              .
            </p>
          </div>
        </section>

        {/* Trust strip */}
        <section className="px-6 py-4">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-x-8 gap-y-3 rounded-2xl border border-border bg-bg-secondary/60 px-6 py-5 text-sm text-text-secondary">
            <span className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-accent" />
              No credit card required to start
            </span>
            <span className="flex items-center gap-2">
              <Phone className="h-4 w-4 text-accent" />
              Keep your existing business number
            </span>
            <span className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-accent" />
              Cancel anytime from Billing
            </span>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Ready when you are</p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Stop losing jobs to voicemail.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary">
              Create your account and walk through the same six steps above — most businesses are live
              before their next incoming call.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link to="/signup">
                <Button variant="primary" size="lg">
                  Start Free Trial
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
              >
                <Mail className="h-4 w-4" />
                {SUPPORT_EMAIL}
              </a>
              <a
                href={SARAH_PHONE}
                className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
              >
                <Phone className="h-4 w-4" />
                Talk to Sarah now
              </a>
            </div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
