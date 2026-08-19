import { motion } from 'framer-motion';
import { Card } from '@/components/ui/Card';

const STATS = [
  {
    value: '85%',
    title: 'The Voicemail Graveyard',
    body: 'Callers who don\'t reach a business rarely call back — they call the next contractor.',
  },
  {
    value: '$1,200',
    title: 'The Emergency Escape',
    body: 'Average value of a single missed emergency job.',
  },
  {
    value: '$36K',
    title: 'The Receptionist Trap',
    body: 'Average annual cost of a human receptionist, who still can\'t work nights or weekends.',
  },
];

const container = {
  initial: {},
  whileInView: { transition: { staggerChildren: 0.12 } },
  viewport: { once: true, margin: '-80px' },
};

const item = {
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] },
};

export function Problem() {
  return (
    <section id="problem" className="py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="max-w-3xl"
        >
          <p className="text-eyebrow font-semibold uppercase text-accent">The problem</p>
          <h2 className="mt-3 text-3xl font-bold leading-[1.2] tracking-tight text-text-primary md:text-5xl">
            Every Missed Call is a Job for Your Competitor
          </h2>
          <p className="mt-5 text-base leading-relaxed text-text-secondary md:text-lg">
            Home service companies lose 35–50% of inbound calls to voicemail.
          </p>
        </motion.div>

        <motion.div
          {...container}
          className="mt-14 grid gap-6 md:grid-cols-3"
        >
          {STATS.map((stat) => (
            <motion.div key={stat.title} {...item}>
              <Card>
                <p className="text-4xl font-bold tracking-tight text-danger md:text-5xl">
                  {stat.value}
                </p>
                <h3 className="mt-5 text-xl font-semibold text-text-primary md:text-2xl">
                  {stat.title}
                </h3>
                <p className="mt-3 text-base leading-relaxed text-text-secondary">
                  {stat.body}
                </p>
              </Card>
            </motion.div>
          ))}
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="mt-8 text-sm text-text-secondary/70"
        >
          Industry-level figures, not claims about Vireek&apos;s own customers.
        </motion.p>
      </div>
    </section>
  );
}
