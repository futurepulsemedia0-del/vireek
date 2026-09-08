import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Phone, Zap, Clock, ShieldCheck, ArrowRight, PhoneIncoming, Siren, CalendarCheck, BellRing } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { SARAH_PHONE } from '@/lib/site';

const TRUST_ITEMS = [
  { icon: Clock, label: '24/7 answering' },
  { icon: Zap, label: 'Emergency detection' },
  { icon: ShieldCheck, label: 'Live in 15 minutes' },
];

const EASE = [0.16, 1, 0.0, 1] as const;

// Rotating transcript lines — the one signature detail on the page that
// can't be copy-pasted from a template: it's specific to what Sarah
// actually says on a real call, not a generic "AI is working" shimmer.
const TRANSCRIPT_LINES = [
  '"Ramirez Plumbing, this is Sarah — how can I help?"',
  '"I hear water running — is this an active leak right now?"',
  '"I can get someone out today at 2:30. Does that work?"',
  '"You\'re all set — text confirmation is on its way."',
];

function Waveform({ active }: { active: boolean }) {
  const bars = [0.4, 0.7, 1, 0.55, 0.32, 0.62, 0.42];
  return (
    <div className="flex items-end gap-[3px]" aria-hidden="true">
      {bars.map((h, i) => (
        <motion.span
          key={i}
          className="w-[3px] rounded-full bg-accent/60"
          style={{ height: `${h * 26}px` }}
          animate={active ? { scaleY: [0.5, 1, 0.65, 0.85, 0.5] } : { scaleY: 0.4 }}
          transition={{
            duration: 1.5 + i * 0.1,
            repeat: active ? Infinity : 0,
            ease: 'easeInOut',
            delay: i * 0.15,
          }}
        />
      ))}
    </div>
  );
}

function TranscriptTicker() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % TRANSCRIPT_LINES.length), 3600);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex min-h-[2.75rem] flex-1 items-center overflow-hidden">
      <AnimatePresence mode="wait">
        <motion.p
          key={index}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.35, ease: EASE }}
          className="text-[0.8125rem] italic leading-snug text-text-secondary"
        >
          {TRANSCRIPT_LINES[index]}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}

const FLOW_STEPS = [
  { icon: PhoneIncoming, label: 'Call received', detail: 'Ramirez Plumbing', tone: 'accent' as const },
  { icon: Siren, label: 'Emergency detected', detail: 'Burst pipe — dispatch', tone: 'cta' as const },
  { icon: CalendarCheck, label: 'Appointment booked', detail: 'Today, 2:30 PM', tone: 'success' as const },
  { icon: BellRing, label: 'Customer notified', detail: 'SMS confirmation sent', tone: 'accent' as const },
];

const TONE_CLASS = {
  accent: 'bg-accent/10 text-accent',
  cta: 'bg-cta/10 text-cta',
  success: 'bg-success/10 text-success',
};

/**
 * The one hero visual. Deliberately a live, working recreation of the
 * product — not a stock photo, not a static screenshot — because a real
 * demo makes its own case better than a headline can. Sits inside a
 * confident bordered card so it reads as "this is the software" rather
 * than "this is a marketing illustration of the software."
 */
