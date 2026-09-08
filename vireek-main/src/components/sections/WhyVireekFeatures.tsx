import { motion } from 'framer-motion';
import {
  Wrench, Siren, DollarSign, Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

interface FeatureBlock {
  icon: LucideIcon;
  title: string;
  body: string;
  detail: string;
  accent: string;
}

const FEATURES: FeatureBlock[] = [
  {
    icon: Wrench,
    title: 'Built For Home Services',
    body: 'Vireek understands HVAC, plumbing, roofing, electrical, and restoration. Sarah knows the difference between a heat pump and a boiler, a main line and a secondary line.',
    detail: 'Trade-specific knowledge baked in — not a generic chatbot guessing.',
    accent: 'accent',
  },
  {
    icon: Siren,
    title: 'Emergency Intelligence',
    body: 'Vireek identifies urgent situations from language and context — a gas leak, a burst pipe, a sparking outlet — and prioritizes them for immediate dispatch.',
    detail: 'True emergencies jump the queue. Sarah handles the rest.',
    accent: 'danger',
  },
  {
    icon: DollarSign,
    title: 'Revenue Recovery Engine',
    body: 'Every answered call becomes a potential booked job. Sarah doesn\'t just take messages — she qualifies, schedules, and captures revenue that would have been lost.',
    detail: 'Stop losing jobs to voicemail. Start recovering every call.',
    accent: 'success',
  },
  {
    icon: Sparkles,
    title: 'AI Employee, Not Just A Chatbot',
    body: 'Vireek acts like a trained receptionist — pausing, clarifying, remembering context, and making decisions. She handles interruptions and follows up intelligently.',
    detail: 'Your best receptionist, available 24/7/365.',
    accent: 'cta',
  },
];

const ACCENT_BG: Record<string, string> = {
  accent: 'bg-accent/10 text-accent group-hover:bg-accent group-hover:text-white',
  danger: 'bg-danger/10 text-danger group-hover:bg-danger group-hover:text-white',
  success: 'bg-success/10 text-success group-hover:bg-success group-hover:text-white',
  cta: 'bg-cta/10 text-cta group-hover:bg-cta group-hover:text-white',
};

const ACCENT_LINE: Record<string, string> = {
  accent: 'from-accent/40',
  danger: 'from-danger/40',
  success: 'from-success/40',
  cta: 'from-cta/40',
};

export function WhyVireekFeatures() {
  return (
    <section id="why-vireek" className="relative overflow-hidden py-16 sm:py-24 md:py-32">
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-50"
        style={{
          backgroundImage:
            'radial-gradient(circle at 30% 20%, rgb(var(--accent-primary) / 0.06), transparent 50%), radial-gradient(circle at 70% 80%, rgb(var(--accent-secondary) / 0.05), transparent 50%)',
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
          <p className={eyebrowClass()}>{'Why Vireek'}</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>{'Why Contractors Choose Vireek'}</h2>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-10 grid gap-4 sm:mt-14 sm:gap-6 lg:grid-cols-2"
        >
          {FEATURES.map((feature) => {
            const Icon = feature.icon;
            return (
              <motion.div
                key={feature.title}
                variants={fadeUpItem}
                transition={{ duration: 0.5, ease: EASE }}
                className="group relative overflow-hidden rounded-2xl border border-border bg-bg-secondary p-6 shadow-card transition-all duration-300 ease-out hover:-translate-y-1 hover:border-accent/25 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark sm:p-8"
              >
                <div className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r ${ACCENT_LINE[feature.accent]} to-transparent`} />
                <div
                  className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                  style={{
                    backgroundImage: 'radial-gradient(circle at 50% 0%, rgb(var(--accent-primary) / 0.05), transparent 60%)',
                  }}
                />
                <div className="flex items-start gap-4">
                  <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl transition-colors duration-300 ${ACCENT_BG[feature.accent]} sm:h-14 sm:w-14`}>
                    <Icon size={22} className="sm:size-6" />
                  </span>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-text-primary sm:text-xl">{feature.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-text-secondary sm:text-base">{feature.body}</p>
                    <p className="mt-3 text-xs font-medium text-accent sm:text-sm">{feature.detail}</p>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      </div>
    </section>
  );
}
