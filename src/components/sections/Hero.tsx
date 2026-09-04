import { motion } from 'framer-motion';
import { Phone, Zap, Clock, ShieldCheck, ArrowRight, PhoneIncoming, Siren, CalendarCheck, BellRing, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { RevealImage } from '@/components/ui/RevealImage';
import { SARAH_PHONE } from '@/lib/site';

const TRUST_ITEMS = [
  { icon: Clock, label: '24/7 AI Answering' },
  { icon: Zap, label: 'Emergency Detection' },
  { icon: ShieldCheck, label: 'Setup in 15 Min' },
];

const fadeUp = {
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
};

const EASE = [0.16, 1, 0.0, 1] as const;

function Waveform() {
  const bars = [0.45, 0.8, 1, 0.65, 0.35, 0.7, 0.5];
  return (
    <div className="flex items-end justify-center gap-2 sm:gap-2.5" aria-hidden="true">
      {bars.map((h, i) => (
        <motion.span
          key={i}
          className="w-2 rounded-full bg-accent/70 sm:w-3"
          style={{ height: `${h * 48}px` }}
          animate={{ scaleY: [0.55, 1, 0.7, 0.9, 0.55] }}
          transition={{
            duration: 1.6 + i * 0.11,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: i * 0.18,
          }}
        />
      ))}
    </div>
  );
}

const FLOW_STEPS = [
  { icon: PhoneIncoming, label: 'Call Received', detail: 'Ramirez Plumbing', tone: 'accent' as const },
  { icon: Siren, label: 'Emergency Detected', detail: 'Burst pipe — dispatch', tone: 'danger' as const },
  { icon: CalendarCheck, label: 'Appointment Booked', detail: 'Today, 2:30 PM', tone: 'success' as const },
  { icon: BellRing, label: 'Customer Notified', detail: 'SMS confirmation sent', tone: 'accent' as const },
];

const TONE_CLASS = {
  accent: 'bg-accent/10 text-accent',
  danger: 'bg-danger/10 text-danger',
  success: 'bg-success/10 text-success',
};

function ProductVisual() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay: 0.3, ease: EASE }}
      className="relative mx-auto mt-12 max-w-4xl sm:mt-16"
    >
      {/* Card */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark sm:rounded-3xl">
        {/* Top accent line */}
        <div className="h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />

        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border bg-bg-tertiary px-4 py-3 sm:px-5 sm:py-3.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Phone size={14} />
          </span>
          <span className="text-sm font-semibold text-text-primary">Sarah — Live Call</span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            <span className="text-xs font-medium text-success">Active</span>
          </span>
        </div>

        {/* Waveform */}
        <div className="border-b border-border bg-bg-tertiary/50 px-5 py-5 sm:py-6">
          <Waveform />
        </div>

        {/* Flow steps */}
        <div className="divide-y divide-border/60">
          {FLOW_STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <motion.div
                key={step.label}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.4, delay: 0.5 + i * 0.15, ease: EASE }}
                className="flex items-center gap-3 px-4 py-3.5 sm:px-5 sm:py-4"
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${TONE_CLASS[step.tone]}`}>
                  <Icon size={16} />
                </span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-text-primary">{step.label}</p>
                  <p className="text-xs text-text-secondary">{step.detail}</p>
                </div>
                <ChevronRight size={14} className="text-text-secondary/30" />
              </motion.div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border bg-bg-tertiary px-4 py-3 sm:px-5">
          <span className="text-xs font-medium text-text-secondary">CRM synced automatically</span>
          <span className="text-xs font-semibold text-success">Completed in 42s</span>
        </div>
      </div>

      {/* Floating accent badges — desktop only */}
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, delay: 1.2, ease: EASE }}
        className="absolute -right-4 top-20 hidden rounded-xl border border-border bg-bg-secondary px-4 py-3 shadow-card lg:block"
      >
        <p className="text-xs font-semibold text-text-primary">0 missed calls today</p>
        <p className="text-[0.7rem] text-text-secondary">vs. 14 before Vireek</p>
      </motion.div>
    </motion.div>
  );
}

export function Hero() {
  return (
    <section
      id="top"
      className="relative flex min-h-[88vh] items-center overflow-hidden bg-noise bg-gradient-mesh sm:min-h-[92vh]"
    >
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-bg-primary via-bg-primary to-bg-secondary" />

      <div className="mx-auto w-full max-w-7xl px-5 py-24 text-center sm:px-6 sm:py-32 md:py-40">
        {/* Social proof badge */}
        <motion.div
          {...fadeUp}
          transition={{ duration: 0.4, ease: EASE }}
          className="mx-auto mb-5 flex w-fit items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1.5 sm:mb-6 sm:px-4 sm:py-2"
        >
          <div className="flex -space-x-2">
            {['J', 'M', 'S', 'R'].map((initial, i) => (
              <span
                key={i}
                className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-bg-primary bg-accent/20 text-[0.625rem] font-bold text-accent sm:h-7 sm:w-7 sm:text-xs"
              >
                {initial}
              </span>
            ))}
          </div>
          <span className="text-xs font-medium text-text-secondary sm:text-sm">
            Now onboarding early contractors
          </span>
        </motion.div>

        <motion.p
          {...fadeUp}
          transition={{ duration: 0.5, ease: EASE }}
          className="text-[0.7rem] font-semibold uppercase tracking-[0.15em] text-accent sm:text-eyebrow"
        >
          AI Voice Receptionist for Home Services
        </motion.p>

        <motion.h1
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.05, ease: EASE }}
          className="mx-auto mt-4 max-w-5xl text-4xl font-bold leading-[1.08] tracking-tight text-text-primary sm:mt-5 sm:text-5xl sm:leading-[1.05] md:text-6xl lg:text-7xl xl:text-8xl"
        >
          Every Call Answered.
          <br />
          <span className="text-accent">Every Job Booked.</span>
        </motion.h1>

        <motion.p
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
          className="mx-auto mt-5 max-w-2xl text-sm leading-relaxed text-text-secondary sm:mt-7 sm:text-base md:text-lg"
        >
          Sarah is your AI voice receptionist — answering calls 24/7, detecting emergencies,
          booking appointments, and syncing to your CRM. So you focus on the job, not the phone.
        </motion.p>

        <motion.div
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.15, ease: EASE }}
          className="mt-8 flex flex-col items-center gap-3 sm:mt-10 sm:flex-row sm:justify-center sm:gap-4"
        >
          <Link to="/login" className="w-full sm:w-auto">
            <Button variant="primary" size="lg" className="w-full gap-2 sm:w-auto">
              Start Free Trial
              <ArrowRight size={18} />
            </Button>
          </Link>
          <a href={SARAH_PHONE} className="w-full sm:w-auto">
            <Button variant="ghost" size="lg" className="w-full gap-2 sm:w-auto">
              <Phone size={18} />
              Call Sarah Now
            </Button>
          </a>
        </motion.div>

        <motion.p
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.18, ease: EASE }}
          className="mt-4 text-xs font-medium text-text-secondary/80 sm:text-sm"
        >
          14-day free trial · No credit card required · Cancel anytime
        </motion.p>

        <motion.div
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
          className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-text-secondary sm:mt-8 sm:gap-x-6 sm:gap-y-3 sm:text-sm"
        >
          {TRUST_ITEMS.map((item) => (
            <span key={item.label} className="flex items-center gap-1.5 sm:gap-2">
              <item.icon size={14} className="text-accent sm:size-4" />
              {item.label}
            </span>
          ))}
        </motion.div>

        <RevealImage
          name="hero"
          alt="Home service business owner using Vireek AI voice receptionist"
          priority
          parallax={30}
          className="mx-auto mt-12 max-w-5xl sm:mt-16"
        />

        <ProductVisual />
      </div>
    </section>
  );
}
