import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Droplets,
  Wind,
  Zap,
  CloudRain,
  ShieldAlert,
  Languages,
  Brain,
  MessageSquare,
  Mail,
  PhoneCall,
  Smartphone,
  Gauge,
  ArrowDown,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { CountUp } from '@/components/ui/CountUp';

/**
 * EmergencyIntelligence
 * ------------------------------------------------------------------
 * "Emergency Intelligence Engine" — Vireek's strongest competitive
 * advantage section. Proves Sarah understands dangerous situations
 * the way an experienced dispatcher would, not the way a generic
 * AI assistant reads a keyword list.
 *
 * Four parts, one narrative arc:
 *  1. Emergency Detection System — trade-by-trade danger signals.
 *  2. Emergency Intelligence Score — a real scored example call.
 *  3. One AI Brain — every channel (phone, chat, SMS, email)
 *     collapses into one memory and one customer profile.
 *  4. Global Ready — the multilingual architecture Vireek is built on.
 *
 * Self-contained — owns its own copy, mock data, and local
 * interaction state. Built entirely on the site's existing design
 * tokens and shared motion helpers; no backend required.
 * ------------------------------------------------------------------
 */

/* ------------------------------------------------------------------ */
/*  Emergency Detection System — mock data                             */
/* ------------------------------------------------------------------ */

interface Signal {
  title: string;
  detail: string;
}

interface Trade {
  key: string;
  label: string;
  icon: LucideIcon;
  signals: Signal[];
}

