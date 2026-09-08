import { useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  BadgeCheck,
  Check,
  Clock3,
  Minus,
  PhoneCall,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

/* ================================================================== */
/*  DATA                                                                */
/* ================================================================== */

type CellValue = 'yes' | 'no' | 'partial';

interface ComparisonRow {
  label: string;
  ai: CellValue;
  human: CellValue;
}

const COMPARISON_ROWS: ComparisonRow[] = [
  { label: 'Answers every call, 24/7/365 (nights, weekends, holidays)', ai: 'yes', human: 'no' },
  { label: 'Handles multiple calls at the exact same time', ai: 'yes', human: 'no' },
  { label: 'Predictable, flat monthly cost', ai: 'yes', human: 'no' },
  { label: 'No hiring, onboarding, or training time', ai: 'yes', human: 'no' },
  { label: 'Never calls in sick or quits without notice', ai: 'yes', human: 'no' },
  { label: 'Consistent greeting, script, and tone on every call', ai: 'yes', human: 'partial' },
  { label: 'Books appointments straight into your calendar', ai: 'yes', human: 'partial' },
  { label: 'Logs every call and syncs details to your CRM', ai: 'yes', human: 'partial' },
  { label: 'Reads emotional nuance and de-escalates upset callers', ai: 'partial', human: 'yes' },
  { label: 'Uses independent judgment on unusual, one-off situations', ai: 'partial', human: 'yes' },
  { label: 'Builds a personal, remembered relationship with regulars', ai: 'partial', human: 'yes' },
  { label: 'Can step away from the phone to help in person', ai: 'no', human: 'yes' },
];

function Cell({ value }: { value: CellValue }) {
  if (value === 'yes') {
    return (
      <span className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-success-500/15 text-success-500">
        <Check size={16} strokeWidth={2.75} />
      </span>
    );
  }
  if (value === 'partial') {
    return (
      <span className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-warning-500/15 text-warning-500">
        <Minus size={16} strokeWidth={2.75} />
      </span>
    );
  }
  return (
    <span className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-danger/10 text-danger">
      <X size={16} strokeWidth={2.75} />
    </span>
  );
}

interface ProsConsGroup {
  title: string;
  pros: string[];
  cons: string[];
}

const AI_GROUP: ProsConsGroup = {
  title: 'AI Receptionist',
  pros: [
    'Answers 100% of calls, including nights, weekends, and holidays',
    'Flat, predictable monthly cost with no payroll taxes or benefits',
    'Handles call spikes and simultaneous calls without a hold queue',
    'Same trained, on-brand greeting and script every single time',
    'Books jobs and syncs caller details to your CRM automatically',
    'Live in days, not the weeks a hiring and training cycle takes',
  ],
  cons: [
    'Cannot physically walk to the counter or shake a customer’s hand',
    'Needs clear guidance for truly one-off, unscripted situations',
    'Works best alongside a human for complex negotiations or VIP accounts',
  ],
};

const HUMAN_GROUP: ProsConsGroup = {
  title: 'Human Receptionist',
  pros: [
    'Reads tone, emotion, and context better than any current AI',
    'Can improvise, negotiate, and use judgment on unusual requests',
    'Builds long-term rapport with repeat customers and VIPs',
    'Can step away from the desk to help walk-in customers directly',
  ],
  cons: [
    'Only answers calls during scheduled shifts — nights and weekends go to voicemail',
    'One person can only take one call at a time; the rest wait or hang up',
    'Salary, payroll tax, benefits, and turnover cost add up year-round',
    'Hiring and training a replacement can take weeks every time someone leaves',
    'Tone and script quality vary by mood, workload, and experience level',
  ],
};

const FAQ_ITEMS = [
  {
    q: 'Can an AI receptionist actually sound human on the phone?',
    a: 'Modern AI receptionists like Sarah use natural, conversational voice technology that understands follow-up questions and everyday phrasing. Most callers can tell they are speaking with an automated system, but the experience feels responsive and helpful rather than robotic — closer to a well-trained front-desk employee than an old-fashioned phone tree.',
  },
  {
    q: 'Is an AI receptionist actually cheaper than hiring a person?',
    a: 'In most cases, yes. A full-time front-desk hire typically costs well beyond base salary once you add payroll taxes, benefits, paid time off, and the cost of training a replacement every time someone leaves. An AI receptionist runs on a flat monthly subscription with no additional employment costs, and it keeps working after hours when a single employee physically cannot.',
  },
  {
    q: 'Will an AI receptionist replace my human staff?',
    a: 'For most home-service businesses, the AI receptionist does not replace people — it replaces voicemail and missed calls. Many teams keep their front-desk staff for in-person visitors, complex accounts, and judgment calls, while the AI receptionist covers overflow, after-hours calls, and the first response so nothing falls through the cracks.',
  },
  {
    q: 'What can a human receptionist do that an AI receptionist still cannot?',
    a: 'A skilled human is still better at reading emotional nuance, improvising on truly unusual requests, and building the kind of personal rapport that comes from remembering a customer’s history and preferences over years. That is exactly why the strongest setups pair a trained AI receptionist for volume and availability with a human for the moments that need a judgment call.',
  },
  {
    q: 'Can an AI receptionist handle emergency or urgent calls?',
    a: 'A well-trained AI receptionist can recognize urgent language, ask the right qualifying questions, and flag the call for immediate follow-up or dispatch. It is not a substitute for emergency services, but it prevents an urgent job — like a burst pipe at midnight — from silently going to voicemail until morning.',
  },
  {
    q: 'Do I need to change my phone number to use an AI receptionist?',
    a: 'No. Most AI receptionist setups, including Vireek, work by forwarding your existing business number, so customers keep dialing the number they already know while the AI answers, qualifies, and books the call behind the scenes.',
  },
] as const;

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ_ITEMS.map((item) => ({
    '@type': 'Question',
    name: item.q,
    acceptedAnswer: {
      '@type': 'Answer',
      text: item.a,
    },
  })),
};

