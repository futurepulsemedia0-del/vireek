import { motion } from 'framer-motion';
import { ArrowRight, PhoneMissed, TrendingDown, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

/**
 * "Why Now" makes the urgency case for an AI receptionist without
 * re-running the SocialProof stats block (removed from the homepage —
 * see HomePage.tsx). It reuses the same three sourced numbers used
 * elsewhere on the site (SocialProof.tsx, MissedCallCalculator.tsx) so
 * nothing here can drift out of sync with or contradict them, and it
 * points to the two pages built specifically to go deeper honestly:
 * /report (State of Home Service Calls — methodology-first, no invented
 * stats) and /roi (real, named customer numbers). This is the one spot
 * that carries Vireek's recurring visual motif — a missed call turning
 * into lost revenue — echoed again in the Hero's live transcript and the
 * Manifesto's first tenet ("A ringing phone is a decision, not a task.").
 */
const REASONS = [
  {
    icon: PhoneMissed,
    stat: '60–80%',
    label: 'of calls to home service businesses go unanswered industry-wide',
  },
  {
    icon: TrendingDown,
    stat: '62%',
    label: "of callers who don't get through call a competitor instead",
  },
  {
    icon: Sparkles,
    stat: '15 min',
    label: 'to get an AI receptionist live — vs. weeks to hire and train a person',
  },
];

export function WhyNow() {
  return (
    <section className="border-y border-border/60 bg-bg-secondary/40 px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-2xl text-center"
        >
          <p className={`${eyebrowClass()} text-center`}>Why Now</p>
          <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl md:text-5xl`}>
            The phone stopped being optional a while ago
          </h2>
          <p className={`${bodyClass()} mx-auto text-center`}>
            Customers already expect a business to answer instantly, at any hour. The gap
            between that expectation and what a small team can staff is exactly what an AI
            receptionist closes — not someday, but on the very next call.
          </p>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-14 grid gap-6 sm:grid-cols-3"
        >
          {REASONS.map(({ icon: Icon, stat, label }) => (
            <motion.div
              key={label}
              variants={fadeUpItem}
              transition={{ duration: 0.4, ease: EASE }}
              className="rounded-2xl border border-border bg-bg-primary p-6 text-center shadow-card dark:shadow-card-dark"
            >
              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                <Icon size={20} />
              </span>
              <p className="mt-4 font-display text-3xl font-bold tracking-tight text-text-primary">{stat}</p>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">{label}</p>
            </motion.div>
          ))}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
          className="mt-10 flex flex-col items-center justify-center gap-3 text-center sm:flex-row sm:gap-6"
        >
          <Link
            to="/report"
            className="focus-ring inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
          >
            See the full State of Home Service Calls report
            <ArrowRight size={14} />
          </Link>
          <span className="hidden h-1 w-1 rounded-full bg-border sm:block" aria-hidden="true" />
          <Link
            to="/roi"
            className="focus-ring inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
          >
            See real customer ROI numbers
            <ArrowRight size={14} />
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