const TRADES: Trade[] = [
  {
    key: 'plumbing',
    label: 'Plumbing',
    icon: Droplets,
    signals: [
      { title: 'Burst Pipes', detail: 'Active water damage risk \u2014 dispatched within the hour.' },
      { title: 'Flooding', detail: 'Property and safety risk \u2014 flagged as critical immediately.' },
      { title: 'Sewer Backup', detail: 'Health hazard \u2014 prioritized above routine plumbing calls.' },
    ],
  },
  {
    key: 'hvac',
    label: 'HVAC',
    icon: Wind,
    signals: [
      { title: 'No Heat', detail: 'Elevated risk in freezing conditions or with vulnerable residents.' },
      { title: 'Gas Smell', detail: 'Life-safety event \u2014 Sarah gives safety guidance and dispatches immediately.' },
      { title: 'AC Failure', detail: 'Escalated in extreme heat, especially for elderly or medically fragile occupants.' },
    ],
  },
  {
    key: 'electrical',
    label: 'Electrical',
    icon: Zap,
    signals: [
      { title: 'Sparks', detail: 'Fire risk \u2014 treated as an emergency regardless of time of day.' },
      { title: 'Burning Smell', detail: 'Potential electrical fire \u2014 immediate dispatch triggered.' },
      { title: 'Power Danger', detail: 'Exposed wiring or shock risk \u2014 flagged for urgent same-day service.' },
    ],
  },
  {
    key: 'roofing',
    label: 'Roofing',
    icon: CloudRain,
    signals: [
      { title: 'Storm Damage', detail: 'Structural risk \u2014 prioritized after severe weather events.' },
      { title: 'Active Leaks', detail: 'Ongoing interior damage \u2014 escalated above routine roofing calls.' },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Emergency Intelligence Score — example                             */
/* ------------------------------------------------------------------ */

const SCORE_EXAMPLE = {
  score: 98,
  riskLevel: 'Critical',
  reasoning:
    'Caller reported a strong gas smell near the furnace, with a household member on home oxygen. Language and context both indicate an immediate life-safety risk \u2014 this is prioritized above every non-emergency call in the queue.',
  action: 'Immediate Dispatch Recommended',
};

/* ------------------------------------------------------------------ */
/*  One AI Brain — channels                                            */
/* ------------------------------------------------------------------ */

interface Channel {
  icon: LucideIcon;
  label: string;
}

const CHANNELS: Channel[] = [
  { icon: PhoneCall, label: 'Phone' },
  { icon: MessageSquare, label: 'Website Chat' },
  { icon: Smartphone, label: 'SMS' },
  { icon: Mail, label: 'Email' },
];

/* ------------------------------------------------------------------ */
/*  Global Ready — languages                                           */
/* ------------------------------------------------------------------ */

const LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Arabic', 'Chinese', 'Japanese', 'Persian'];

function riskTone(risk: string) {
  if (risk === 'Critical') return 'text-danger bg-danger/10';
  if (risk === 'High') return 'text-cta bg-cta/10';
  return 'text-accent bg-accent/10';
}

/* ------------------------------------------------------------------ */
/*  Section                                                             */
/* ------------------------------------------------------------------ */

export function EmergencyIntelligence() {
  const [activeKey, setActiveKey] = useState(TRADES[0].key);
  const active = TRADES.find((t) => t.key === activeKey) ?? TRADES[0];

  return (
    <section id="emergency-intelligence" className="relative overflow-hidden py-16 sm:py-24 md:py-32">
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-60"
        style={{
          backgroundImage:
            'radial-gradient(circle at 85% 0%, rgb(var(--danger) / 0.07), transparent 45%), radial-gradient(circle at 10% 100%, rgb(var(--accent-primary) / 0.07), transparent 45%)',
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
          <p className={eyebrowClass()}>{'Emergency Intelligence Engine'}</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>
            {'Sarah Knows the Difference Between Urgent and Dangerous'}
          </h2>
          <p className={`${bodyClass()} mx-auto max-w-2xl text-sm sm:text-base md:text-lg`}>
            {"Generic AI assistants match keywords. Sarah understands risk \u2014 trade by trade, situation by situation \u2014 the way an experienced dispatcher would."}
          </p>
        </motion.div>

        {/* ============================================================ */}
        {/*  Emergency Detection System                                   */}
        {/* ============================================================ */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.6, delay: 0.1, ease: EASE }}
          className="mt-10 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark sm:mt-14 sm:rounded-3xl"
        >
          <div className="flex items-center gap-2 border-b border-border bg-bg-tertiary px-4 py-3.5 sm:px-6">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-danger/15 text-danger">
              <ShieldAlert size={14} />
            </span>
            <span className="text-xs font-semibold text-text-primary sm:text-sm">Emergency Detection System</span>
            <span className="ml-auto hidden text-[0.65rem] font-medium text-text-secondary sm:block">
              By trade
            </span>
          </div>

          <div className="p-4 sm:p-6">
            {/* Trade tabs */}
            <div className="flex flex-wrap gap-2">
              {TRADES.map((trade) => {
                const Icon = trade.icon;
                const isActive = trade.key === activeKey;
                return (
                  <button
                    key={trade.key}
                    onClick={() => setActiveKey(trade.key)}
                    className={`focus-ring flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium transition-all duration-200 sm:px-4 sm:py-2.5 sm:text-sm ${
                      isActive
                        ? 'border-danger/30 bg-danger/10 text-danger shadow-sm'
                        : 'border-border/80 bg-bg-secondary text-text-secondary hover:border-danger/20 hover:text-text-primary'
                    }`}
                  >
                    <Icon size={15} />
                    {trade.label}
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
                className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              >
                {active.signals.map((signal) => (
                  <div
                    key={signal.title}
                    className="rounded-xl border border-danger/15 bg-danger/[0.03] p-4 transition-colors duration-200 hover:border-danger/30"
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
                        <ShieldAlert size={15} />
                      </span>
                      <h3 className="text-sm font-semibold text-text-primary">{signal.title}</h3>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-text-secondary">{signal.detail}</p>
                  </div>
                ))}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.div>

        {/* ============================================================ */}
        {/*  Emergency Intelligence Score                                 */}
        {/* ============================================================ */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.6, delay: 0.15, ease: EASE }}
          className="mt-6 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark sm:mt-8 sm:rounded-3xl"
        >
          <div className="flex items-center gap-2 border-b border-border bg-bg-tertiary px-4 py-3.5 sm:px-6">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <Gauge size={14} />
            </span>
            <span className="text-xs font-semibold text-text-primary sm:text-sm">Emergency Intelligence Score</span>
            <span className="ml-auto rounded-full bg-bg-secondary px-2.5 py-1 text-[0.65rem] font-medium text-text-secondary">
              Example analysis
            </span>
          </div>

          <div className="grid gap-5 p-4 sm:p-6 lg:grid-cols-5">
            {/* Score dial */}
            <div className="flex flex-col items-center justify-center rounded-2xl border border-danger/20 bg-danger/[0.04] p-5 lg:col-span-2">
              <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-text-secondary">
                Emergency Intelligence Score
              </p>
              <p className="mt-1 text-5xl font-bold tracking-tight text-danger sm:text-6xl">
                <CountUp value={`${SCORE_EXAMPLE.score}`} />
                <span className="text-xl font-medium text-text-secondary">/100</span>
              </p>
              <span
                className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${riskTone(SCORE_EXAMPLE.riskLevel)}`}
              >
                <ShieldAlert size={13} />
                Risk Level: {SCORE_EXAMPLE.riskLevel}
              </span>
              <p className="mt-3 text-center text-sm font-semibold text-text-primary">{SCORE_EXAMPLE.action}</p>
            </div>

            {/* Reasoning */}
            <div className="rounded-2xl border border-border bg-bg-tertiary/40 p-5 lg:col-span-3">
              <div className="flex items-center gap-2">
                <Sparkles size={14} className="text-accent" />
                <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-text-secondary">
                  AI Reasoning
                </p>
              </div>
              <p className="mt-2.5 text-sm leading-relaxed text-text-secondary">{SCORE_EXAMPLE.reasoning}</p>

              <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-cta/15 text-cta">
                  <ArrowDown size={13} />
                </span>
                <div>
                  <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-text-secondary">
                    Recommended Action
                  </p>
                  <p className="text-sm font-semibold text-cta">{SCORE_EXAMPLE.action}</p>
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        {/* ============================================================ */}
        {/*  One AI Brain                                                 */}
        {/* ============================================================ */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.6, delay: 0.2, ease: EASE }}
          className="mt-6 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:mt-8 sm:rounded-3xl sm:p-8"
        >
          <div className="mx-auto max-w-2xl text-center">
            <p className={eyebrowClass()}>{'One AI Brain'}</p>
            <h3 className="mt-2 text-xl font-bold tracking-tight text-text-primary sm:text-2xl">
              {'Every Channel. One Memory. One Customer Profile.'}
            </h3>
          </div>

          <div className="mt-8 flex flex-col items-center gap-3">
            {/* Channels row */}
            <div className="grid w-full max-w-2xl grid-cols-4 gap-2.5 sm:gap-4">
              {CHANNELS.map((channel, i) => {
                const Icon = channel.icon;
                return (
                  <motion.div
                    key={channel.label}
                    initial={{ opacity: 0, y: 10 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={viewport}
                    transition={{ duration: 0.4, delay: 0.25 + i * 0.06, ease: EASE }}
                    className="flex flex-col items-center gap-2 rounded-xl border border-border bg-bg-tertiary/50 px-2 py-3 sm:px-4 sm:py-4"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent sm:h-10 sm:w-10">
                      <Icon size={17} />
                    </span>
                    <span className="text-center text-[0.65rem] font-medium text-text-secondary sm:text-xs">
                      {channel.label}
                    </span>
                  </motion.div>
                );
              })}
            </div>

            {/* Converging lines */}
            <div className="flex items-center gap-6 text-border sm:gap-10">
              {CHANNELS.map((c) => (
                <ArrowDown key={c.label} size={16} className="text-accent/40" />
              ))}
            </div>

            {/* Central brain */}
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={viewport}
              transition={{ duration: 0.5, delay: 0.5, ease: EASE }}
              className="flex flex-col items-center"
            >
              <div className="relative flex h-16 w-16 items-center justify-center sm:h-20 sm:w-20">
                <span className="absolute inset-0 animate-[ping_3s_ease-in-out_infinite] rounded-full bg-accent/10" />
                <div className="relative flex h-14 w-14 items-center justify-center rounded-full border border-accent/30 bg-bg-secondary shadow-glow-accent sm:h-16 sm:w-16">
                  <Brain size={24} className="text-accent" strokeWidth={1.75} />
                </div>
              </div>
              <p className="mt-2 text-sm font-semibold text-text-primary">One AI Brain</p>
            </motion.div>

            <ArrowDown size={16} className="text-accent/40" />

            {/* Unified output */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.4, delay: 0.6, ease: EASE }}
              className="rounded-xl border border-accent/25 bg-accent/5 px-5 py-3 text-center"
            >
              <p className="text-sm font-semibold text-accent">One Unified Customer Profile</p>
              <p className="mt-0.5 text-xs text-text-secondary">
                Every call, chat, text, and email \u2014 remembered together, forever.
              </p>
            </motion.div>
          </div>
        </motion.div>

        {/* ============================================================ */}
        {/*  Global Ready                                                 */}
        {/* ============================================================ */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.25, ease: EASE }}
          className="mt-6 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:mt-8 sm:rounded-3xl sm:p-8"
        >
          <div className="flex flex-col items-center gap-3 text-center sm:flex-row sm:items-start sm:justify-between sm:text-left">
            <div>
              <p className={eyebrowClass()}>{'Global Ready'}</p>
              <h3 className="mt-2 text-xl font-bold tracking-tight text-text-primary sm:text-2xl">
                {'Built to Speak Your Customers\u2019 Language'}
              </h3>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-text-secondary">
                {"Sarah's architecture is built for multilingual conversation from the ground up \u2014 ready to expand as Vireek grows into new markets."}
              </p>
            </div>
            <span className="hidden h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent sm:flex">
              <Languages size={24} />
            </span>
          </div>

          <div className="mt-5 flex flex-wrap justify-center gap-2 sm:justify-start">
            {LANGUAGES.map((lang, i) => (
              <motion.span
                key={lang}
                initial={{ opacity: 0, scale: 0.9 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={viewport}
                transition={{ duration: 0.3, delay: 0.3 + i * 0.04, ease: EASE }}
                className="rounded-full border border-border bg-bg-tertiary px-3.5 py-1.5 text-xs font-medium text-text-secondary"
              >
                {lang}
              </motion.span>
            ))}
          </div>
        </motion.div>

        {/* Closing / final positioning statement */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.3, ease: EASE }}
          className="mx-auto mt-8 max-w-2xl rounded-2xl border border-accent/20 bg-gradient-to-br from-accent/5 via-bg-secondary to-cta/5 p-6 text-center shadow-card dark:shadow-card-dark sm:mt-12 sm:p-8"
        >
          <p className="text-base font-semibold leading-relaxed text-text-primary sm:text-lg">
            {'Vireek is '}
            <span className="text-accent">{'the AI operating system'}</span>
            {' that runs home service businesses.'}
          </p>
        </motion.div>
      </div>
    </section>
  );
}
