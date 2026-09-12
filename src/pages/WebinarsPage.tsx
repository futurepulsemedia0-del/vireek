import { useState, useRef, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Calendar,
  Clock,
  Video,
  PlayCircle,
  Mail,
  CheckCircle2,
  Users,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

// ============================================================
// CONTENT — edit this array with real, scheduled sessions.
// ============================================================
//
// HONESTY NOTE (same standard as CaseStudiesPage.tsx / AboutPage.tsx):
// only put a session here once it is actually scheduled with a real
// date, time, and host. Do not publish placeholder dates as if they
// are booked. Until a real session is confirmed, leave UPCOMING_WEBINARS
// empty — the section below renders a clean "notify me" state when it is.
interface Webinar {
  slug: string;
  title: string;
  description: string;
  date: string; // e.g. 'October 14, 2026'
  time: string; // e.g. '1:00 PM EST'
  host: string;
  registerHref: string; // Zoom/Google Meet/Luma registration link
}

const UPCOMING_WEBINARS: Webinar[] = [
  // {
  //   slug: 'live-demo-oct',
  //   title: 'Live Demo: Never Miss Another Emergency Call',
  //   description: 'A 30-minute walkthrough of Sarah answering, qualifying, and booking real calls for a plumbing business — followed by live Q&A.',
  //   date: 'October 14, 2026',
  //   time: '1:00 PM EST',
  //   host: 'Ali Moradi, Founder',
  //   registerHref: 'https://vireek.com/demo',
  // },
];

interface PastWebinar {
  slug: string;
  title: string;
  description: string;
  date: string;
  recordingHref: string;
}

const PAST_WEBINARS: PastWebinar[] = [
  // {
  //   slug: 'onboarding-walkthrough',
  //   title: 'Onboarding Walkthrough: Your First 15 Minutes With Vireek',
  //   description: 'How to connect your number, train Sarah on your services, and go live the same day.',
  //   date: 'September 2026',
  //   recordingHref: 'https://vireek.com/blog/onboarding-walkthrough',
  // },
];

function NotifySignup() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (state === 'loading' || state === 'success') return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setState('error');
      inputRef.current?.focus();
      return;
    }
    setState('loading');
    // TODO: wire to the real notify-list endpoint once the backend route
    // exists (same mock-submit pattern used in Footer.tsx NewsletterSection
    // until that lands).
    await new Promise((r) => setTimeout(r, 1000));
    setState('success');
    setEmail('');
  };

  if (state === 'success') {
    return (
      <p className="flex items-center justify-center gap-2 text-sm font-semibold text-success">
        <CheckCircle2 size={18} /> You're on the list — we'll email you when the next session is up.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto flex max-w-md flex-col gap-3 sm:flex-row">
      <input
        ref={inputRef}
        type="email"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          if (state === 'error') setState('idle');
        }}
        placeholder="you@company.com"
        aria-label="Email address"
        className={`focus-ring w-full rounded-xl border bg-bg-secondary px-4 py-3 text-sm text-text-primary placeholder:text-text-secondary/60 ${
          state === 'error' ? 'border-danger/60' : 'border-border'
        }`}
      />
      <Button type="submit" variant="primary" size="md" disabled={state === 'loading'}>
        {state === 'loading' ? 'Sending…' : 'Notify me'}
      </Button>
    </form>
  );
}

function SEO() {
  useSEO({
    title: 'Webinars & Events — Vireek',
    description:
      'Live demos, product walkthroughs, and on-demand recordings on how Vireek answers, qualifies, and books calls for home service businesses.',
    canonical: 'https://vireek.com/webinars',
  });
  return null;
}

