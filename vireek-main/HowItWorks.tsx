import { motion } from 'framer-motion';
import { CalendarCheck, ClipboardCheck, PhoneCall } from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

const STEPS = [
  {
    num: '01',
    icon: PhoneCall,
    title: 'Answer',
    body: 'Sarah picks up on the first ring and greets the caller in a natural, conversational voice.',
  },
  {
    num: '02',
    icon: ClipboardCheck,
    title: 'Qualify',
    body: 'She asks the right questions, spots emergencies, and separates urgent jobs from tire-kickers.',
  },
  {
    num: '03',
    icon: CalendarCheck,
    title: 'Book',
    body: 'Sarah checks your calendar, confirms a slot, and writes the job straight into your CRM.',
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <p className={eyebrowClass()}>How it works</p>
          <h2 className={sectionHeadingClass()}>From Ring to Booked in 60 Seconds</h2>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="relative mt-16 grid gap-12 md:grid-cols-3 md:gap-8"
        >
          <div
            className="absolute left-0 right-0 top-7 hidden h-px md:block"
            style={{
              background:
                'linear-gradient(to right, transparent, rgb(var(--accent-primary) / 0.4), transparent)',
            }}
            aria-hidden="true"
          />
          {STEPS.map(({ num, icon: Icon, title, body }) => (
            <motion.div
              key={num}
              variants={fadeUpItem}
              transition={{ duration: 0.5, ease: EASE }}
              className="relative flex flex-col items-center text-center"
            >
              <div className="relative z-10 flex h-14 w-14 items-center justify-center rounded-full border border-border bg-bg-secondary shadow-card">
                <Icon size={22} className="text-accent" />
              </div>
              <span className="mt-5 text-sm font-semibold uppercase tracking-[0.18em] text-accent">
                {num}
              </span>
              <h3 className="mt-2 text-xl font-semibold text-text-primary md:text-2xl">{title}</h3>
              <p className="mt-3 max-w-xs text-base leading-relaxed text-text-secondary">{body}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
