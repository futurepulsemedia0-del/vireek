import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Wrench, BadgeDollarSign, PhoneCall } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

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

        {/* CTA */}
        <section className="px-6 pb-24">
          <div className="mx-auto max-w-5xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
              Ready when your customers call
            </p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Stop losing jobs to voicemail.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary">
              Start your 14-day free trial and let Sarah answer every call — no credit card
              required.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link to="/login">
                <Button variant="primary" size="lg">Start Free Trial</Button>
              </Link>
              <Link
                to="/faq"
                className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
              >
                Read the FAQ
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
