import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';

const FAQS = [
  {
    q: 'Is Sarah a real person?',
    a: "No — Sarah is an AI receptionist. She sounds natural and understands context, but she's software, not a human. If a caller specifically asks for a human, Sarah lets them know a team member will follow up.",
  },
  {
    q: 'Can Sarah handle emergency calls?',
    a: 'Yes. Sarah detects urgent language — like a burst pipe or no heat in winter — and flags those calls so they can be dispatched immediately instead of sitting in a voicemail box.',
  },
  {
    q: 'What industries does Vireek support?',
    a: 'Sarah is built for HVAC, Plumbing, Roofing, Electrical, and Restoration today, with more trades on the way. She understands the vocabulary and common call types for each.',
  },
  {
    q: 'Do I need to change my phone number?',
    a: 'No. Your calls simply forward to Sarah, so your existing number stays exactly the same for your customers and your marketing.',
  },
  {
    q: 'How fast is setup?',
    a: 'Most businesses are live in about 15 minutes. You forward your line, tell Sarah about your services, and she starts answering.',
  },
  {
    q: 'What happens after hours?',
    a: 'Sarah answers every call 24/7 — including nights, weekends, and holidays — so a missed call never turns into a missed job.',
  },
  {
    q: 'How much does it cost?',
    a: 'Starter is free for 14 days and includes 50 minutes. Professional is $297/month and includes 1,500 minutes. No credit card is required to start the trial.',
  },
];

function FaqItem({
  faq,
  isOpen,
  onToggle,
  index,
}: {
  faq: { q: string; a: string };
  isOpen: boolean;
  onToggle: () => void;
  index: number;
}) {
  const panelId = `faq-panel-${index}`;
  const buttonId = `faq-button-${index}`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewport}
      transition={{ duration: 0.4, ease: EASE, delay: Math.min(index * 0.05, 0.3) }}
      className="overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card transition-colors dark:shadow-card-dark"
    >
      <h3>
        <button
          type="button"
          id={buttonId}
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className="focus-ring flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
        >
          <span className="text-base font-semibold text-text-primary md:text-lg">{faq.q}</span>
          <motion.span
            animate={{ rotate: isOpen ? 180 : 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border ${
              isOpen ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-secondary'
            }`}
          >
            <ChevronDown size={18} />
          </motion.span>
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id={panelId}
            role="region"
            aria-labelledby={buttonId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            <p className="px-6 pb-6 pt-0 text-base leading-relaxed text-text-secondary">{faq.a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section id="faq" className="py-24 md:py-28">
      <div className="mx-auto max-w-3xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="text-center"
        >
          <p className={eyebrowClass()}>FAQ</p>
          <h2 className={sectionHeadingClass()}>Questions? Answered.</h2>
          <p className={`${bodyClass()} mx-auto`}>
            Straight answers about how Sarah works — no fine print, no surprises.
          </p>
        </motion.div>

        <div className="mt-14 flex flex-col gap-4">
          {FAQS.map((faq, index) => (
            <FaqItem
              key={faq.q}
              faq={faq}
              index={index}
              isOpen={openIndex === index}
              onToggle={() => setOpenIndex(openIndex === index ? null : index)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
