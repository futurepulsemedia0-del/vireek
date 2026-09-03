import { motion } from 'framer-motion';
import { ArrowRight, ShieldCheck, Clock, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EASE, viewport } from '@/lib/motion';

const GUARANTEES = [
  { icon: Clock, label: 'Live in 15 minutes' },
  { icon: ShieldCheck, label: 'No credit card required' },
  { icon: Zap, label: 'Cancel anytime' },
];

export function FinalCTA() {
  return (
    <section id="contact" className="px-6 py-16 md:py-24">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={viewport}
        transition={{ duration: 0.6, ease: EASE }}
        className="bg-noise relative mx-auto flex max-w-6xl flex-col items-center overflow-hidden rounded-3xl bg-gradient-to-br from-accent-800 via-accent-700 to-cta-800 px-6 py-16 text-center shadow-glow-accent md:px-16 md:py-24"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.14), transparent 45%), radial-gradient(circle at 85% 80%, rgb(var(--accent-secondary) / 0.20), transparent 45%)',
          }}
        />
        {/* Top highlight line */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />

        <div className="relative">
          <h2 className="text-3xl font-bold leading-[1.12] tracking-tight text-white text-balance md:text-5xl">
            Stop Losing Jobs to Voicemail
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
            Every call Sarah answers is a customer who reached a real voice instead of a beep.
            Start free today and hear how she handles your calls — no credit card, no contract, no risk.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to="/login">
              <Button
                variant="primary"
                size="lg"
                className="gap-2 shadow-glow-cta"
              >
                Start Free Trial
                <ArrowRight size={18} />
              </Button>
            </Link>
            <Link to="/demo">
              <Button
                variant="ghost"
                size="lg"
                className="gap-2 border-white/20 bg-white/10 text-white hover:bg-white/20 hover:text-white"
              >
                Try the Live Demo
                <ArrowRight size={18} />
              </Button>
            </Link>
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
            {GUARANTEES.map(({ icon: Icon, label }) => (
              <span key={label} className="flex items-center gap-1.5 text-xs font-medium text-white/70">
                <Icon size={14} className="shrink-0" />
                {label}
              </span>
            ))}
          </div>
        </div>
      </motion.div>
    </section>
  );
}
