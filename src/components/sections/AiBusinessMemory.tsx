import { useId } from 'react';
import { motion } from 'framer-motion';
import {
  Building2,
  UserCheck,
  Wrench,
  Siren,
  Sparkles,
  CalendarClock,
  Brain,
  type LucideIcon,
} from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';

/**
 * AiBusinessMemory
 * ------------------------------------------------------------------
 * "AI Business Memory Engine" — premium landing page section.
 *
 * Positions Vireek as a business-intelligence layer, not a chatbot:
 * Sarah doesn't just answer calls, she carries a live, structured
 * model of the business — knowledge, memory, rules, tone, and
 * scheduling logic — that every call is checked against.
 *
 * Fully self-contained: owns its own copy, layout and animation.
 * Uses only the existing design tokens (colors, radii, shadows) and
 * motion helpers already shared across the site, so it drops in
 * without touching global styles.
 * ------------------------------------------------------------------
 */

interface MemoryNode {
  icon: LucideIcon;
  title: string;
  body: string;
  insight: string;
  /** position on a 0–100 canvas, matched between the SVG and the cards */
  x: number;
  y: number;
}

const NODES: MemoryNode[] = [
  {
    icon: Building2,
    title: 'Business Knowledge',
    body: 'Every service you offer, price range, and policy — the operating logic of your business.',
    insight: 'Understands your pricing logic',
    x: 50,
    y: 6,
  },
  {
    icon: UserCheck,
    title: 'Customer Memory',
    body: 'Caller history, past jobs, and preferences — recalled the moment the phone rings.',
    insight: 'Remembers returning customers',
    x: 88,
    y: 27,
  },
  {
    icon: Wrench,
    title: 'Service Intelligence',
    body: 'Trade-specific know-how across HVAC, plumbing, electrical, and roofing work.',
    insight: 'Knows your service area',
    x: 88,
    y: 73,
  },
  {
    icon: Siren,
    title: 'Emergency Rules',
    body: 'Exactly what counts as urgent for your business, and the protocol to follow.',
    insight: 'Knows your HVAC emergency rules',
    x: 50,
    y: 94,
  },
  {
    icon: Sparkles,
    title: 'Brand Personality',
    body: "Your tone, your vocabulary, your way of putting a caller at ease — not a generic script.",
    insight: 'Sounds like your business, not a bot',
    x: 12,
    y: 73,
  },
  {
    icon: CalendarClock,
    title: 'Scheduling Preferences',
    body: 'Calendar logic, buffer windows, and crew availability, applied to every booking.',
    insight: 'Books inside your real availability',
    x: 12,
    y: 27,
  },
];

