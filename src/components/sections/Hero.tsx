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
    <div className="flex items-end gap-2.5" aria-hidden="true">
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

      <div className="mx-auto grid w-full max-w-7xl items-center gap-14 px-6 py-28 md:grid-cols-2 md:py-36">


        {/* LEFT CONTENT */}

        <div>

          <motion.div
            {...fadeUp}
            transition={{ duration: 0.4 }}
            className="mb-6 flex w-fit items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-2"
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
            transition={{ duration: 0.5 }}
            className="text-eyebrow font-semibold uppercase text-accent"
          >
            AI Voice Receptionist for Home Services
          </motion.p>


          <motion.h1
            {...fadeUp}
            transition={{ duration: 0.5, delay: 0.05 }}
            className="mt-5 max-w-3xl text-6xl font-bold leading-[1.02] tracking-tight text-text-primary md:text-7xl"
          >
            Never Miss Another Emergency Call
          </motion.h1>


          <motion.p
            {...fadeUp}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="mt-7 max-w-xl text-base leading-relaxed text-text-secondary md:text-lg"
          >
            Sarah answers calls 24/7, detects emergencies, and books appointments —
            so you focus on the job, not the phone.
          </motion.p>


          <motion.div
            {...fadeUp}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="mt-10 flex flex-wrap items-center gap-4"
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
            transition={{ duration: 0.5, delay: 0.18 }}
            className="mt-4 text-sm font-medium text-text-secondary/80"
          >
            14-day free trial · No credit card required · Cancel anytime
          </motion.p>


          <motion.div
            {...fadeUp}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-text-secondary"
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
            transition={{ duration: 0.6, delay: 0.25 }}
            className="mt-14"
          >
            <Waveform />

            <p className="mt-5 text-xs font-medium uppercase tracking-[0.18em] text-text-secondary/70">
              Now onboarding the first contractors on Vireek.
            </p>

          </motion.div>

        </div>



        {/* PREMIUM AI HERO VISUAL */}

<motion.div
  {...fadeUp}
  transition={{ duration: 0.8, delay: 0.15 }}
  className="relative flex justify-center"
>

  {/* Premium ambient AI glow */}
  <div
    className="
      absolute
      inset-0
      -z-10
      scale-90
      rounded-full
      bg-accent/25
      blur-[120px]
    "
  />


  <motion.div
    animate={{
      y: [0, -12, 0],
    }}
    transition={{
      duration: 6,
      repeat: Infinity,
      ease: 'easeInOut',
    }}
    className="
      relative
      w-full
      max-w-[650px]
    "
  >

    {/* Corner light effect */}
    <div
      className="
        absolute
        -right-10
        -top-10
        h-48
        w-48
        rounded-full
        bg-accent/20
        blur-3xl
      "
    />


    <div
      className="
        absolute
        -bottom-10
        -left-10
        h-56
        w-56
        rounded-full
        bg-accent/10
        blur-3xl
      "
    />


    {/* Image */}
    <img
      src="/vireek-hero-ai.png"
      alt="Vireek AI Voice Receptionist"
      className="
        relative
        z-10
        w-full
        rounded-[48px]
        object-contain
        drop-shadow-[0_35px_70px_rgba(0,0,0,0.30)]
      "
    />


    {/* Soft edge blending */}
    <div
      className="
        pointer-events-none
        absolute
        inset-0
        z-20
        rounded-[48px]
        bg-gradient-to-tr
        from-accent/10
        via-transparent
        to-transparent
      "
    />

  </motion.div>

</motion.div>
