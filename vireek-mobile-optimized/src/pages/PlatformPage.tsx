import { motion } from 'framer-motion';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { AutomationEngines } from '@/components/sections/AutomationEngines';
import { OperationsCommandCenter } from '@/components/sections/OperationsCommandCenter';
import { AIBrain } from '@/components/sections/AIBrain';
import { AiBusinessMemory } from '@/components/sections/AiBusinessMemory';
import { AiCallCoach } from '@/components/sections/AiCallCoach';
import { RevenueIntelligence } from '@/components/sections/RevenueIntelligence';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

/**
 * Platform page — the deep technical dive. These five sections (moved here
 * from the homepage) each explain a different layer of the "AI operating
 * system" pitch: orchestration, reasoning, memory, coaching, and the revenue
 * math. That's exactly what someone lands on /platform to read; on the
 * homepage the same five sections were repeating one message five times.
 */
export function PlatformPage() {
  useSEO({
    title: 'Platform — An AI Operating System for Home Services | Vireek',
    description: 'Vireek is an AI operating system for home-service businesses. See the full automation stack — call intelligence, booking, growth, operations, and compliance — working together behind every call.',
    canonical: 'https://vireek.com/platform',
  });

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
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
              <p className={eyebrowClass()}>The Platform</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                An AI Operating System for Home-Service Businesses
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                This isn&rsquo;t one chatbot bolted onto a phone line. It&rsquo;s a full automation stack —
                intake, intelligence, booking, growth, operations, and compliance — working together
                so nothing falls through the cracks.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/login">
                  <Button variant="primary" size="lg">Start Free Trial</Button>
                </Link>
                <Link
                  to="/pricing"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  View pricing
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Automation engines (the full 31-engine tabbed section) */}
        <AutomationEngines />

        {/* Architecture diagram section */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>System Architecture</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                How every call flows through Vireek
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                From the first ring to the booked job — every layer works together automatically.
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.6, ease: EASE, delay: 0.1 }}
              className="mt-14 rounded-2xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark md:p-12"
            >
              <div className="flex flex-col gap-4">
                {[
                  { step: '01', label: 'Call Ingestion', desc: 'Sarah answers, validates, filters spam, logs the call' },
                  { step: '02', label: 'AI Intelligence', desc: 'Summarizes, detects intent, scores sentiment, rates the lead' },
                  { step: '03', label: 'Lead Capture', desc: 'Deduplicates, builds profile, enriches automatically' },
                  { step: '04', label: 'Booking & Dispatch', desc: 'Checks availability, books slot, syncs calendar, sends confirmation' },
                  { step: '05', label: 'Follow-Through', desc: 'SMS confirmation, call summary to dashboard, CRM sync' },
                ].map((layer) => (
                  <div
                    key={layer.step}
                    className="flex items-center gap-4 rounded-xl border border-border bg-bg-tertiary px-5 py-4 transition-colors hover:border-accent/30"
                  >
                    <span className="text-sm font-bold text-accent">{layer.step}</span>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-text-primary">{layer.label}</p>
                      <p className="text-xs text-text-secondary">{layer.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>
        </section>

        {/* Deep-dive sections (moved here from the homepage) */}
        <OperationsCommandCenter />
        <AIBrain />
        <AiBusinessMemory />
        <AiCallCoach />
        <RevenueIntelligence />

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
                See it running on your business
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Start free and watch Sarah handle your calls — from the first ring to the booked job.
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
