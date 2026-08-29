import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EASE, viewport } from '@/lib/motion';

export function FinalCTA() {
  return (
    <section className="px-6 py-16 md:py-20">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={viewport}
        transition={{ duration: 0.5, ease: EASE }}
        className="bg-noise relative mx-auto flex max-w-6xl flex-col items-center overflow-hidden rounded-3xl bg-gradient-to-br from-accent-800 via-accent-700 to-cta-800 px-6 py-16 text-center shadow-glow-accent md:px-16 md:py-20"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.14), transparent 45%), radial-gradient(circle at 85% 80%, rgb(var(--accent-secondary) / 0.20), transparent 45%)',
          }}
        />
        <div className="relative">
          <h2 className="text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
            Put an AI receptionist on your business line today.
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
            Start with a free trial, call Sarah yourself, and see how Vireek captures callers your team would otherwise miss.
          </p>
          <div className="mt-9 flex justify-center">
            <Link to="/login">
              <Button variant="primary" size="lg" className="shadow-glow-cta">
                Start free trial
                <ArrowRight size={18} />
              </Button>
            </Link>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
