import { motion } from 'framer-motion';
import { AlertTriangle, CalendarCheck, PhoneCall } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EASE, eyebrowClass, sectionHeadingClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

const SOLUTIONS = [
  {
    icon: PhoneCall,
    badge: 'blue',
    title: 'Answers Every Call Instantly',
    body: 'No rings, no hold music, no voicemail. Sarah picks up on the first second and starts a real conversation.',
  },
  {
    icon: AlertTriangle,
    badge: 'orange',
    title: 'Detects Real Emergencies',
    body: 'A burst pipe at 2am gets flagged and dispatched, not queued behind a routine tune-up request.',
  },
  {
    icon: CalendarCheck,
    badge: 'blue',
    title: 'Books While You Work',
    body: 'Sarah checks your calendar, proposes a slot, and confirms the appointment before the caller hangs up.',
  },
];

export function Solution() {
  return (
    <section id="solution" className="py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <p className={eyebrowClass()}>The solution</p>
          <h2 className={sectionHeadingClass()}>Vireek Turns Chaos Into Calendar</h2>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-14 grid gap-6 md:grid-cols-3"
        >
          {SOLUTIONS.map(({ icon: Icon, badge, title, body }) => (
            <motion.div key={title} variants={fadeUpItem} transition={{ duration: 0.5, ease: EASE }}>
              <Card className="h-full">
                <span
                  className={`flex h-12 w-12 items-center justify-center rounded-xl ${
                    badge === 'blue'
                      ? 'bg-accent/10 text-accent'
                      : 'bg-cta/10 text-cta'
                  }`}
                >
                  <Icon size={22} />
                </span>
                <h3 className="mt-5 text-xl font-semibold text-text-primary md:text-2xl">{title}</h3>
                <p className="mt-3 text-base leading-relaxed text-text-secondary">{body}</p>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
