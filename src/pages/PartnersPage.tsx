import { motion } from 'framer-motion';
import {
  ArrowRight,
  ShieldCheck,
  Link2,
  Building2,
  Users,
  Mail,
  CheckCircle2,
  Megaphone,
  Handshake,
  Wallet,
  ClipboardList,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

const PARTNERS_EMAIL = 'ali@vireek.com';

type Track = {
  icon: typeof Link2;
  name: string;
  eyebrow: string;
  title: string;
  body: string;
  bestFor: string;
  bullets: string[];
  ctaLabel: string;
  subject: string;
};

const TRACKS: Track[] = [
  {
    icon: Link2,
    name: 'affiliate',
    eyebrow: 'For creators & influencers',
    title: 'Affiliate Program',
    body: 'Share Vireek with your audience — a YouTube channel, a trades-focused newsletter, a podcast, a blog — and earn a commission on every business that signs up through your link.',
    bestFor: 'Content creators, bloggers, and anyone with an audience of contractors or home-service business owners.',
    bullets: [
      'Your own tracked referral link',
      'Commission on every paid signup you refer',
      'No minimum audience size to apply',
    ],
    ctaLabel: 'Apply as an affiliate',
    subject: 'Affiliate Program application',
  },
  {
    icon: Building2,
    name: 'reseller',
    eyebrow: 'For agencies & consultants',
    title: 'Reseller / White-Label',
    body: 'If you already work with home-service businesses — as a marketing agency, business consultant, or field-service software reseller — offer Vireek under your own relationship, or fully white-labeled.',
    bestFor: 'Agencies, consultants, and value-added resellers who serve HVAC, plumbing, roofing, or electrical clients.',
    bullets: [
      'Bring your existing client relationships',
      'White-label option for agencies',
      'A single point of contact on our side',
    ],
    ctaLabel: 'Talk to us about reselling',
    subject: 'Reseller / White-Label inquiry',
  },
  {
    icon: Users,
    name: 'referral',
    eyebrow: 'For current Vireek customers',
    title: 'Customer Referral',
    body: 'Already running Vireek and know another contractor who is missing calls? Refer them directly — you both benefit once they come on board.',
    bestFor: 'Existing Vireek customers who want to introduce other home-service businesses to the product.',
    bullets: [
      'Simple, direct referral — no tracking software required',
      'Reward applied to your own account',
      'Works alongside the affiliate program, not instead of it',
    ],
    ctaLabel: 'Refer a business',
    subject: 'Customer referral',
  },
];

const HOW_IT_WORKS = [
  {
    icon: Mail,
    title: 'Apply',
    body: 'Tell us which track fits you and a little about your audience, agency, or the business you want to refer.',
  },
  {
    icon: ClipboardList,
    title: 'Get Set Up',
    body: 'We confirm the details and get you a tracked link (affiliate/reseller) or the direct referral process (customers).',
  },
  {
    icon: Megaphone,
    title: 'Share Vireek',
    body: 'Promote your link, introduce a client, or refer a contractor you already know.',
  },
  {
    icon: Wallet,
    title: 'Get Rewarded',
    body: 'Once a referred business signs up and stays on, your reward is confirmed and paid out.',
  },
];

const FAQ_ITEMS = [
  {
    q: 'How much can I earn?',
    a: 'Commission and referral terms depend on the track and are confirmed when you apply — reach out and we will walk you through current rates for your situation.',
  },
  {
    q: 'Can I be both an affiliate and refer customers directly?',
    a: 'Yes. The tracks are designed to work alongside each other — pick whichever fits how you plan to introduce people to Vireek.',
  },
  {
    q: 'Is there a cost to join?',
    a: 'No. All three tracks are free to join — there is no fee to become an affiliate, reseller, or referring customer.',
  },
  {
    q: 'How do I get paid?',
    a: 'Payout details are confirmed during setup once you apply, based on which track fits you.',
  },
];

function SEO() {
  useSEO({
    title: 'Partners — Affiliate, Reseller & Referral Programs | Vireek',
    description:
      'Partner with Vireek: join the affiliate program, become a reseller or white-label partner, or refer another home-service business as a current customer.',
    canonical: 'https://vireek.com/partners',
  });
  return null;
}

function TrackCard({ track }: { track: Track }) {
  const Icon = track.icon;
  const href = `mailto:${PARTNERS_EMAIL}?subject=${encodeURIComponent(track.subject)}`;

  return (
    <Card className="flex h-full flex-col">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
        <Icon size={24} />
      </span>
      <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-accent">{track.eyebrow}</p>
      <h3 className="mt-1.5 text-xl font-bold text-text-primary">{track.title}</h3>
      <p className="mt-3 text-sm leading-relaxed text-text-secondary">{track.body}</p>

      <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-text-secondary/70">Best for</p>
      <p className="mt-1.5 text-sm text-text-secondary">{track.bestFor}</p>

      <ul className="mt-5 flex-1 space-y-2.5">
        {track.bullets.map((bullet) => (
          <li key={bullet} className="flex items-start gap-2 text-sm text-text-secondary">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
            <span>{bullet}</span>
          </li>
        ))}
      </ul>

      <a href={href} className="mt-6">
        <Button variant="primary" size="sm" className="w-full">
          {track.ctaLabel}
          <ArrowRight size={16} />
        </Button>
      </a>
    </Card>
  );
}

export function PartnersPage() {
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
              <p className={eyebrowClass()}>Partners</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Grow With Vireek
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Three ways to partner with us — as an affiliate, a reseller or white-label
                partner, or a customer referring another home-service business. Pick the one
                that fits you.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a href="#tracks">
                  <Button variant="primary" size="lg">
                    See Partner Tracks
                  </Button>
                </a>
                <a
                  href={`mailto:${PARTNERS_EMAIL}?subject=${encodeURIComponent('Partnership inquiry')}`}
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  Email us directly
                  <ArrowRight className="h-4 w-4" />
                </a>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Tracks */}
        <section id="tracks" className="scroll-mt-24 px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Choose Your Track</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                Three ways to partner
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                Each track is built for a different relationship with Vireek — none of them
                require an existing tech stack or minimum size to apply.
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 lg:grid-cols-3"
            >
              {TRACKS.map((track) => (
                <motion.div key={track.name} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <TrackCard track={track} />
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* How it works */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>How It Works</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                From application to your first payout
              </h2>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
            >
              {HOW_IT_WORKS.map(({ icon: Icon, title, body }, index) => (
                <motion.div key={title} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="relative h-full">
                    <span className="absolute right-6 top-6 text-3xl font-extrabold text-text-primary/[0.06]">
                      {String(index + 1).padStart(2, '0')}
                    </span>
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

        {/* FAQ */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Questions</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Partner Program FAQ</h2>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-12 space-y-4"
            >
              {FAQ_ITEMS.map(({ q, a }) => (
                <motion.div key={q} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card>
                    <h3 className="text-base font-semibold text-text-primary">{q}</h3>
                    <p className="mt-2.5 text-sm leading-relaxed text-text-secondary">{a}</p>
                  </Card>
                </motion.div>
              ))}
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
              <Handshake className="mx-auto h-10 w-10 text-white/90" />
              <h2 className="mt-5 text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                Ready to partner with us?
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Tell us which track fits — affiliate, reseller, or referral — and we will get you
                set up.
              </p>
              <div className="mt-9 flex justify-center">
                <a href={`mailto:${PARTNERS_EMAIL}?subject=${encodeURIComponent('Partnership inquiry')}`}>
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    Apply to Partner
                    <ArrowRight size={18} />
                  </Button>
                </a>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-white/70">
                <ShieldCheck size={13} className="shrink-0" />
                Free to join. No minimum size required.
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
