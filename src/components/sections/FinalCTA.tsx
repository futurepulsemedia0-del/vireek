import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EASE, viewport } from '@/lib/motion';
import { TRIAL_URL } from '@/lib/site';

export function FinalCTA() {
  return (
    <section className="px-6 py-16 md:py-20">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={viewport}
        transition={{ duration: 0.5, ease: EASE }}
        className="bg-noise relative mx-auto flex max-w-6xl flex-col items-center overflow-hidden rounded-3xl bg-gradient-to-br from-accent-700 via-accent-600 to-accent-800 px-6 py-16 text-center shadow-glow-accent md:px-16 md:py-20"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.14), transparent 45%), radial-gradient(circle at 85% 80%, rgba(249,115,22,0.22), transparent 45%)',
          }}
        />
        <div className="relative">
          <h2 className="text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
            Stop Losing Jobs to Voicemail
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
            Every call Sarah answers is a customer who reached a real voice instead of a beep. Start
            free and hear how she handles your calls.
          </p>
          <div className="mt-9 flex justify-center">
            <a href={TRIAL_URL} target="_blank" rel="noopener noreferrer">
              <Button variant="primary" size="lg" className="shadow-glow-cta">
                Start Free Trial
                <ArrowRight size={18} />
              </Button>
            </a>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
