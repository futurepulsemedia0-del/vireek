import { motion } from 'framer-motion';
import { ArrowRight, ShieldCheck, PhoneCall, Wrench, Siren, CalendarClock, MessageSquareText, ClipboardList } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

const CAPABILITIES = [
  {
    icon: PhoneCall,
    title: 'Answers Instantly',
    lead: '24/7 call answering, so no lead ever hits voicemail.',
    body: 'Sarah picks up on the first ring — day or night, weekends and holidays included. Every call is answered in a natural, conversational voice, so homeowners reach a real person instead of a beep. For a contractor, that means the after-hours burst pipe, the Sunday emergency, and the lunch-rush inquiry all get the same immediate response. No more lost jobs because nobody could pick up.',
    points: [
      'Picks up on the first ring, 24/7',
      'Natural, conversational voice — not a robotic menu',
      'No voicemail, no hold music, no missed-call callbacks',
    ],
  },
  {
    icon: Wrench,
    title: 'Understands Trade-Specific Language',
    lead: 'Designed around home-service terminology and caller intent.',
    body: 'Sarah is built for HVAC, plumbing, roofing, electrical, and restoration businesses — not a generic intake script. She understands the difference between a tripped breaker and a tripped GFCI, knows what a no-cool call means in summer, and asks the questions that matter for your trade. That trade-specific context means callers feel understood, and the information captured is actually useful for dispatching the right job.',
    points: [
      'Trained on HVAC, plumbing, roofing, electrical, and restoration terminology',
      'Asks trade-relevant qualifying questions',
      'Separates routine service requests from urgent issues',
    ],
  },
  {
    icon: Siren,
    title: 'Detects & Flags Emergencies',
    lead: 'Emergency detection and escalation — without replacing emergency services.',
    body: 'Sarah listens for the signals that make a call urgent — gas leaks, flooding, no heat in winter, live electrical issues — and flags those calls for immediate attention. She does not replace emergency services or 911. What she does is make sure an urgent call never sits in a queue behind a routine tune-up request, and that the right information gets to you fast so you can decide how to respond.',
    points: [
      'Identifies urgent calls and flags them for priority handling',
      'Does not replace 911 or emergency services',
      'Routes emergency information to you so you can respond quickly',
    ],
  },
  {
    icon: CalendarClock,
    title: 'Books & Follows Up',
    lead: 'Appointment booking, caller capture, confirmations, and follow-up.',
    body: 'Sarah does not just take a message and hang up. She captures the caller\u2019s name, number, and issue, proposes an appointment slot, and confirms the booking before the caller hangs up. After the call, the customer receives an SMS confirmation with the time and details, and a call summary lands in your dashboard so you have a clean recap of every conversation. That follow-through is what turns a ringing phone into a booked job.',
    points: [
      'Captures caller name, number, and issue details',
      'Proposes and confirms appointment slots',
      'Sends SMS confirmations and call summaries to your dashboard',
    ],
  },
];

function SEO() {
  useSEO({
    title: 'Services — What Sarah Does for HVAC, Plumbing, Roofing & More | Vireek',
    description: 'See how Sarah answers calls, understands trade-specific language, flags urgent requests, books appointments, and supports follow-up for home service businesses.',
    canonical: 'https://vireek.com/services',
  });
  return null;
}

export function ServicesPage() {
  return (
    <>
      <SEO />
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
              <p className={eyebrowClass()}>What Sarah Does</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                One AI Receptionist. Every Home Service Call Handled.
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                From routine bookings to after-hours emergencies, Sarah handles the conversation —
                built specifically for the trades.
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

        {/* What Sarah Does — detailed capability sections */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Capabilities</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                What Sarah Does
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                Four capabilities that cover the full call — from the first ring to the booked job.
              </p>
            </motion.div>

            <div className="mt-16 space-y-16">
              {CAPABILITIES.map((cap, index) => {
                const Icon = cap.icon;
                const isReversed = index % 2 === 1;
                return (
                  <motion.div
                    key={cap.title}
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={viewport}
                    transition={{ duration: 0.5, ease: EASE }}
                    className={`grid gap-8 lg:grid-cols-2 lg:items-center lg:gap-16 ${
                      isReversed ? 'lg:[&>*:first-child]:order-2' : ''
                    }`}
                  >
                    {/* Text */}
                    <div>
                      <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                        <Icon size={28} />
                      </span>
                      <h3 className="mt-6 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">
                        {cap.title}
                      </h3>
                      <p className="mt-2 text-lg font-medium text-accent">{cap.lead}</p>
                      <p className="mt-5 text-base leading-relaxed text-text-secondary">
                        {cap.body}
                      </p>
                      <ul className="mt-6 space-y-3">
                        {cap.points.map((point) => (
                          <li key={point} className="flex items-start gap-3 text-sm text-text-primary">
                            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-accent" />
                            {point}
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* Visual */}
                    <div className="relative">
                      <div className="relative overflow-hidden rounded-2xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark">
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-0"
                          style={{
                            backgroundImage:
                              'radial-gradient(circle at 80% 20%, rgb(var(--accent-primary) / 0.08), transparent 50%)',
                          }}
                        />
                        <div className="relative flex flex-col gap-4">
                          <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-tertiary px-4 py-3">
                            <PhoneCall size={18} className="shrink-0 text-accent" />
                            <span className="text-sm font-medium text-text-secondary">Incoming call detected</span>
                          </div>
                          <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-tertiary px-4 py-3">
                            <ClipboardList size={18} className="shrink-0 text-accent" />
                            <span className="text-sm font-medium text-text-secondary">Caller information captured</span>
                          </div>
                          <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-tertiary px-4 py-3">
                            <MessageSquareText size={18} className="shrink-0 text-accent" />
                            <span className="text-sm font-medium text-text-secondary">Trade-specific qualification</span>
                          </div>
                          <div className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/[0.06] px-4 py-3">
                            <CalendarClock size={18} className="shrink-0 text-accent" />
                            <span className="text-sm font-semibold text-accent">Appointment booked & confirmed</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
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
                Ready to stop missing calls?
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Every call Sarah answers is a customer who reached a real voice instead of a beep.
                Start free and hear how she handles your calls.
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