export function AiBusinessMemory() {
  const gradientId = useId();

  return (
    <section id="ai-business-memory" className="relative overflow-hidden py-16 sm:py-24 md:py-32">
      {/* Ambient backdrop */}
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-70"
        style={{
          backgroundImage:
            'radial-gradient(circle at 50% 15%, rgb(var(--accent-secondary) / 0.10), transparent 55%), radial-gradient(circle at 10% 85%, rgb(var(--accent-primary) / 0.07), transparent 45%)',
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
          <p className={eyebrowClass()}>{'AI Business Memory Engine'}</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>
            {'Sarah Doesn\u2019t Just Answer Calls.'}
            <br className="hidden sm:block" />
            {' She Understands Your Business.'}
          </h2>
          <p className={`${bodyClass()} mx-auto max-w-2xl text-sm sm:text-base md:text-lg`}>
            {'Other AI assistants read a script and answer questions. Vireek builds a living model of how your business actually runs \u2014 and checks every call against it, automatically.'}
          </p>
        </motion.div>

        {/* Diagram + cards, desktop */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.6, delay: 0.1, ease: EASE }}
          className="relative mx-auto mt-12 hidden aspect-[10/9] w-full max-w-4xl md:mt-16 md:block"
        >
          {/* Connective tissue */}
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-0 h-full w-full"
          >
            <defs>
              <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="rgb(var(--accent-primary))" stopOpacity="0.55" />
                <stop offset="100%" stopColor="rgb(var(--accent-secondary))" stopOpacity="0.55" />
              </linearGradient>
            </defs>
            {NODES.map((node, i) => (
              <motion.line
                key={node.title}
                x1={50}
                y1={50}
                x2={node.x}
                y2={node.y}
                stroke={`url(#${gradientId})`}
                strokeWidth={0.35}
                strokeLinecap="round"
                initial={{ pathLength: 0, opacity: 0 }}
                whileInView={{ pathLength: 1, opacity: 1 }}
                viewport={viewport}
                transition={{ duration: 0.7, delay: 0.25 + i * 0.08, ease: EASE }}
              />
            ))}
            {/* Traveling data-flow pulses */}
            {NODES.map((node, i) => (
              <motion.circle
                key={`pulse-${node.title}`}
                r={0.9}
                fill="rgb(var(--accent-secondary))"
                initial={{ opacity: 0 }}
                animate={{
                  cx: [50, node.x],
                  cy: [50, node.y],
                  opacity: [0, 0.9, 0],
                }}
                transition={{
                  duration: 2.2,
                  delay: 1.2 + i * 0.35,
                  repeat: Infinity,
                  repeatDelay: NODES.length * 0.35 + 1,
                  ease: 'easeInOut',
                }}
              />
            ))}
          </svg>

          {/* Central hub — Sarah's live business model */}
          <motion.div
            initial={{ opacity: 0, scale: 0.85 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
          >
            <div className="relative flex h-28 w-28 items-center justify-center sm:h-32 sm:w-32">
              <span className="absolute inset-0 animate-[ping_3s_ease-in-out_infinite] rounded-full bg-accent/10" />
              <span className="absolute inset-2 rounded-full border border-accent/20" />
              <span className="absolute inset-0 rounded-full bg-gradient-to-br from-accent/15 via-transparent to-cta/15 blur-md" />
              <div className="relative flex h-20 w-20 items-center justify-center rounded-full border border-accent/30 bg-bg-secondary shadow-glow-accent sm:h-24 sm:w-24">
                <Brain size={30} className="text-accent" strokeWidth={1.75} />
              </div>
            </div>
            <p className="mt-3 text-center text-sm font-semibold text-text-primary">{'Business Memory'}</p>
            <p className="text-center text-xs text-text-secondary">{'Live, per-business model'}</p>
          </motion.div>

          {/* Satellite memory nodes */}
          {NODES.map((node, i) => {
            const Icon = node.icon;
            const alignLeft = node.x < 50;
            const alignCenter = node.x === 50;
            return (
              <motion.div
                key={node.title}
                initial={{ opacity: 0, scale: 0.9 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={viewport}
                transition={{ duration: 0.45, delay: 0.35 + i * 0.08, ease: EASE }}
                className={`group absolute w-56 -translate-x-1/2 ${
                  node.y < 50 ? '-translate-y-full pb-4' : 'pt-4'
                } ${alignCenter ? '' : alignLeft ? 'md:-translate-x-[85%]' : 'md:-translate-x-[15%]'}`}
                style={{ left: `${node.x}%`, top: `${node.y}%` }}
              >
                <div className="rounded-2xl border border-border/80 bg-bg-secondary/90 p-4 shadow-card backdrop-blur-sm transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-card-hover dark:bg-bg-secondary/80 dark:shadow-card-dark dark:hover:shadow-card-hover-dark">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent transition-colors duration-300 group-hover:bg-accent group-hover:text-white">
                      <Icon size={17} />
                    </span>
                    <h3 className="text-sm font-semibold text-text-primary">{node.title}</h3>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-text-secondary">{node.body}</p>
                  <p className="mt-2.5 inline-flex items-center gap-1.5 rounded-full border border-accent/20 bg-accent/5 px-2.5 py-1 text-[11px] font-medium text-accent">
                    {node.insight}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </motion.div>

        {/* Mobile: stacked list */}
        <div className="mt-10 md:hidden">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={viewport}
            transition={{ duration: 0.4, ease: EASE }}
            className="mx-auto mb-6 flex w-fit flex-col items-center"
          >
            <div className="relative flex h-20 w-20 items-center justify-center">
              <span className="absolute inset-0 rounded-full bg-accent/10" />
              <div className="relative flex h-16 w-16 items-center justify-center rounded-full border border-accent/30 bg-bg-secondary shadow-glow-accent">
                <Brain size={26} className="text-accent" strokeWidth={1.75} />
              </div>
            </div>
            <p className="mt-2.5 text-sm font-semibold text-text-primary">{'Business Memory'}</p>
            <p className="text-xs text-text-secondary">{'Live, per-business model'}</p>
          </motion.div>

          <div className="grid gap-3">
            {NODES.map((node, i) => {
              const Icon = node.icon;
              return (
                <motion.div
                  key={node.title}
                  initial={{ opacity: 0, y: 12 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.4, delay: i * 0.06, ease: EASE }}
                  className="rounded-2xl border border-border/80 bg-bg-secondary/90 p-4 shadow-card dark:bg-bg-secondary/80 dark:shadow-card-dark"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                      <Icon size={17} />
                    </span>
                    <h3 className="text-sm font-semibold text-text-primary">{node.title}</h3>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-text-secondary">{node.body}</p>
                  <p className="mt-2.5 inline-flex items-center gap-1.5 rounded-full border border-accent/20 bg-accent/5 px-2.5 py-1 text-[11px] font-medium text-accent">
                    {node.insight}
                  </p>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* Closing statement */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
          className="mx-auto mt-12 max-w-2xl rounded-2xl border border-accent/20 bg-gradient-to-br from-accent/5 via-bg-secondary to-cta/5 p-5 text-center shadow-card dark:shadow-card-dark sm:mt-16 sm:p-6"
        >
          <p className="text-sm font-medium leading-relaxed text-text-primary sm:text-base">
            {'Generic AI assistants answer questions. '}
            <span className="text-accent">{'Vireek builds business intelligence'}</span>
            {' \u2014 one call at a time.'}
          </p>
        </motion.div>
      </div>
    </section>
  );
}
