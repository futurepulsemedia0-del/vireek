import { motion } from 'framer-motion';
import { ArrowRight, CalendarCheck, ShieldCheck, Sparkles, Wrench, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { WhyVireek } from '@/components/sections/WhyVireek';
import { BeforeAfter } from '@/components/sections/BeforeAfter';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { COMPETITORS } from '@/lib/competitors';

export function ComparePage() {
  useSEO({
    title: 'Compare Vireek vs Answering Services, Voicemail & AI Voice Bots | Vireek',
    description: 'See how Vireek compares to traditional answering services, voicemail, and generic AI voice bots. A trade-trained AI receptionist that answers every call, books appointments, captures leads, and syncs to your CRM from day one.',
    canonical: 'https://vireek.com/compare',
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
              <p className={eyebrowClass()}>The Comparison</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Why Home Service Teams Switch to Vireek
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                See how an always-on, trade-trained AI receptionist stacks up against the
                ways most businesses handle calls today — including other AI voice tools.
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

        {/* Before / after */}
        <BeforeAfter />

        {/* Comparison table */}
        <WhyVireek />

        {/* Key differences */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>The Difference</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                What sets Vireek apart
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                Three things that traditional options simply cannot do.
              </p>
            </motion.div>

            <div className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
              {[
                {
                  icon: CalendarCheck,
                  title: 'Books the job, not just a message',
                  body: 'Answering services take a message. Sarah checks your calendar, proposes a slot, and confirms the booking before the caller hangs up.',
                },
                {
                  icon: Wrench,
                  title: 'Understands the trades',
                  body: 'Generic services — and generic AI voice bots — cannot tell a tripped breaker from a tripped GFCI. Sarah is built for HVAC, plumbing, roofing, electrical, and restoration.',
                },
                {
                  icon: Zap,
                  title: 'Follows through automatically',
                  body: 'Voicemail sits there. Sarah sends SMS confirmations, logs call summaries to your dashboard, and syncs to your CRM — all without manual data entry.',
                },
                {
                  icon: Sparkles,
                  title: 'Ready on day one, not after weeks of setup',
                  body: 'Most general-purpose AI voice bots need you to build the trade knowledge, booking logic, and dispatch rules yourself. Sarah already knows the home-service playbook.',
                },
              ].map((item, index) => (
                <motion.div
                  key={item.title}
                  initial={{ opacity: 0, y: 18 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.45, delay: index * 0.08, ease: EASE }}
                  whileHover={{ y: -4 }}
                  className="group rounded-2xl border border-border bg-bg-secondary p-6 shadow-card transition-shadow duration-200 hover:border-accent/25 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-tertiary text-text-secondary transition-colors group-hover:border-accent/30 group-hover:bg-accent/10 group-hover:text-accent">
                    <item.icon size={18} />
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-text-primary">{item.title}</h3>
                  <p className="mt-3 text-sm leading-relaxed text-text-secondary">{item.body}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Compare Vireek to specific tools */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Head to Head</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                Compare Vireek to specific tools
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                A closer look at how Vireek stacks up against the platforms home-service businesses
                consider most often.
              </p>
            </motion.div>

            <div className="mt-10 grid gap-4 sm:grid-cols-2">
              {COMPETITORS.map((competitor, index) => (
                <motion.div
                  key={competitor.slug}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.45, delay: index * 0.08, ease: EASE }}
                >
                  <Link
                    to={`/compare/${competitor.slug}`}
                    className="group flex items-center justify-between gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
                  >
                    <span className="flex items-center gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-tertiary text-text-secondary transition-colors group-hover:border-accent/30 group-hover:bg-accent/10 group-hover:text-accent">
                        <competitor.icon size={18} />
                      </span>
                      <span>
                        <span className="block text-sm font-semibold text-text-primary">
                          Vireek vs {competitor.name}
                        </span>
                        <span className="block text-xs text-text-secondary">{competitor.category}</span>
                      </span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-text-secondary transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-accent" />
                  </Link>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

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
                Stop losing jobs to voicemail
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Every call Sarah answers is a customer who reached a real voice instead of a beep.
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
