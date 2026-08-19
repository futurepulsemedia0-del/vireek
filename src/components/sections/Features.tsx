import { motion } from 'framer-motion';
import { PhoneCall, Siren, UserPlus, CalendarClock, MessageSquareText, ClipboardList } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EASE, eyebrowClass, sectionHeadingClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

const FEATURES = [
  {
    icon: PhoneCall,
    badge: 'blue',
    title: '24/7 AI Answering',
    body: 'Sarah picks up every call, day or night, so no lead ever hits voicemail.',
  },
  {
    icon: Siren,
    badge: 'orange',
    title: 'Emergency Detection',
    body: 'Urgent jobs get flagged and dispatched instantly instead of waiting in a queue.',
  },
  {
    icon: UserPlus,
    badge: 'blue',
    title: 'Customer Capture',
    body: 'Every caller\u2019s name, number, and issue is logged the moment they reach out.',
  },
  {
    icon: CalendarClock,
    badge: 'blue',
    title: 'Smart Booking',
    body: 'Sarah checks your calendar and books the appointment before the caller hangs up.',
  },
  {
    icon: MessageSquareText,
    badge: 'orange',
    title: 'SMS Confirmations',
    body: 'Customers get an instant text confirming the time, address, and details.',
  },
  {
    icon: ClipboardList,
    badge: 'blue',
    title: 'Call Summaries',
    body: 'A clean recap of every conversation lands in your inbox and CRM automatically.',
  },
];

export function Features() {
  return (
    <section id="features" className="py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <p className={eyebrowClass()}>Features</p>
          <h2 className={sectionHeadingClass()}>{"What Sarah Handles So You Don't Have To"}</h2>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
        >
          {FEATURES.map(({ icon: Icon, badge, title, body }) => (
            <motion.div key={title} variants={fadeUpItem} transition={{ duration: 0.5, ease: EASE }}>
              <Card className="h-full">
                <span
                  className={`flex h-12 w-12 items-center justify-center rounded-xl ${
                    badge === 'blue' ? 'bg-accent/10 text-accent' : 'bg-cta/10 text-cta'
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
