import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Wrench, BadgeDollarSign, PhoneCall, Eye, Target, TrendingUp, PhoneForwarded, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

const OUR_VALUES = [
  {
    icon: Eye,
    title: 'Radical Transparency',
    body: 'No fake testimonials, invented customer counts, or hidden pricing claims. What you see is what you get.',
  },
  {
    icon: Target,
    title: 'Built for One Industry, Done Right',
    body: 'Vireek focuses on home-service businesses rather than trying to be a generic receptionist for everyone.',
  },
  {
    icon: TrendingUp,
    title: 'Always Improving',
    body: 'Vireek is continuously being improved through hands-on product development and direct attention to the customer experience.',
  },
  {
    icon: PhoneForwarded,
    title: 'Follow Through',
    body: 'The product should not simply answer calls; it should help businesses capture information and move conversations toward the next step.',
  },
];

const WHY_VIREEK = [
  {
    icon: Wrench,
    title: 'Built for Trades, Not Generic Business',
    body: 'Sarah understands HVAC, plumbing, roofing, electrical, and restoration workflows — not just a generic intake script. She asks the right questions for your trade.',
  },
  {
    icon: BadgeDollarSign,
    title: 'Honest, Transparent Pricing',
    body: 'No hidden fees, no long contracts, no surprise overages. You see your plan, your included minutes, and your per-minute rate up front.',
  },
  {
    icon: PhoneCall,
    title: 'We Follow Through, Not Just Answer',
    body: 'Sarah does not just take a message and hang up. She captures lead details, books appointments, flags emergencies, and routes the call to the right next step.',
  },
];

function SEO() {
  useEffect(() => {
    const title = 'About Vireek | AI Voice Receptionist for Home Service Businesses';
    const description = 'Vireek is an AI voice receptionist built specifically for home-service businesses. Meet Sarah — she answers every call, 24/7, so contractors never lose a job to voicemail.';
    const previousTitle = document.title;
    const upsertMeta = (name: string, content: string) => {
      let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', name);
        document.head.appendChild(meta);
      }
      const previous = meta.getAttribute('content');
      meta.setAttribute('content', content);
      return () => {
        if (previous === null) meta?.remove();
        else meta?.setAttribute('content', previous);
      };
    };

    document.title = title;
    const cleanupDescription = upsertMeta('description', description);
    const cleanupRobots = upsertMeta('robots', 'index, follow');

    return () => {
      document.title = previousTitle;
      cleanupDescription();
      cleanupRobots();
    };
  }, []);

  return null;
}

export function AboutPage() {
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
              <p className={eyebrowClass()}>About Vireek</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                We Built Sarah Because Contractors Deserve Better
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Vireek is an AI voice receptionist built for home-service businesses. Sarah
                answers every call, 24/7, captures lead details, books appointments, and flags
                emergencies — so you never lose a job to voicemail again.
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

        {/* Founder Story */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
            >
              <p className={eyebrowClass()}>Our Story</p>
              <h2 className={`${sectionHeadingClass()} mt-3`}>
                Why we started Vireek
              </h2>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
              className="mt-8 space-y-6 text-lg leading-8 text-text-secondary"
            >
              <p>
                I have spent enough time around home-service businesses to know how the phone
                actually rings. It rings while you are under a sink, on a roof, or halfway through
                an install. It rings after hours, on weekends, and during the rush when three jobs
                are backing up at once. And far too often, it goes unanswered.
              </p>
              <p>
                A missed call is not just a missed call. It is a homeowner with a flooded basement
                calling the next plumber on the list. It is a lead who already decided to buy and
                just needed someone to pick up. Every unanswered ring is a job that went to a
                competitor — not because they were better, but because they answered first.
              </p>
              <p>
                The options contractors have today are not great. A full-time receptionist is
                expensive and still takes breaks, gets sick, and goes home at 5. Generic answering
                services can take a message, but they do not know the difference between a tripped
                breaker and a tripped GFCI, and they definitely cannot qualify a lead or book a
                job. Voicemail just sits there.
              </p>
              <p>
                I wanted something better — something built specifically for the trades. So I built
                Vireek. Sarah is designed around the realities of HVAC, plumbing, roofing,
                electrical, and restoration businesses. She knows what an emergency sounds like,
                she asks the questions that matter for your trade, and she does it 24/7 without
                hiring, training, or turnover.
              </p>
              <p>
                Vireek is early. We are not claiming to have thousands of customers or a massive
                team. What we do have is a product that solves a real problem for contractors, and
                a commitment to build it honestly alongside the businesses that use it. If you are
                a contractor who is tired of losing jobs to voicemail, I would love for you to
                try it.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Why Vireek */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Why Vireek</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                What makes us different
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                We are not a generic answering service. We are built for the trades, from the
                ground up.
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 md:grid-cols-3"
            >
              {WHY_VIREEK.map(({ icon: Icon, title, body }) => (
                <motion.div key={title} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="h-full">
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                      <Icon size={24} />
                    </span>
                    <h3 className="mt-5 text-lg font-semibold text-text-primary">{title}</h3>
                    <p className="mt-3 text-sm leading-relaxed text-text-secondary">{body}</p>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Our Values */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Our Values</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                What we believe in
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                The principles that shape every decision we make.
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
            >
              {OUR_VALUES.map(({ icon: Icon, title, body }) => (
                <motion.div key={title} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="h-full">
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                      <Icon size={24} />
                    </span>
                    <h3 className="mt-5 text-lg font-semibold text-text-primary">{title}</h3>
                    <p className="mt-3 text-sm leading-relaxed text-text-secondary">{body}</p>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Where We're Headed */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
            >
              <p className={eyebrowClass()}>Where We're Headed</p>
              <h2 className={`${sectionHeadingClass()} mt-3`}>
                What comes next
              </h2>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
              className="mt-8 space-y-6 text-lg leading-8 text-text-secondary"
            >
              <p>
                Vireek is early, and we are building with intent. The roadmap is shaped by the
                contractors who use the product and the realities of running a home-service
                business. Our near-term focus is on deeper integrations with the field-service
                software that contractors already rely on — so that a call answered by Sarah flows
                directly into the tools that manage scheduling, dispatch, and customer records
                without manual data entry.
              </p>
              <p>
                We are also investing in stronger automated follow-up. A captured lead is only
                valuable if the next step actually happens. We want every call to trigger a clear,
                reliable follow-through — whether that is a confirmation text, a scheduled callback,
                or a job created in the system — so nothing slips through the cracks between the
                phone ringing and the work getting done.
              </p>
              <p>
                Beyond that, we see a clear path toward better call intelligence and broader
                operational automation: smarter call summaries, trend detection across call
                volume, and workflows that reduce the busywork of running a trade business. These
                are directions we are actively exploring, not features that exist today. We would
                rather build them carefully with feedback from real contractors than ship
                something half-finished.
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
