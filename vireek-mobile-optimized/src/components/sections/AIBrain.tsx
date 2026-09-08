import { motion } from 'framer-motion';
import {
  PhoneIncoming, MessageSquareHeart, Brain, Siren,
  Settings, CalendarCheck, DatabaseZap,
  type LucideIcon,
} from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';

interface FlowStep {
  icon: LucideIcon;
  label: string;
  detail: string;
  tone: string;
}

const FLOW: FlowStep[] = [
  { icon: PhoneIncoming, label: 'Incoming Call', detail: 'Sarah picks up on the first ring', tone: 'accent' },
  { icon: MessageSquareHeart, label: 'Natural Conversation', detail: 'Speaks with warmth, pauses, clarifies', tone: 'accent' },
  { icon: Brain, label: 'Intent Understanding', detail: 'Extracts what the caller actually needs', tone: 'cta' },
  { icon: Siren, label: 'Emergency Detection', detail: 'Flags urgency from language and context', tone: 'danger' },
  { icon: Settings, label: 'Business Rules', detail: 'Applies your scheduling and pricing logic', tone: 'cta' },
  { icon: CalendarCheck, label: 'Appointment Booking', detail: 'Checks calendar, confirms a slot', tone: 'success' },
  { icon: DatabaseZap, label: 'CRM Update', detail: 'Writes customer + job data automatically', tone: 'accent' },
];

const TONE_STYLES: Record<string, string> = {
  accent: 'border-accent/30 bg-accent/5 text-accent',
  cta: 'border-cta/30 bg-cta/5 text-cta',
  danger: 'border-danger/30 bg-danger/5 text-danger',
  success: 'border-success/30 bg-success/5 text-success',
};

const CAPABILITIES = [
  { title: 'Context Understanding', body: 'Sarah follows the thread of a conversation and remembers details mentioned earlier.' },
  { title: 'Trade Knowledge', body: 'She knows HVAC terminology, plumbing fixtures, electrical components, and roofing materials.' },
  { title: 'Memory', body: 'Recalls returning customers, past appointments, and job history across calls.' },
  { title: 'Decision Making', body: 'Applies your business rules — pricing, scheduling windows, emergency protocols.' },
  { title: 'Automation', body: 'Every call triggers CRM sync, calendar updates, and customer notifications automatically.' },
];

export function AIBrain() {
  return (
    <section id="ai-brain" className="relative overflow-hidden py-16 sm:py-24 md:py-32">
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-60"
        style={{
          backgroundImage:
            'radial-gradient(circle at 50% 0%, rgb(var(--accent-primary) / 0.08), transparent 50%), radial-gradient(circle at 50% 100%, rgb(var(--accent-secondary) / 0.06), transparent 50%)',
        }}
      />
      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-3xl text-center"
        >
          <p className={eyebrowClass()}>{'AI Technology'}</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>{'The Intelligence Behind Sarah'}</h2>
          <p className="mt-4 text-sm leading-relaxed text-text-secondary sm:mt-5 sm:text-base md:text-lg">
            Every call flows through a seven-stage AI pipeline — from the first ring to a fully
            synced CRM record. This is the infrastructure that makes Sarah feel human.
          </p>
        </motion.div>

        {/* Flow pipeline */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.6, delay: 0.1, ease: EASE }}
          className="mt-10 overflow-hidden rounded-2xl border border-border bg-bg-secondary p-4 shadow-card dark:shadow-card-dark sm:mt-14 sm:p-6"
        >
          {/* Desktop: horizontal flow */}
          <div className="hidden flex-col gap-0 md:flex">
            {FLOW.map((step, i) => {
              const Icon = step.icon;
              return (
                <motion.div
                  key={step.label}
                  initial={{ opacity: 0, x: -12 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.4, delay: 0.15 + i * 0.08, ease: EASE }}
                  className="relative flex items-center gap-4"
                >
                  <div className="flex w-48 shrink-0 items-center gap-3 rounded-xl border bg-bg-tertiary px-4 py-3">
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${TONE_STYLES[step.tone]}`}>
                      <Icon size={17} />
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-text-primary">{step.label}</p>
                      <p className="text-xs text-text-secondary">{step.detail}</p>
                    </div>
                  </div>
                  {i < FLOW.length - 1 && (
                    <div className="h-8 w-px bg-border" />
                  )}
                </motion.div>
              );
            })}
          </div>

          {/* Mobile: vertical flow */}
          <div className="flex flex-col gap-3 md:hidden">
            {FLOW.map((step, i) => {
              const Icon = step.icon;
              return (
                <motion.div
                  key={step.label}
                  initial={{ opacity: 0, y: 8 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.35, delay: 0.15 + i * 0.06, ease: EASE }}
                  className="relative"
                >
                  <div className="flex items-center gap-3 rounded-xl border bg-bg-tertiary px-4 py-3">
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${TONE_STYLES[step.tone]}`}>
                      <Icon size={17} />
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-text-primary">{step.label}</p>
                      <p className="text-xs text-text-secondary">{step.detail}</p>
                    </div>
                  </div>
                  {i < FLOW.length - 1 && (
                    <div className="ml-[1.125rem] h-3 w-px bg-border" />
                  )}
                </motion.div>
              );
            })}
          </div>
        </motion.div>

        {/* Capabilities grid */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.3, ease: EASE }}
          className="mt-8 grid gap-3 sm:mt-10 sm:grid-cols-2 sm:gap-4 lg:grid-cols-5"
        >
          {CAPABILITIES.map((cap) => (
            <div
              key={cap.title}
              className="rounded-xl border border-border bg-bg-secondary p-4 shadow-sm transition-all duration-300 hover:border-accent/20 hover:shadow-card"
            >
              <h3 className="text-sm font-semibold text-text-primary">{cap.title}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-text-secondary">{cap.body}</p>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
