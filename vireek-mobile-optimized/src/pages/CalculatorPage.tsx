import { motion } from 'framer-motion';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { MissedCallCalculator } from '@/components/sections/MissedCallCalculator';
import { EASE, eyebrowClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

export function CalculatorPage() {
  useSEO({
    title: 'Missed Call Revenue Calculator | Vireek',
    description:
      'See how much revenue your home service business loses to missed calls every year — and how much Vireek could recover. Drag the sliders to match your business.',
    canonical: 'https://vireek.com/calculator',
  });

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-16 sm:py-20">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <BackButton />
            </div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>Revenue Calculator</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                How much are missed calls costing you?
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary">
                Every missed call is a job that goes to a competitor. Plug in your numbers below
                to see exactly what it's costing you every year — and what Vireek could recover.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Calculator */}
        <MissedCallCalculator />

        {/* Final CTA */}
        <section className="px-6 py-16 md:py-20">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
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
            <div className="relative">
              <h2 className="text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                Stop losing that revenue today
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Sarah answers every call, 24/7, so the number above becomes revenue you keep.
              </p>
              <div className="mt-9 flex justify-center">
                <Link to="/login">
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    Start Free Trial
                    <ArrowRight size={18} />
                  </Button>
                </Link>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-white/70">
                <ShieldCheck size={13} className="shrink-0" />
                Cancel anytime. No contracts.
              </p>
            </div>
          </motion.div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