export function WebinarsPage() {
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
              <p className={eyebrowClass()}>Webinars & Events</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                See Sarah Answer Real Calls, Live
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Live product demos, onboarding walkthroughs, and Q&A sessions with the Vireek
                team — plus recordings of every past session.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Upcoming */}
        <section id="upcoming" className="scroll-mt-24 px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Upcoming</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Next sessions</h2>
            </motion.div>

            {UPCOMING_WEBINARS.length > 0 ? (
              <motion.div
                variants={staggerContainer}
                initial="initial"
                whileInView="whileInView"
                viewport={viewport}
                className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
              >
                {UPCOMING_WEBINARS.map((w) => (
                  <motion.div key={w.slug} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                    <Card className="flex h-full flex-col">
                      <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                        <Video size={20} />
                      </span>
                      <h3 className="mt-5 text-lg font-semibold text-text-primary">{w.title}</h3>
                      <p className="mt-3 flex-1 text-sm leading-relaxed text-text-secondary">{w.description}</p>
                      <div className="mt-5 space-y-1.5 text-xs text-text-secondary">
                        <p className="flex items-center gap-1.5"><Calendar size={13} /> {w.date}</p>
                        <p className="flex items-center gap-1.5"><Clock size={13} /> {w.time}</p>
                        <p className="flex items-center gap-1.5"><Users size={13} /> Hosted by {w.host}</p>
                      </div>
                      <a href={w.registerHref} target="_blank" rel="noopener noreferrer" className="mt-6">
                        <Button variant="primary" size="sm" className="w-full">
                          Register free <ArrowRight size={16} />
                        </Button>
                      </a>
                    </Card>
                  </motion.div>
                ))}
              </motion.div>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, ease: EASE }}
                className="mt-12"
              >
                <Card className="mx-auto max-w-xl text-center">
                  <Mail className="mx-auto h-9 w-9 text-accent" />
                  <h3 className="mt-4 text-lg font-semibold text-text-primary">
                    No live session on the calendar right now
                  </h3>
                  <p className={`${bodyClass()} mt-2`}>
                    Leave your email and we'll let you know the moment the next one is scheduled —
                    no spam, just a heads-up.
                  </p>
                  <div className="mt-6">
                    <NotifySignup />
                  </div>
                </Card>
              </motion.div>
            )}
          </div>
        </section>

        {/* On-demand */}
        <section id="on-demand" className="scroll-mt-24 px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>On-Demand</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Watch past sessions</h2>
            </motion.div>

            {PAST_WEBINARS.length > 0 ? (
              <motion.div
                variants={staggerContainer}
                initial="initial"
                whileInView="whileInView"
                viewport={viewport}
                className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
              >
                {PAST_WEBINARS.map((w) => (
                  <motion.div key={w.slug} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                    <a href={w.recordingHref} target="_blank" rel="noopener noreferrer" className="block h-full">
                      <Card className="flex h-full flex-col">
                        <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                          <PlayCircle size={20} />
                        </span>
                        <h3 className="mt-5 text-lg font-semibold text-text-primary">{w.title}</h3>
                        <p className="mt-3 flex-1 text-sm leading-relaxed text-text-secondary">{w.description}</p>
                        <p className="mt-5 flex items-center gap-1.5 text-xs text-text-secondary">
                          <Calendar size={13} /> {w.date}
                        </p>
                        <span className="mt-4 flex items-center gap-1.5 text-sm font-semibold text-accent">
                          Watch recording <ArrowRight size={15} />
                        </span>
                      </Card>
                    </a>
                  </motion.div>
                ))}
              </motion.div>
            ) : (
              <p className="mt-10 text-center text-sm text-text-secondary">
                Recordings will appear here after the first live session.
              </p>
            )}
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
              <Video className="mx-auto h-10 w-10 text-white/90" />
              <h2 className="mt-5 text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                Prefer a 1-on-1 walkthrough?
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Skip the group session and book a live demo with our team on your schedule.
              </p>
              <div className="mt-9 flex justify-center">
                <a href="/demo">
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    Book a demo <ArrowRight size={18} />
                  </Button>
                </a>
              </div>
            </div>
          </motion.div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
