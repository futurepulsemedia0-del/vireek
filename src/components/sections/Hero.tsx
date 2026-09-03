import { motion } from 'framer-motion';
import { Phone, Star, Zap, Clock, ShieldCheck, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { SARAH_PHONE } from '@/lib/site';

const TRUST_ITEMS = [
  { icon: Clock, label: '24/7 AI Answering' },
  { icon: Zap, label: 'Emergency Detection' },
  { icon: ShieldCheck, label: 'Setup in 15 Min' },
  { icon: Star, label: 'No Credit Card Required' },
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
            duration: 1.6 + i * 0.11,
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

      <div className="mx-auto w-full max-w-7xl px-6 py-36 text-center md:py-44">
        {/* Social proof badge */}
        <motion.div
          {...fadeUp}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto mb-6 flex w-fit items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-2"
        >
          <div className="flex -space-x-2">
            {['J', 'M', 'S', 'R'].map((initial, i) => (
              <span
                key={i}
                className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-bg-primary bg-accent/20 text-xs font-bold text-accent"
              >
                {initial}
              </span>
            ))}
          </div>
          <span className="text-sm font-medium text-text-secondary">
            Now onboarding early contractors
          </span>
        </motion.div>

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
          className="mx-auto mt-5 max-w-5xl text-6xl font-bold leading-[1.02] tracking-tight text-text-primary md:text-8xl"
        >
          Never Miss Another Emergency Call
        </motion.h1>

        <motion.p
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto mt-7 max-w-xl text-base leading-relaxed text-text-secondary md:text-lg"
        >
          Sarah answers calls 24/7, detects emergencies, and books appointments — so you
          focus on the job, not the phone.
        </motion.p>

        <motion.div
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
          className="mt-10 flex flex-wrap items-center justify-center gap-4"
        >
          <Link to="/login">
            <Button variant="primary" size="lg" className="gap-2">
              Start Free Trial
              <ArrowRight size={18} />
            </Button>
          </Link>
          <a href={SARAH_PHONE}>
            <Button variant="ghost" size="lg" className="gap-2">
              <Phone size={18} />
              Call Sarah Now
            </Button>
          </a>
        </motion.div>

        <motion.p
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.18, ease: [0.16, 1, 0.3, 1] }}
          className="mt-4 text-sm font-medium text-text-secondary/80"
        >
          14-day free trial · No credit card required · Cancel anytime
        </motion.p>

        <motion.div
          {...fadeUp}
          transition={{ duration: 0.5, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm text-text-secondary"
        >
          {TRUST_ITEMS.map((item) => (
            <span key={item.label} className="flex items-center gap-2">
              <item.icon size={16} className="text-accent" />
              {item.label}
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