function ProductVisual() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, rotate: -0.4 }}
      animate={{ opacity: 1, y: 0, rotate: 0 }}
      transition={{ duration: 0.7, delay: 0.25, ease: EASE }}
      className="relative w-full max-w-[440px]"
    >
      <div className="relative overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Phone size={14} />
          </span>
          <span className="text-sm font-semibold text-text-primary">Sarah — live call</span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
            </span>
            <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-success">Active</span>
          </span>
        </div>

        <div className="flex items-center gap-4 border-b border-border bg-bg-tertiary/60 px-4 py-4">
          <Waveform active />
          <TranscriptTicker />
        </div>

        <div className="divide-y divide-border/60">
          {FLOW_STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <motion.div
                key={step.label}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.4, delay: 0.55 + i * 0.15, ease: EASE }}
                className="flex items-center gap-3 px-4 py-3"
              >
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TONE_CLASS[step.tone]}`}>
                  <Icon size={15} />
                </span>
                <div className="flex-1">
                  <p className="text-[0.8125rem] font-semibold leading-tight text-text-primary">{step.label}</p>
                  <p className="text-xs text-text-secondary">{step.detail}</p>
                </div>
              </motion.div>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-border bg-bg-tertiary px-4 py-3">
          <span className="text-[0.6875rem] font-medium text-text-secondary">CRM synced automatically</span>
          <span className="text-[0.6875rem] font-semibold text-success">Completed in 42s</span>
        </div>
      </div>

      {/* Floating proof card — the one decorative element, and it's a number, not a blob */}
      <motion.div
        initial={{ opacity: 0, scale: 0.85, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 1.15, ease: EASE }}
        className="absolute -left-6 -top-6 hidden w-[176px] rounded-xl border border-border bg-bg-secondary px-4 py-3 shadow-card dark:shadow-card-dark sm:block"
      >
        <p className="font-display text-2xl font-semibold text-text-primary">0</p>
        <p className="text-xs text-text-secondary">missed calls today — 14 before Vireek</p>
      </motion.div>
    </motion.div>
  );
}

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden bg-noise bg-gradient-mesh">
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-bg-primary via-bg-primary to-bg-secondary" />

      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 items-center gap-16 px-5 pb-20 pt-28 sm:px-6 sm:pt-32 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10 lg:pb-28 lg:pt-40">
        {/* Left — message + action */}
        <div className="text-center lg:text-left">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="mx-auto mb-6 flex w-fit items-center gap-2 rounded-full border border-border bg-bg-secondary/70 py-1.5 pl-1.5 pr-3.5 lg:mx-0"
          >
            <div className="flex -space-x-1.5">
              {['J', 'M', 'S', 'R'].map((initial, i) => (
                <span
                  key={i}
                  className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-bg-secondary bg-accent-100 text-[0.55rem] font-bold text-accent-700 dark:bg-accent-900 dark:text-accent-200"
                >
                  {initial}
                </span>
              ))}
            </div>
            <span className="text-xs font-medium text-text-secondary">Now onboarding early contractors</span>
          </motion.div>

          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.05, ease: EASE }}
            className="text-eyebrow font-semibold uppercase tracking-[0.16em] text-accent"
          >
            AI voice receptionist for home services
          </motion.p>

          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.1, ease: EASE }}
            className="mx-auto mt-4 max-w-xl font-display text-[2.75rem] font-semibold leading-[1.04] tracking-tightest text-text-primary sm:text-6xl lg:mx-0 lg:text-[3.75rem]"
          >
            Every call answered.
            <br />
            Every job booked.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.15, ease: EASE }}
            className="mx-auto mt-5 max-w-md text-[1.0625rem] leading-relaxed text-text-secondary lg:mx-0"
          >
            Sarah answers calls 24/7, tells a burst pipe from a routine question, books the
            job straight into your calendar, and syncs the record to your CRM — before you'd
            have finished saying hello.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.2, ease: EASE }}
            className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start"
          >
            <Link to="/login" className="w-full sm:w-auto">
              <Button variant="primary" size="lg" className="w-full gap-2 sm:w-auto">
                Start free trial
                <ArrowRight size={18} />
              </Button>
            </Link>
            <a href={SARAH_PHONE} className="w-full sm:w-auto">
              <Button variant="secondary" size="lg" className="w-full gap-2 sm:w-auto">
                <Phone size={16} />
                Call Sarah now
              </Button>
            </a>
          </motion.div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.25, ease: EASE }}
            className="mt-4 text-sm text-text-secondary/80"
          >
            14-day free trial · No credit card required · Cancel anytime
          </motion.p>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.3, ease: EASE }}
            className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 border-t border-border/70 pt-6 text-sm text-text-secondary lg:justify-start"
          >
            {TRUST_ITEMS.map((item) => (
              <span key={item.label} className="flex items-center gap-2">
                <item.icon size={15} className="text-accent" />
                {item.label}
              </span>
            ))}
          </motion.div>
        </div>

        {/* Right — the product, live */}
        <div className="flex justify-center lg:justify-end">
          <ProductVisual />
        </div>
      </div>
    </section>
  );
}
