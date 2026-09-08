import { motion } from 'framer-motion';
import { CalendarCheck, ClipboardCheck, PhoneCall, ArrowRight } from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

const STEPS = [
  {
    num: '01',
    icon: PhoneCall,
    title: 'Answer',
    body: 'Sarah picks up on the first ring and greets the caller in a natural, conversational voice — every time, day or night.',
    tag: '0.4s to pickup',
  },
  {
    num: '02',
    icon: ClipboardCheck,
    title: 'Qualify',
    body: 'She asks the right questions, spots emergencies, and separates urgent jobs from tire-kickers before you ever see the call.',
    tag: 'Burst pipe → priority',
  },
  {
    num: '03',
    icon: CalendarCheck,
    title: 'Book',
    body: 'Sarah checks your real calendar, confirms a slot out loud, and writes the job straight into your CRM.',
    tag: 'Synced in 42s',
  },
];

/**
 * Rebuilt away from the "three icon circles in a row" pattern — instead each
 * step is a full row that reads left-to-right like a single continuous
 * pipeline, with the number set large and typographic (the actual content,
 * not a decoration) so the section carries weight without extra ornament.
 */
export function HowItWorks() {
  return (
    <section id="how-it-works" className="py-16 sm:py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <p className={eyebrowClass()}>{'How it works'}</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>{'From ring to booked in 60 seconds'}</h2>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-10 divide-y divide-border/70 border-t border-border/70 sm:mt-16"
        >
          {STEPS.map(({ num, icon: Icon, title, body, tag }, i) => (
            <motion.div
              key={num}
              variants={fadeUpItem}
              transition={{ duration: 0.5, ease: EASE }}
              className="group grid grid-cols-1 items-center gap-4 py-7 sm:grid-cols-[auto_1fr_auto] sm:gap-8 sm:py-9 md:gap-12"
            >
              <div className="flex items-center gap-4 sm:gap-5">
                <span className="font-display text-4xl font-semibold tabular-nums text-border transition-colors duration-300 group-hover:text-accent/30 sm:text-5xl">
                  {num}
                </span>
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent sm:h-12 sm:w-12">
                  <Icon size={20} />
                </span>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-text-primary sm:text-2xl">{title}</h3>
                <p className="mt-1.5 max-w-lg text-sm leading-relaxed text-text-secondary sm:text-base">{body}</p>
              </div>

              <div className="flex items-center gap-2 sm:justify-self-end">
                <span className="inline-flex items-center rounded-full border border-border bg-bg-tertiary px-3 py-1 text-xs font-medium text-text-secondary">
                  {tag}
                </span>
                {i < STEPS.length - 1 && (
                  <ArrowRight size={16} className="hidden shrink-0 text-border sm:block" aria-hidden="true" />
                )}
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
