import { motion } from 'framer-motion';
import { PhoneCall, Siren, UserPlus, CalendarClock, MessageSquareText, ClipboardList } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

const FEATURES = [
  { icon: PhoneCall, title: 'Answer every caller', outcome: 'Protect demand', body: 'Sarah picks up 24/7 so high-intent prospects reach a real voice instead of voicemail.' },
  { icon: Siren, title: 'Prioritize emergencies', outcome: 'Win urgent jobs', body: 'Urgent language is identified immediately and surfaced for faster dispatch decisions.' },
  { icon: UserPlus, title: 'Capture clean lead data', outcome: 'No messy notes', body: 'Caller name, number, service need, location, and context are collected in a structured format.' },
  { icon: CalendarClock, title: 'Book the next step', outcome: 'Convert in-call', body: 'Sarah can guide callers to an appointment path before interest cools off.' },
  { icon: MessageSquareText, title: 'Confirm with SMS', outcome: 'Reduce no-shows', body: 'Customers receive clear confirmation details while your team receives the operational context.' },
  { icon: ClipboardList, title: 'Summarize every call', outcome: 'Coach and improve', body: 'Every conversation becomes a concise recap for follow-up, CRM updates, and visibility.' },
];

export function Features() {
  return (
    <section id="features" className="py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={viewport} transition={{ duration: 0.5, ease: EASE }} className="max-w-3xl">
          <p className={eyebrowClass()}>Capabilities</p>
          <h2 className={sectionHeadingClass()}>Everything your front desk needs to protect revenue.</h2>
          <p className={bodyClass()}>Vireek turns phone chaos into a repeatable intake system: answer, qualify, prioritize, book, confirm, and summarize.</p>
        </motion.div>

        <motion.div variants={staggerContainer} initial="initial" whileInView="whileInView" viewport={viewport} className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, outcome, body }) => (
            <motion.div key={title} variants={fadeUpItem} transition={{ duration: 0.5, ease: EASE }}>
              <Card className="group h-full p-7">
                <div className="flex items-start justify-between gap-4">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent transition-colors group-hover:bg-accent group-hover:text-white"><Icon size={22} /></span>
                  <span className="rounded-full border border-border bg-bg-tertiary px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-text-secondary">{outcome}</span>
                </div>
                <h3 className="mt-6 text-xl font-semibold text-text-primary md:text-2xl">{title}</h3>
                <p className="mt-3 text-base leading-relaxed text-text-secondary">{body}</p>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
