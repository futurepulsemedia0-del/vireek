import { motion } from 'framer-motion';
import { ArrowRight, ShieldCheck, X, Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

// ============================================================
// CONTENT
// ============================================================
// A manifesto is a small, closed set of convictions — not a feature
// list and not a values grid (that's CulturePage, which covers how the
// team works internally). Every line here is something Vireek would
// still say even if it cost a sale.

const TENETS = [
  {
    n: '01',
    title: 'A ringing phone is a decision, not a task.',
    body: 'Somewhere on the other end is a homeowner with a flooded basement, or a lead who already decided to buy and just needs someone to pick up. We build as if every ring matters, because it does.',
  },
  {
    n: '02',
    title: 'Built for a trade, not "business in general."',
    body: 'A receptionist that treats an HVAC emergency like a restaurant reservation is not a receptionist — it is a formality. Sarah is built around what plumbing, HVAC, roofing, electrical, and restoration calls actually sound like.',
  },
  {
    n: '03',
    title: 'Answering is the minimum, not the goal.',
    body: 'A call that ends in a message taken and nothing else is a call that still cost you the job. The point is the next step: a booked appointment, a qualified lead, an emergency flagged and routed — every time.',
  },
  {
    n: '04',
    title: 'Say what is true, not what sounds good.',
    body: 'No invented customer counts, no manufactured urgency, no pricing page that hides the real number until checkout. If we are early, we say we are early.',
  },
  {
    n: '05',
    title: 'AI earns trust by being reliable, not by being clever.',
    body: 'Nobody needs a receptionist with a personality quirk. They need one who shows up at 2 a.m., asks the right questions, and never has an off day. Reliability is the feature.',
  },
  {
    n: '06',
    title: 'Some calls need a human — so know which ones.',
    body: 'An AI that pretends to handle everything is more dangerous than one that knows its limits. Sarah is built to recognize an emergency and escalate it, not to bluff her way through one.',
  },
  {
    n: '07',
    title: 'Software for the trades should respect the trades.',
    body: 'Contractors do not have time for a twelve-step setup wizard or a support ticket that takes three days. If a tool is hard to run a business with, the tool is wrong, not the contractor.',
  },
  {
    n: '08',
    title: 'Never finished — always improving.',
    body: 'We would rather ship something honest and keep sharpening it in the open than pretend a product is complete. Vireek today should be a worse version of Vireek in a year.',
  },
];

const REFUSE_VS_DO = [
  {
    refuse: 'Fake testimonials or invented customer counts',
    instead: 'A product page that says exactly where we stand today',
  },
  {
    refuse: 'Pricing hidden until you talk to sales',
    instead: 'Plans, minutes, and per-minute rates shown up front',
  },
  {
    refuse: 'An AI that fakes empathy to sound "human"',
    instead: 'An AI that is useful, clear, and knows when to hand off',
  },
  {
    refuse: 'Long contracts to lock you in',
    instead: 'A product good enough that you would not want to leave',
  },
];

function SEO() {
  useSEO({
    title: 'Manifesto — What Vireek Believes',
    description:
      'The convictions behind Vireek: why we build an AI receptionist for the trades, what we refuse to do, and what we will always choose instead.',
    canonical: 'https://vireek.com/manifesto',
  });
  return null;
}

export function ManifestoPage() {
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
              <p className={eyebrowClass()}>Manifesto</p>
              <h1 className="mt-4 text-balance font-display text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Every Call Is Someone's Emergency,
                <br className="hidden sm:block" /> Sale, or Second Chance
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                This is not a values slide. It is the short list of things we refuse to
                compromise on while building an AI receptionist for the trades — and what we do
                instead.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Tenets — numbered, editorial, one column */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-3xl">
            <motion.ol
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="space-y-14"
            >
              {TENETS.map(({ n, title, body }) => (
                <motion.li
                  key={n}
                  variants={fadeUpItem}
                  transition={{ duration: 0.45, ease: EASE }}
                  className="flex gap-6 border-t border-border pt-8 first:border-t-0 first:pt-0 sm:gap-8"
                >
                  <span className="shrink-0 font-display text-3xl font-bold text-accent/30 sm:text-4xl">{n}</span>
                  <div>
                    <h2 className="text-balance text-xl font-bold leading-snug tracking-tight text-text-primary sm:text-2xl">
                      {title}
                    </h2>
                    <p className="mt-3 text-base leading-relaxed text-text-secondary sm:text-lg">{body}</p>
                  </div>
                </motion.li>
              ))}
            </motion.ol>
          </div>
        </section>

        {/* What we refuse / what we do instead */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>In Practice</p>
              <h2 className="mt-3 text-center font-display text-3xl font-semibold leading-[1.15] tracking-tight text-text-primary md:text-5xl">
                What we refuse to do — and what we do instead
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                Principles are only real if they show up in the product. Here is where ours do.
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 overflow-hidden rounded-2xl border border-border"
            >
              {REFUSE_VS_DO.map(({ refuse, instead }, i) => (
                <motion.div
                  key={refuse}
                  variants={fadeUpItem}
                  transition={{ duration: 0.4, ease: EASE }}
                  className={`grid gap-4 bg-bg-secondary/60 p-5 sm:grid-cols-2 sm:gap-8 sm:p-6 ${i > 0 ? 'border-t border-border' : ''}`}
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
                      <X size={14} strokeWidth={2.5} />
                    </span>
                    <p className="text-sm leading-relaxed text-text-secondary sm:text-base">{refuse}</p>
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success-500/10 text-success-500">
                      <Check size={14} strokeWidth={2.5} />
                    </span>
                    <p className="text-sm font-medium leading-relaxed text-text-primary sm:text-base">{instead}</p>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Closing declaration */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="border-l-2 border-accent pl-6 sm:pl-8"
            >
              <p className="text-balance font-display text-2xl font-semibold leading-snug tracking-tight text-text-primary sm:text-3xl">
                We are not trying to build the AI receptionist for every business. We are
                trying to build the right one for yours.
              </p>
              <p className="mt-5 text-base leading-relaxed text-text-secondary sm:text-lg">
                If any of this ever stops being true of Vireek, hold us to it. Read more about{' '}
                <Link to="/about" className="font-semibold text-accent hover:underline">
                  why we started
                </Link>{' '}
                or how{' '}
                <Link to="/culture" className="font-semibold text-accent hover:underline">
                  we work as a team
                </Link>
                .
              </p>
            </motion.div>
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
                See these beliefs answer a call
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Start free and hear how Sarah handles a real conversation — no script reading,
                no sales call required.
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
