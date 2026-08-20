import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/Card';
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

export function SocialProof() {
  return (
    <section className="py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-6">
        {/* Built on Industry Data */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <h3 className={sectionHeadingClass()}>Built on Industry Data</h3>
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
                <p className="text-4xl font-bold tracking-tight text-accent md:text-5xl">{value}</p>
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

        {/* Founding Contractors */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mt-20"
        >
          <div className="relative overflow-hidden rounded-2xl border border-accent/30 bg-bg-secondary p-10 shadow-card dark:shadow-card-dark md:p-14">
            <div className="absolute inset-0 -z-10 bg-gradient-to-br from-accent/[0.06] via-transparent to-cta/[0.05]" />
            <span className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-4 py-1.5 text-eyebrow font-semibold uppercase text-accent">
              <Sparkles size={14} />
              Now in Early Access
            </span>
            <h3 className="mt-6 max-w-3xl text-3xl font-bold leading-[1.15] tracking-tight text-text-primary md:text-4xl text-balance">
              Be one of the first contractors on Vireek
            </h3>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-text-secondary md:text-lg">
              Vireek is new. Early contractors get hands-on setup help and direct input on what we
              build next.
            </p>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