/* ================================================================== */
/*  SEO + JSON-LD                                                       */
/* ================================================================== */

function SEO() {
  useSEO({
    title: 'AI Receptionist vs Human Receptionist: Which Wins in 2026? | Vireek',
    description:
      'AI receptionist vs human receptionist, compared on cost, availability, consistency, and booking power. See the real trade-offs for home service businesses — and where a trade-trained AI receptionist like Sarah fits alongside your team.',
    canonical: 'https://vireek.com/ai-receptionist-vs-human-receptionist',
  });

  useEffect(() => {
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.text = JSON.stringify(faqSchema);
    document.head.appendChild(script);
    return () => {
      script.remove();
    };
  }, []);

  return null;
}

/* ================================================================== */
/*  SMALL PRESENTATIONAL PIECES                                        */
/* ================================================================== */

function ProsConsCard({ group, accent }: { group: ProsConsGroup; accent: 'ai' | 'human' }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewport}
      transition={{ duration: 0.5, ease: EASE }}
      className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
    >
      <div className="flex items-center gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
            accent === 'ai' ? 'bg-accent/10 text-accent' : 'bg-cta/10 text-cta'
          }`}
        >
          {accent === 'ai' ? <Sparkles size={18} /> : <Users size={18} />}
        </span>
        <h3 className="text-lg font-bold tracking-tight text-text-primary">{group.title}</h3>
      </div>

      <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-success-500">Strengths</p>
      <ul className="mt-3 space-y-2.5">
        {group.pros.map((item) => (
          <li key={item} className="flex items-start gap-2.5 text-sm leading-relaxed text-text-secondary">
            <Check size={15} className="mt-0.5 shrink-0 text-success-500" strokeWidth={2.5} />
            <span>{item}</span>
          </li>
        ))}
      </ul>

      <p className="mt-6 text-xs font-semibold uppercase tracking-wider text-danger">Trade-offs</p>
      <ul className="mt-3 space-y-2.5">
        {group.cons.map((item) => (
          <li key={item} className="flex items-start gap-2.5 text-sm leading-relaxed text-text-secondary">
            <X size={15} className="mt-0.5 shrink-0 text-danger" strokeWidth={2.5} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </motion.div>
  );
}

function FAQItem({ q, a, index }: { q: string; a: string; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewport}
      transition={{ duration: 0.4, ease: EASE, delay: index * 0.04 }}
      className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-7"
    >
      <h3 className="text-base font-semibold leading-7 text-text-primary sm:text-lg">{q}</h3>
      <p className="mt-2.5 text-sm leading-relaxed text-text-secondary">{a}</p>
    </motion.div>
  );
}

/* ================================================================== */
/*  PAGE                                                                */
/* ================================================================== */

export function AIReceptionistVsHumanPage() {
  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* ---------------------------------------------------------- */}
        {/* Hero                                                       */}
        {/* ---------------------------------------------------------- */}
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
              <p className={eyebrowClass()}>AI Receptionist vs Human Receptionist</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                AI Receptionist vs Human Receptionist: Which Wins in 2026?
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Every home service business eventually asks the same question: hire another
                person to answer the phone, or let an AI receptionist take the call. Here is an
                honest, side-by-side look at cost, availability, and what each one is actually
                good at — so you can decide with real information instead of a sales pitch.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/login">
                  <Button variant="primary" size="lg">
                    Try Sarah Free
                    <ArrowRight size={18} />
                  </Button>
                </Link>
                <Link
                  to="/pricing"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  View pricing
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </motion.div>

            {/* Quick-answer summary box (for readers who want the short version) */}
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
              className="mt-14 rounded-2xl border border-accent/20 bg-accent/[0.05] p-6 sm:p-8"
            >
              <div className="flex items-start gap-3">
                <BadgeCheck size={20} className="mt-0.5 shrink-0 text-accent" />
                <div>
                  <p className="text-sm font-bold uppercase tracking-wider text-accent">The short answer</p>
                  <p className="mt-2 text-base leading-relaxed text-text-primary">
                    An AI receptionist wins on availability, cost predictability, and consistency —
                    it answers every call, 24/7, for a flat monthly price. A human receptionist still
                    wins on emotional nuance, improvisation, and personal relationships. Most
                    home-service teams get the best result by using an AI receptionist for coverage
                    and volume, with a human handling the calls that truly need a judgment call.
                  </p>
                </div>
              </div>
            </motion.div>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* Comparison table                                           */}
        {/* ---------------------------------------------------------- */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={eyebrowClass()}>Side by Side</p>
              <h2 className={sectionHeadingClass()}>AI receptionist vs human receptionist, at a glance</h2>
              <p className={bodyClass()}>
                Twelve criteria that actually matter when a customer calls your business —
                not marketing claims.
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.6, ease: EASE, delay: 0.1 }}
              className="mt-12 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark"
            >
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border bg-bg-tertiary">
                      <th className="px-5 py-4 text-left font-semibold text-text-primary sm:px-6">
                        Criteria
                      </th>
                      <th className="px-5 py-4 text-center font-semibold text-accent sm:px-6">
                        AI Receptionist
                      </th>
                      <th className="px-5 py-4 text-center font-semibold text-text-primary sm:px-6">
                        Human Receptionist
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {COMPARISON_ROWS.map((row, index) => (
                      <tr
                        key={row.label}
                        className={`border-b border-border last:border-0 ${
                          index % 2 === 1 ? 'bg-bg-tertiary/40' : ''
                        }`}
                      >
                        <td className="px-5 py-4 text-text-secondary sm:px-6">{row.label}</td>
                        <td className="px-5 py-4 sm:px-6">
                          <Cell value={row.ai} />
                        </td>
                        <td className="px-5 py-4 sm:px-6">
                          <Cell value={row.human} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </motion.div>
            <p className="mt-4 text-center text-xs text-text-secondary/70">
              <Minus size={11} className="mb-0.5 inline text-warning-500" /> = depends on the
              situation or plan, not a strict yes or no.
            </p>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* Cost breakdown                                             */}
        {/* ---------------------------------------------------------- */}
        <section className="bg-bg-tertiary px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={eyebrowClass()}>The Real Cost</p>
              <h2 className={sectionHeadingClass()}>What each option actually costs your business</h2>
              <p className={bodyClass()}>
                Salary is only the starting line. Here is the fuller picture most comparisons skip.
              </p>
            </motion.div>

            <div className="mt-14 grid gap-6 md:grid-cols-2">
              {/* Human cost card */}
              <motion.div
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, ease: EASE }}
                className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cta/10 text-cta">
                    <Users size={18} />
                  </span>
                  <h3 className="text-lg font-bold tracking-tight text-text-primary">
                    Hiring a human receptionist
                  </h3>
                </div>
                <ul className="mt-6 space-y-3 text-sm leading-relaxed text-text-secondary">
                  <li className="flex items-start gap-2.5">
                    <Wallet size={15} className="mt-0.5 shrink-0 text-text-secondary/60" />
                    Base salary, plus payroll tax, benefits, and paid time off on top
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Clock3 size={15} className="mt-0.5 shrink-0 text-text-secondary/60" />
                    Covers roughly one 8–10 hour shift — nights, weekends, and holidays
                    still default to voicemail
                  </li>
                  <li className="flex items-start gap-2.5">
                    <PhoneCall size={15} className="mt-0.5 shrink-0 text-text-secondary/60" />
                    Only one call handled at a time; everything else waits or hangs up
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Users size={15} className="mt-0.5 shrink-0 text-text-secondary/60" />
                    Recruiting, onboarding, and retraining every time someone leaves
                  </li>
                </ul>
              </motion.div>

              {/* AI cost card */}
              <motion.div
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, ease: EASE, delay: 0.08 }}
                className="relative overflow-hidden rounded-2xl border border-accent/30 bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
              >
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0"
                  style={{
                    backgroundImage:
                      'radial-gradient(circle at 90% 0%, rgb(var(--accent-primary) / 0.08), transparent 55%)',
                  }}
                />
                <div className="relative">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                      <Sparkles size={18} />
                    </span>
                    <h3 className="text-lg font-bold tracking-tight text-text-primary">
                      An AI receptionist like Sarah
                    </h3>
                  </div>
                  <ul className="mt-6 space-y-3 text-sm leading-relaxed text-text-secondary">
                    <li className="flex items-start gap-2.5">
                      <Wallet size={15} className="mt-0.5 shrink-0 text-accent" />
                      Flat monthly plans starting at $79/month — no payroll tax, no benefits
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Clock3 size={15} className="mt-0.5 shrink-0 text-accent" />
                      Answers every call, 24 hours a day, 7 days a week, every holiday
                    </li>
                    <li className="flex items-start gap-2.5">
                      <PhoneCall size={15} className="mt-0.5 shrink-0 text-accent" />
                      Handles overlapping calls simultaneously — no hold queue, ever
                    </li>
                    <li className="flex items-start gap-2.5">
                      <Sparkles size={15} className="mt-0.5 shrink-0 text-accent" />
                      Live in days, with zero recruiting or training cycle
                    </li>
                  </ul>
                  <Link to="/pricing" className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline">
                    See full pricing
                    <ArrowRight size={14} />
                  </Link>
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* Pros & cons                                                */}
        {/* ---------------------------------------------------------- */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={eyebrowClass()}>An Honest Look</p>
              <h2 className={sectionHeadingClass()}>Where each option genuinely wins</h2>
              <p className={bodyClass()}>
                No option is perfect for every business. Here is where each one earns its keep.
              </p>
            </motion.div>

            <div className="mt-14 grid gap-6 md:grid-cols-2">
              <ProsConsCard group={AI_GROUP} accent="ai" />
              <ProsConsCard group={HUMAN_GROUP} accent="human" />
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* Real scenario                                              */}
        {/* ---------------------------------------------------------- */}
        <section className="bg-bg-tertiary px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={eyebrowClass()}>A Real Scenario</p>
              <h2 className={sectionHeadingClass()}>It’s 9:40 PM and a pipe just burst</h2>
              <p className={bodyClass()}>
                The comparison that matters most is not a feature list — it’s what happens on
                the call that decides whether you get the job.
              </p>
            </motion.div>

            <div className="mt-12 grid gap-6 md:grid-cols-2">
              <motion.div
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, ease: EASE }}
                className="rounded-2xl border border-border bg-bg-secondary p-6 sm:p-7"
              >
                <p className="text-xs font-bold uppercase tracking-wider text-danger">
                  Human receptionist, off the clock
                </p>
                <p className="mt-3 text-sm leading-relaxed text-text-secondary">
                  The office closed at 5 PM. The call rings twice, then hits voicemail. The
                  customer, already stressed, hangs up and calls the next plumber on the list.
                  By the time your team hears the message tomorrow morning, the job is gone.
                </p>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, ease: EASE, delay: 0.08 }}
                className="rounded-2xl border border-accent/30 bg-bg-secondary p-6 sm:p-7"
              >
                <p className="text-xs font-bold uppercase tracking-wider text-accent">
                  AI receptionist, wide awake
                </p>
                <p className="mt-3 text-sm leading-relaxed text-text-secondary">
                  Sarah answers on the second ring, recognizes the urgency in the caller’s
                  words, confirms the address, and books the earliest available emergency slot.
                  A text confirmation goes out immediately, and the job is already on your
                  calendar when your team wakes up.
                </p>
              </motion.div>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* Hybrid approach                                            */}
        {/* ---------------------------------------------------------- */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-4xl text-center">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
            >
              <p className={eyebrowClass()}>The Better Question</p>
              <h2 className={sectionHeadingClass()}>
                It doesn’t have to be AI receptionist vs human receptionist
              </h2>
              <p className={`${bodyClass()} mx-auto max-w-2xl`}>
                The businesses growing fastest in 2026 are not choosing one over the other —
                they’re using an AI receptionist to guarantee every call gets answered, and their
                human team to handle the relationships, walk-ins, and judgment calls that need a
                person. Sarah covers the phone around the clock; your team focuses on the work
                only they can do.
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
              className="mx-auto mt-12 max-w-3xl rounded-2xl border border-border bg-bg-secondary p-6 text-left shadow-card dark:shadow-card-dark sm:p-8"
            >
              <p className="text-sm font-bold uppercase tracking-wider text-accent">
                Choose an AI receptionist when…
              </p>
              <ul className="mt-3 space-y-2 text-sm leading-relaxed text-text-secondary">
                <li>• Calls come in outside your business hours or during job-site work</li>
                <li>• You’re missing calls during busy periods because everyone is on another line</li>
                <li>• You need consistent, on-brand call handling without hiring another person</li>
              </ul>
              <p className="mt-6 text-sm font-bold uppercase tracking-wider text-cta">
                Keep a human receptionist for…
              </p>
              <ul className="mt-3 space-y-2 text-sm leading-relaxed text-text-secondary">
                <li>• Walk-in customers and in-person visits to your office</li>
                <li>• High-value accounts that expect a personal, remembered relationship</li>
                <li>• Rare, complex situations that genuinely need human judgment</li>
              </ul>
            </motion.div>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* FAQ                                                        */}
        {/* ---------------------------------------------------------- */}
        <section className="bg-bg-tertiary px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>Common Questions</p>
              <h2 className={sectionHeadingClass()}>AI receptionist vs human receptionist: FAQ</h2>
            </motion.div>

            <div className="mt-12 space-y-4">
              {FAQ_ITEMS.map((item, index) => (
                <FAQItem key={item.q} q={item.q} a={item.a} index={index} />
              ))}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* Final CTA                                                  */}
        {/* ---------------------------------------------------------- */}
        <section className="px-6 py-16 md:py-20">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="bg-noise relative mx-auto flex max-w-6xl flex-col items-center overflow-hidden rounded-3xl bg-gradient-to-br from-accent-800 via-accent-700 to-cta-800 px-6 py-16 text-center shadow-glow-accent md:px-16 md:py-24"
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage:
                  'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.14), transparent 45%), radial-gradient(circle at 85% 80%, rgb(var(--accent-secondary) / 0.20), transparent 45%)',
              }}
            />
            <div className="relative">
              <ShieldCheck size={32} className="mx-auto text-white/80" />
              <h2 className="mt-5 text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                Give your phone the coverage a full-time hire can’t match
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Sarah answers every call, books the job, and syncs the details — 24/7, for a
                flat monthly price.
              </p>
              <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/login">
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    Start Free Trial
                    <ArrowRight size={18} />
                  </Button>
                </Link>
                <Link
                  to="/compare"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white/90 transition-colors hover:text-white"
                >
                  See the full Vireek comparison
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-white/70">
                <ShieldCheck size={13} className="shrink-0" />
                Cancel anytime. No contracts.
              </p>
            </div>
          </motion.div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
