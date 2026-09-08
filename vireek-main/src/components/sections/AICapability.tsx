import { motion } from 'framer-motion';
import {
  Brain, MessageSquareHeart, Siren, Wrench, Clock, Mic,
  type LucideIcon,
} from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

interface Capability {
  icon: LucideIcon;
  title: string;
  body: string;
}

const CAPABILITIES: Capability[] = [
  {
    icon: MessageSquareHeart,
    title: 'Human-like Conversations',
    body: 'Sarah speaks naturally — pausing, clarifying, and responding with the warmth of a real receptionist, not a robotic menu tree.',
  },
  {
    icon: Brain,
    title: 'Understands Context',
    body: 'She follows the thread of a conversation, remembers details mentioned earlier, and asks intelligent follow-up questions.',
  },
  {
    icon: Mic,
    title: 'Handles Interruptions',
    body: 'Callers can interrupt, change direction, or add information mid-sentence. Sarah adapts instantly without losing track.',
  },
  {
    icon: Siren,
    title: 'Emergency Detection',
    body: 'A gas leak, a burst pipe, a sparking outlet — Sarah recognizes urgency from language and context, then flags it for immediate dispatch.',
  },
  {
    icon: Wrench,
    title: 'Industry Knowledge',
    body: 'She knows the difference between a heat pump and a boiler, a main line and a secondary line — trained on home-service terminology.',
  },
  {
    icon: Clock,
    title: '24/7 Availability',
    body: 'Sarah never takes a break, never calls in sick, and never lets a call go to voicemail — at 2am on Christmas or Tuesday at noon.',
  },
];

export function AICapability() {
  return (
    <section id="ai-capability" className="relative overflow-hidden py-16 sm:py-24 md:py-32">
      {/* Ambient backdrop */}
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-60"
        style={{
          backgroundImage:
            'radial-gradient(circle at 15% 25%, rgb(var(--accent-primary) / 0.08), transparent 50%), radial-gradient(circle at 85% 75%, rgb(var(--accent-secondary) / 0.06), transparent 50%)',
        }}
      />
      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <p className={eyebrowClass()}>{'Why Sarah is different'}</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>{'Not a Chatbot. A Voice Receptionist.'}</h2>
          <p className={`${bodyClass()} text-sm sm:text-base md:text-lg`}>
            {'Generic AI assistants read scripts and follow rigid decision trees. Sarah listens, understands, and thinks on her feet — the way your best receptionist would.'}
          </p>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-10 grid gap-4 sm:mt-14 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3"
        >
          {CAPABILITIES.map(({ icon: Icon, title, body }) => (
            <motion.div
              key={title}
              variants={fadeUpItem}
              transition={{ duration: 0.5, ease: EASE }}
              className="group relative overflow-hidden rounded-2xl border border-border bg-bg-secondary p-5 shadow-card transition-all duration-300 ease-out hover:-translate-y-1 hover:border-accent/30 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark sm:p-7"
            >
              {/* Subtle hover glow */}
              <div
                className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                style={{
                  backgroundImage:
                    'radial-gradient(circle at 50% 0%, rgb(var(--accent-primary) / 0.06), transparent 60%)',
                }}
              />
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent transition-colors duration-300 group-hover:bg-accent group-hover:text-white sm:h-12 sm:w-12">
                <Icon size={20} className="sm:size-[22px]" />
              </span>
              <h3 className="mt-4 text-base font-semibold text-text-primary sm:mt-5 sm:text-lg">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary sm:mt-2.5">{body}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
