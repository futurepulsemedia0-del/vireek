import { motion } from 'framer-motion';
import { ArrowRight, Sparkles, Quote, Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { CountUp } from '@/components/ui/CountUp';
import { EASE, sectionHeadingClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

const STATS = [
  {
    value: '60\u201380%',
    label: 'of calls to home service businesses go unanswered industry-wide',
  },
  {
    value: '62%',
    label: "of callers who don't get through call a competitor instead",
  },
  {
    value: '$1,200+',
    label: 'average value of a single missed emergency job',
  },
];

interface Testimonial {
  quote: string;
  name: string;
  role: string;
  initials: string;
  result: string;
}

const TESTIMONIALS: Testimonial[] = [
  {
    quote: "Sarah caught a burst pipe call at 1am that would have gone to voicemail. The customer was booked and dispatched before I even woke up.",
    name: "Marcus R.",
    role: "Ramirez Plumbing",
    initials: "MR",
    result: "Saved a $2,800 emergency job",
  },
  {
    quote: "I was on a roof all day and missed 9 calls. Sarah booked 6 of them. That's a week of work I would have lost.",
    name: "Jenna T.",
    role: "Apex Heating & Air",
    initials: "JT",
    result: "6 jobs booked while on-site",
  },
  {
    quote: "Setup took 15 minutes. By the end of the first day, Sarah had answered 11 calls and booked 4 appointments. I was skeptical — not anymore.",
    name: "Steve K.",
    role: "Volt Electric",
    initials: "SK",
    result: "4 appointments on day one",
  },
];

export function SocialProof() {
  return (
    <section className="py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-6">
        {/* Stats */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <h3 className={sectionHeadingClass()}>The Numbers Don&apos;t Lie</h3>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-12 grid gap-6 md:grid-cols-3"
        >
          {STATS.map(({ value, label }) => (
            <motion.div key={value} variants={fadeUpItem} transition={{ duration: 0.5, ease: EASE }}>
              <Card className="h-full">
                <CountUp
                  value={value}
                  className="block text-4xl font-bold tracking-tight text-accent md:text-5xl"
                />
                <p className="mt-4 text-base leading-relaxed text-text-secondary">{label}</p>
              </Card>
            </motion.div>
          ))}
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mt-6 text-sm text-text-secondary/70"
        >
          Source: industry research on home services call handling, 2026.
        </motion.p>

        {/* Testimonials */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mt-20"
        >
          <h3 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
            What Contractors Are Saying
          </h3>
          <p className="mt-3 text-base text-text-secondary">
            Illustrative examples of the kind of experience Sarah is designed to deliver.
          </p>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-10 grid gap-5 md:grid-cols-3"
        >
          {TESTIMONIALS.map((t) => (
            <motion.div
              key={t.name}
              variants={fadeUpItem}
              transition={{ duration: 0.5, ease: EASE }}
              className="flex h-full flex-col rounded-2xl border border-border bg-bg-secondary p-6 shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:border-accent/25 dark:shadow-card-dark"
            >
              <Quote size={24} className="text-accent/30" />
              <p className="mt-3 flex-1 text-sm leading-relaxed text-text-primary">
                &ldquo;{t.quote}&rdquo;
              </p>
              <div className="mt-5 flex items-center gap-3 border-t border-border/60 pt-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-bold text-accent">
                  {t.initials}
                </span>
                <div>
                  <p className="text-sm font-semibold text-text-primary">{t.name}</p>
                  <p className="text-xs text-text-secondary">{t.role}</p>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-success/10 px-3 py-2">
                <Star size={14} className="fill-success text-success" />
                <span className="text-xs font-semibold text-success">{t.result}</span>
              </div>
            </motion.div>
          ))}
        </motion.div>

        {/* Link to the full testimonials page */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mt-8 flex justify-center"
        >
          <Link
            to="/testimonials"
            className="focus-ring inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold text-accent transition-colors hover:text-accent/80"
          >
            Read more contractor stories <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </motion.div>

        {/* Founding Contractors CTA */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mt-16"
        >
          <div className="relative overflow-hidden rounded-2xl border border-accent/30 bg-bg-secondary p-10 shadow-card dark:shadow-card-dark md:p-14">
            <div className="absolute inset-0 -z-10 bg-gradient-to-br from-accent/[0.06] via-transparent to-cta/[0.06]" />
            <span className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-4 py-1.5 text-eyebrow font-semibold uppercase text-accent">
              <Sparkles size={14} />
              Now in Early Access
            </span>
            <h3 className="mt-6 max-w-3xl text-3xl font-bold leading-[1.15] tracking-tight text-text-primary md:text-4xl text-balance">
              Be one of the first contractors on Vireek
            </h3>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-text-secondary md:text-lg">
              Early contractors get hands-on setup help, direct input on what we build next, and
              pricing locked in for life.
            </p>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
