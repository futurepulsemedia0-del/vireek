import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  GraduationCap,
  Target,
  Gauge,
  Smile,
  AlertTriangle,
  TrendingUp,
  Clock,
  Sparkles,
  Frown,
  Flame,
  DollarSign,
  CalendarCheck,
  PlayCircle,
  CheckCircle2,
  ArrowUpRight,
  type LucideIcon,
} from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { CountUp } from '@/components/ui/CountUp';

/**
 * AiCallCoach
 * ------------------------------------------------------------------
 * "Vireek AI Call Coach" — premium landing page section.
 *
 * Strategic purpose: prove Vireek doesn't just answer calls, it
 * improves every conversation. Two halves:
 *
 *  1. Call Intelligence Report — a realistic post-call analysis
 *     (intent, lead score, sentiment, urgency, conversion odds,
 *     recommended action) generated automatically after every call.
 *
 *  2. Practice With Sarah — an interactive training simulator.
 *     The visitor picks a scenario, sees the model exchange, runs
 *     the simulation, and gets scored — same as a real call would be.
 *
 * Self-contained — owns its own copy, mock data, and local
 * interaction state. Built entirely on the site's existing design
 * tokens and shared motion helpers; no backend required.
 * ------------------------------------------------------------------
 */

/* ------------------------------------------------------------------ */
/*  Call Intelligence Report — mock data                               */
/* ------------------------------------------------------------------ */

interface TranscriptLine {
  role: 'caller' | 'sarah';
  text: string;
}

const REPORT_TRANSCRIPT: TranscriptLine[] = [
  { role: 'caller', text: "My AC completely stopped working and it's 95 degrees in here. My mom is on oxygen." },
  { role: 'sarah', text: "That's serious, and I want to get someone to you right away. Let me flag this as an emergency and check who's closest." },
  { role: 'caller', text: 'Thank you, I really appreciate it.' },
  { role: 'sarah', text: 'Of course. I can have a technician there within the hour — I just need to confirm your address.' },
];

const REPORT_METRICS = {
  intent: 'Emergency HVAC \u2014 No Cooling',
  leadScore: 96,
  sentiment: { label: 'Anxious \u2192 Reassured', value: 82 },
  urgency: 'Critical',
  conversionProbability: 92,
  recommendedAction: 'Follow up within 10 minutes',
};

/* ------------------------------------------------------------------ */
/*  Practice With Sarah — scenario data                                */
/* ------------------------------------------------------------------ */

interface Scenario {
  key: string;
  label: string;
  icon: LucideIcon;
  callerLine: string;
  sarahLine: string;
  score: number;
  suggestions: string[];
  opportunity: string;
}

const SCENARIOS: Scenario[] = [
  {
    key: 'angry',
    label: 'Angry Customer',
    icon: Frown,
    callerLine: "This is the third time I've called! Nobody ever shows up when they say they will.",
    sarahLine: "I completely understand your frustration, and I'm sorry you've had this experience. Let me personally make sure this gets fixed today.",
    score: 91,
    suggestions: [
      'Acknowledged the frustration before offering any solution',
      'Gave a concrete same-day commitment instead of a vague apology',
    ],
    opportunity: 'De-escalation likely prevented a lost customer and a negative review.',
  },
  {
    key: 'emergency',
    label: 'Emergency Situation',
    icon: Flame,
    callerLine: "There's water pouring from my ceiling right now!",
    sarahLine: 'I hear you \u2014 let\u2019s get someone there immediately. Can you shut off the main water valve while I dispatch a technician?',
    score: 98,
    suggestions: [
      'Gave a safety instruction while help was already being dispatched',
      'Confirmed the address before ending the call, not after',
    ],
    opportunity: 'Fast, calm handling turns emergencies into premium same-day bookings.',
  },
  {
    key: 'pricing',
    label: 'Pricing Question',
    icon: DollarSign,
    callerLine: 'How much would it cost to replace my water heater?',
    sarahLine: 'Great question \u2014 it depends on the unit size and install complexity. I can get you a free on-site estimate as early as tomorrow morning.',
    score: 87,
    suggestions: [
      'Could anchor with a typical price range before deflecting to an estimate',
      'Asked a qualifying question before moving to book the visit',
    ],
    opportunity: 'Estimate booked instead of losing the lead to a competitor\u2019s flat quote.',
  },
  {
    key: 'appointment',
    label: 'Appointment Request',
    icon: CalendarCheck,
    callerLine: 'Can someone come out this Thursday afternoon?',
    sarahLine: 'Thursday afternoon works \u2014 I have a 1:00 PM or 3:30 PM slot open. Which works better for you?',
    score: 95,
    suggestions: [
      'Offered two concrete time slots instead of an open-ended question',
      'Confirmed contact info before wrapping up the call',
    ],
    opportunity: 'Booked in under 90 seconds \u2014 zero back-and-forth, zero friction.',
  },
];

