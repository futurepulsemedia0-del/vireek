import { motion } from 'framer-motion';
import { Phone } from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';
import { SARAH_PHONE } from '@/lib/site';

const PHONE_DISPLAY = '+1 (650) 910-6703';

const MESSAGES = [
  {
    from: 'customer',
    text: 'My water heater is leaking and there\u2019s water everywhere.',
  },
  {
    from: 'sarah',
    text: 'That sounds urgent. I\u2019m flagging this as an emergency. What\u2019s your address so I can get someone out immediately?',
  },
];

export function LiveDemo() {
  return (
    <section id="demo" className="py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <p className={eyebrowClass()}>Live demo</p>
          <h2 className={sectionHeadingClass()}>Talk to Sarah Right Now</h2>
        </motion.div>

        <div className="mt-14 grid gap-6 lg:grid-cols-2">
          <motion.a
            href={SARAH_PHONE}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="focus-ring group flex flex-col items-start justify-center rounded-2xl border border-border bg-bg-secondary p-8 shadow-card transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-glow-accent dark:shadow-card-dark"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent transition-colors group-hover:bg-accent group-hover:text-white">
              <Phone size={24} />
            </span>
            <span className="mt-6 text-sm font-medium uppercase tracking-[0.18em] text-text-secondary">
              Call Sarah
            </span>
            <span className="mt-2 text-3xl font-bold tracking-tight text-text-primary md:text-4xl">
              {PHONE_DISPLAY}
            </span>
            <span className="mt-3 text-base text-text-secondary">
              Tap to call from your phone. She answers in seconds.
            </span>
          </motion.a>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
            className="rounded-2xl border border-border bg-bg-tertiary p-6 md:p-8"
          >
            <p className="mb-5 text-sm font-semibold uppercase tracking-[0.18em] text-text-secondary">
              Sample conversation
            </p>
            <div className="flex flex-col gap-4">
              {MESSAGES.map((msg, i) => {
                const isSarah = msg.from === 'sarah';
                return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 12 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={viewport}
                    transition={{ duration: 0.45, delay: 0.2 + i * 0.5, ease: EASE }}
                    className={`flex items-end gap-3 ${isSarah ? 'flex-row' : 'flex-row-reverse'}`}
                  >
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                        isSarah
                          ? 'bg-accent text-white'
                          : 'bg-bg-secondary text-text-secondary border border-border'
                      }`}
                    >
                      {isSarah ? 'S' : 'C'}
                    </span>
                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-3 text-base leading-relaxed ${
                        isSarah
                          ? 'bg-bg-secondary text-text-primary shadow-card dark:shadow-card-dark'
                          : 'bg-accent/10 text-text-primary'
                      }`}
                    >
                      {msg.text}
                    </div>
                  </motion.div>
                );
              })}
            </div>
            <motion.p
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={viewport}
              transition={{ duration: 0.5, delay: 1.2 }}
              className="mt-6 text-sm text-text-secondary"
            >
              Sarah understands context, urgency, and trade-specific terminology — not just keywords.
            </motion.p>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
