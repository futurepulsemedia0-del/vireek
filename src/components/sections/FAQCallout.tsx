import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ArrowRight, HelpCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EASE, sectionHeadingClass, viewport } from '@/lib/motion';

interface FAQ {
  question: string;
  answer: string;
}

const FAQS: FAQ[] = [
  {
    question: 'Does Vireek replace receptionists?',
    answer: 'Sarah handles every call your receptionist would — answering, qualifying, booking, and logging — at a fraction of the cost. Many contractors use Vireek alongside a human receptionist for after-hours coverage. Others replace the role entirely. It\'s your choice.',
  },
  {
    question: 'How quickly can I start?',
    answer: 'Most contractors are live within 15 minutes. Create an account, add your business name and calendar, and Sarah starts answering immediately. No technical setup required.',
  },
  {
    question: 'Can Sarah detect emergencies?',
    answer: 'Yes. Sarah is trained to recognize urgency from language and context — a gas leak, a burst pipe, a sparking outlet. She flags emergencies for immediate dispatch and moves them to the top of your queue automatically.',
  },
  {
    question: 'Does it work with my CRM?',
    answer: 'Sarah syncs directly to Google Calendar, HubSpot, Salesforce, ServiceTitan, Housecall Pro, Jobber, and any system that accepts webhooks or Zapier triggers. New integrations are added regularly.',
  },
  {
    question: 'Can I customize the AI?',
    answer: 'Absolutely. You control how Sarah greets callers, what questions she asks, which services you offer, your service area, your hours, and your booking rules. Everything is editable from your dashboard.',
  },
  {
    question: 'What happens after hours?',
    answer: 'Sarah answers 24/7 — nights, weekends, holidays. She books appointments for the next available slot, flags emergencies for immediate attention, and sends you a summary of every call by morning.',
  },
];

function FAQItem({ faq, index }: { faq: FAQ; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.4, delay: index * 0.05, ease: EASE }}
      className="overflow-hidden rounded-xl border border-border bg-bg-secondary"
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="focus-ring flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <span className="text-sm font-semibold text-text-primary sm:text-base">{faq.question}</span>
        <ChevronDown
          size={18}
          className={`shrink-0 text-text-secondary transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
          >
            <p className="px-5 pb-4 text-sm leading-relaxed text-text-secondary">{faq.answer}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function FAQCallout() {
  return (
    <section className="py-24 md:py-28">
      <div className="mx-auto max-w-3xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="text-center"
        >
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <HelpCircle size={26} />
          </span>
          <h2 className={`${sectionHeadingClass()} mt-6`}>
            Frequently Asked Questions
          </h2>
          <p className="mt-5 text-base leading-relaxed text-text-secondary">
            Everything you need to know about Sarah, setup, pricing, and what to expect.
          </p>
        </motion.div>

        <div className="mt-12 space-y-3">
          {FAQS.map((faq, i) => (
            <FAQItem key={faq.question} faq={faq} index={i} />
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
          className="mt-10 flex flex-col items-center gap-4 rounded-2xl border border-border bg-bg-tertiary/50 p-8 text-center sm:flex-row sm:justify-between sm:text-left"
        >
          <div>
            <p className="text-sm font-semibold text-text-primary">Still have questions?</p>
            <p className="mt-1 text-sm text-text-secondary">We&apos;re here to help — reach out anytime.</p>
          </div>
          <Link to="/faq">
            <Button variant="secondary" size="md" className="gap-2">
              Visit Full FAQ
              <ArrowRight size={16} />
            </Button>
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