function scoreTone(score: number) {
  if (score >= 95) return 'text-success';
  if (score >= 85) return 'text-accent';
  return 'text-cta';
}

/* ------------------------------------------------------------------ */
/*  Small building blocks                                              */
/* ------------------------------------------------------------------ */

function TranscriptBubble({ line }: { line: TranscriptLine }) {
  const isSarah = line.role === 'sarah';
  return (
    <div className={`flex ${isSarah ? 'justify-start' : 'justify-end'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed sm:text-[0.8rem] ${
          isSarah
            ? 'rounded-tl-sm border border-accent/20 bg-accent/5 text-text-primary'
            : 'rounded-tr-sm bg-bg-tertiary text-text-primary'
        }`}
      >
        {isSarah && <p className="mb-0.5 text-[0.65rem] font-semibold text-accent">Sarah</p>}
        {line.text}
      </div>
    </div>
  );
}

function MetricTile({
  icon: Icon,
  label,
  children,
  span,
}: {
  icon: LucideIcon;
  label: string;
  children: React.ReactNode;
  span?: boolean;
}) {
  return (
    <div className={`rounded-xl border border-border bg-bg-secondary p-3.5 ${span ? 'sm:col-span-2' : ''}`}>
      <div className="flex items-center gap-1.5">
        <Icon size={13} className="text-text-secondary" />
        <span className="text-[0.65rem] font-medium uppercase tracking-wide text-text-secondary">{label}</span>
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section                                                             */
/* ------------------------------------------------------------------ */

export function AiCallCoach() {
  const [activeKey, setActiveKey] = useState(SCENARIOS[0].key);
  const [ranScenarios, setRanScenarios] = useState<Set<string>>(new Set());
  const active = SCENARIOS.find((s) => s.key === activeKey) ?? SCENARIOS[0];
  const hasRun = ranScenarios.has(active.key);

  function runSimulation() {
    setRanScenarios((prev) => new Set(prev).add(active.key));
  }

  return (
    <section id="ai-call-coach" className="relative overflow-hidden py-16 sm:py-24 md:py-32">
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-60"
        style={{
          backgroundImage:
            'radial-gradient(circle at 15% 10%, rgb(var(--accent-primary) / 0.08), transparent 50%), radial-gradient(circle at 90% 90%, rgb(var(--accent-secondary) / 0.07), transparent 45%)',
        }}
      />

      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-3xl text-center"
        >
          <p className={eyebrowClass()}>{'AI Call Coach'}</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>
            {"Vireek Doesn\u2019t Just Answer Calls. It Makes Every Conversation Better."}
          </h2>
          <p className={`${bodyClass()} mx-auto max-w-2xl text-sm sm:text-base md:text-lg`}>
            {'Every call is scored, coached, and turned into a better version of itself \u2014 automatically, and before you ever have to ask.'}
          </p>
        </motion.div>

        {/* ============================================================ */}
        {/*  Call Intelligence Report                                     */}
        {/* ============================================================ */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.6, delay: 0.1, ease: EASE }}
          className="mt-10 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark sm:mt-14 sm:rounded-3xl"
        >
          <div className="flex items-center gap-2 border-b border-border bg-bg-tertiary px-4 py-3.5 sm:px-6">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <Sparkles size={14} />
            </span>
            <span className="text-xs font-semibold text-text-primary sm:text-sm">Call Intelligence Report</span>
            <span className="ml-auto rounded-full bg-bg-secondary px-2.5 py-1 text-[0.65rem] font-medium text-text-secondary">
              Auto-generated after every call
            </span>
          </div>

          <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-5">
            {/* Transcript */}
            <div className="flex flex-col gap-2.5 rounded-2xl border border-border bg-bg-tertiary/40 p-4 lg:col-span-2">
              <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-text-secondary">
                Call transcript
              </p>
              {REPORT_TRANSCRIPT.map((line, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 8 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.35, delay: 0.2 + i * 0.08, ease: EASE }}
                >
                  <TranscriptBubble line={line} />
                </motion.div>
              ))}
            </div>

            {/* Metrics */}
            <div className="grid grid-cols-2 gap-2.5 lg:col-span-3 sm:grid-cols-3">
              <MetricTile icon={Target} label="Customer Intent" span>
                <p className="text-sm font-semibold text-text-primary">{REPORT_METRICS.intent}</p>
              </MetricTile>

              <MetricTile icon={Gauge} label="Lead Quality Score">
                <p className={`text-2xl font-bold tracking-tight ${scoreTone(REPORT_METRICS.leadScore)}`}>
                  <CountUp value={`${REPORT_METRICS.leadScore}`} />
                  <span className="text-sm font-medium text-text-secondary">/100</span>
                </p>
              </MetricTile>

              <MetricTile icon={AlertTriangle} label="Urgency Level">
                <span className="inline-flex items-center rounded-full bg-danger/10 px-2.5 py-1 text-xs font-semibold text-danger">
                  {REPORT_METRICS.urgency}
                </span>
              </MetricTile>

              <MetricTile icon={Smile} label="Customer Sentiment" span>
                <p className="text-sm font-semibold text-text-primary">{REPORT_METRICS.sentiment.label}</p>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
                  <motion.div
                    initial={{ width: 0 }}
                    whileInView={{ width: `${REPORT_METRICS.sentiment.value}%` }}
                    viewport={viewport}
                    transition={{ duration: 0.7, delay: 0.4, ease: EASE }}
                    className="h-full rounded-full bg-gradient-to-r from-danger via-warning-500 to-success"
                  />
                </div>
              </MetricTile>

              <MetricTile icon={TrendingUp} label="Conversion Probability">
                <p className="text-2xl font-bold tracking-tight text-success">
                  <CountUp value={`${REPORT_METRICS.conversionProbability}%`} />
                </p>
              </MetricTile>

              <MetricTile icon={Clock} label="Recommended Action" span>
                <p className="text-sm font-semibold text-cta">{REPORT_METRICS.recommendedAction}</p>
              </MetricTile>
            </div>
          </div>
        </motion.div>

        {/* ============================================================ */}
        {/*  Practice With Sarah — training simulator                    */}
        {/* ============================================================ */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.6, delay: 0.15, ease: EASE }}
          className="mt-6 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark sm:mt-8 sm:rounded-3xl"
        >
          <div className="flex items-center gap-2 border-b border-border bg-bg-tertiary px-4 py-3.5 sm:px-6">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cta/15 text-cta">
              <GraduationCap size={14} />
            </span>
            <span className="text-xs font-semibold text-text-primary sm:text-sm">Practice With Sarah</span>
            <span className="ml-auto hidden text-[0.65rem] font-medium text-text-secondary sm:block">
              Training simulator
            </span>
          </div>

          <div className="p-4 sm:p-6">
            {/* Scenario tabs */}
            <div className="flex flex-wrap gap-2">
              {SCENARIOS.map((scenario) => {
                const Icon = scenario.icon;
                const isActive = scenario.key === activeKey;
                return (
                  <button
                    key={scenario.key}
                    onClick={() => setActiveKey(scenario.key)}
                    className={`focus-ring flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium transition-all duration-200 sm:px-4 sm:py-2.5 sm:text-sm ${
                      isActive
                        ? 'border-cta/30 bg-cta/10 text-cta shadow-sm'
                        : 'border-border/80 bg-bg-secondary text-text-secondary hover:border-cta/20 hover:text-text-primary'
                    }`}
                  >
                    <Icon size={15} />
                    {scenario.label}
                    {ranScenarios.has(scenario.key) && <CheckCircle2 size={13} className="text-success" />}
                  </button>
                );
              })}
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                key={active.key}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="mt-5 grid gap-4 lg:grid-cols-5"
              >
                {/* Scenario dialogue */}
                <div className="flex flex-col gap-2.5 rounded-2xl border border-border bg-bg-tertiary/40 p-4 lg:col-span-3">
                  <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-text-secondary">
                    Scenario \u2014 {active.label}
                  </p>
                  <TranscriptBubble line={{ role: 'caller', text: active.callerLine }} />
                  <TranscriptBubble line={{ role: 'sarah', text: active.sarahLine }} />

                  {!hasRun ? (
                    <button
                      onClick={runSimulation}
                      className="focus-ring mt-2 inline-flex w-fit items-center gap-2 rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-150 hover:brightness-110 active:scale-[0.97]"
                    >
                      <PlayCircle size={16} />
                      Run Simulation
                    </button>
                  ) : (
                    <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-success">
                      <CheckCircle2 size={14} />
                      Simulation complete \u2014 results scored below
                    </p>
                  )}
                </div>

                {/* Results */}
                <div className="rounded-2xl border border-border bg-bg-secondary p-4 lg:col-span-2">
                  {hasRun ? (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.97 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.35, ease: EASE }}
                    >
                      <div className="flex items-center justify-between">
                        <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-text-secondary">
                          Communication Score
                        </p>
                        <span className="flex items-center gap-0.5 text-[0.65rem] font-semibold text-success">
                          <ArrowUpRight size={12} />
                          Strong
                        </span>
                      </div>
                      <p className={`mt-1 text-3xl font-bold tracking-tight ${scoreTone(active.score)}`}>
                        <CountUp value={`${active.score}`} />
                        <span className="text-base font-medium text-text-secondary">/100</span>
                      </p>

                      <p className="mt-4 text-[0.65rem] font-semibold uppercase tracking-wide text-text-secondary">
                        Improvement Suggestions
                      </p>
                      <ul className="mt-2 flex flex-col gap-1.5">
                        {active.suggestions.map((s) => (
                          <li key={s} className="flex items-start gap-1.5 text-xs leading-relaxed text-text-secondary">
                            <Sparkles size={12} className="mt-0.5 shrink-0 text-accent" />
                            {s}
                          </li>
                        ))}
                      </ul>

                      <p className="mt-4 text-[0.65rem] font-semibold uppercase tracking-wide text-text-secondary">
                        Sales Opportunity
                      </p>
                      <p className="mt-1.5 rounded-lg border border-cta/20 bg-cta/5 px-3 py-2 text-xs leading-relaxed text-cta">
                        {active.opportunity}
                      </p>
                    </motion.div>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center">
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-bg-tertiary text-text-secondary">
                        <Gauge size={18} />
                      </span>
                      <p className="text-xs text-text-secondary">
                        Run the simulation to see your Communication Score, coaching tips, and the sales opportunity.
                      </p>
                    </div>
                  )}
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.div>

        {/* Closing statement */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
          className="mx-auto mt-8 max-w-2xl rounded-2xl border border-cta/20 bg-gradient-to-br from-cta/5 via-bg-secondary to-accent/5 p-5 text-center shadow-card dark:shadow-card-dark sm:mt-12 sm:p-6"
        >
          <p className="text-sm font-medium leading-relaxed text-text-primary sm:text-base">
            {'Not just a receptionist. Not just software. '}
            <span className="text-cta">{'An AI employee that coaches itself'}</span>
            {' \u2014 and gets better on every single call.'}
          </p>
        </motion.div>
      </div>
    </section>
  );
}
