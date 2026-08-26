import { motion } from 'framer-motion';
import { Phone } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SARAH_PHONE, TRIAL_URL } from '@/lib/site';

const TRUST_ITEMS = [
  '24/7 AI Answering',
  'Emergency Detection',
  'Setup in 15 Min',
  'No Credit Card Required',
];

const fadeUp = {
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
};

function Waveform() {
  const bars = [0.45, 0.8, 1, 0.65, 0.35];
  return (
    <div className="flex items-end justify-center gap-2.5" aria-hidden="true">
      {bars.map((h, i) => (
        <motion.span
          key={i}
          className="w-3 rounded-full bg-accent/80 sm:w-4"
          style={{ height: `${h * 96}px` }}
          animate={{ scaleY: [0.55, 1, 0.7, 0.9, 0.55] }}
          transition={{
            duration: 1.6,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: i * 0.18,
          }}
        />
      ))}
    </div>
  );
}

export function Hero() {
  return (
    <section
      id="top"
      className="relative flex min-h-[90vh] items-center overflow-hidden bg-noise bg-gradient-mesh"
    >
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-bg-primary via-bg-primary to-bg-secondary" />

      <div className="mx-auto w-full max-w-7xl px-6 py-32 text-center">
        <motion.p
          {...fadeUp}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="text-eyebrow font-semibold uppercase text-accent"
        >
          AI Voice Receptionist for Home Services
        </motion.p>

        <motion.h1
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto mt-5 max-w-4xl text-5xl font-bold leading-[1.1] tracking-tight text-text-primary md:text-7xl"
        >
          Never Miss Another Emergency Call
        </motion.h1>

        <motion.p
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-text-secondary md:text-lg"
        >
          Sarah answers your customer calls 24/7, qualifies leads, detects emergencies, and
          books appointments — while you focus on the work, not the phone.
        </motion.p>

        <motion.div
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
          className="mt-10 flex flex-wrap items-center justify-center gap-4"
        >
          <a href={TRIAL_URL} target="_blank" rel="noreferrer">
            <Button variant="primary" size="lg">
              Start Free Trial
            </Button>
          </a>
          <a href={SARAH_PHONE}>
            <Button variant="ghost" size="lg" className="gap-2">
              <Phone size={18} />
              Call Sarah Now
            </Button>
          </a>
        </motion.div>

        <motion.div
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm text-text-secondary"
        >
          {TRUST_ITEMS.map((item, i) => (
            <span key={item} className="flex items-center gap-3">
              {i > 0 && <span className="h-1 w-1 rounded-full bg-text-secondary/40" />}
              {item}
            </span>
          ))}
        </motion.div>

        <motion.div
          {...fadeUp}
          transition={{ duration: 0.6, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className="mt-20"
        >
          <Waveform />
          <p className="mt-6 text-xs font-medium uppercase tracking-[0.18em] text-text-secondary/70">
            Now onboarding the first contractors on Vireek.
          </p>
        </motion.div>
      </div>
    </section>
  );
}
