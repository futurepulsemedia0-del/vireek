import { motion } from 'framer-motion';
import {
  ArrowRight,
  Link2,
  Share2,
  Wallet,
  ShieldCheck,
  Clock,
  Repeat,
  Gift,
  Mail,
  CheckCircle2,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

const AFFILIATE_EMAIL = 'ali@vireek.com';
const APPLY_SUBJECT = 'Affiliate Program application';
const APPLY_HREF = `mailto:${AFFILIATE_EMAIL}?subject=${encodeURIComponent(APPLY_SUBJECT)}`;

const HOW_IT_WORKS = [
  { icon: Mail, step: '01', title: 'Apply in minutes', body: 'Send us a quick note about where you plan to share Vireek — a YouTube channel, a newsletter, a trades community, or just word of mouth. No minimum audience size.' },
  { icon: Link2, step: '02', title: 'Get your referral link', body: 'We set you up with a personal tracked link so every signup that comes through it is automatically credited to you.' },
  { icon: Share2, step: '03', title: 'Share it anywhere', body: 'Drop your link in a video description, a blog post, a group chat, or a text to a contractor you know is missing calls.' },
  { icon: Wallet, step: '04', title: 'Get paid', body: 'When someone signs up through your link and becomes a paying customer, your commission is confirmed and paid out.' },
];

const WHY_ITEMS = [
  { icon: Repeat, title: 'Recurring, not one-time', body: 'Commission is tied to the subscription, not a single payout — so a referral you make once can keep paying you for as long as that business stays on Vireek.' },
  { icon: Clock, title: 'Real tracking window', body: "Your link stores attribution for long enough that you still get credit even if the person doesn't sign up the same day." },
  { icon: Gift, title: 'Free to join', body: 'There is no fee, no minimum follower count, and no purchase required to become an affiliate.' },
  { icon: ShieldCheck, title: 'Clear terms, confirmed upfront', body: 'Exact commission rate and payout terms are confirmed with you when you apply — no surprises after the fact.' },
];

const WHO_FOR = [
  'Content creators and YouTubers who cover trades, small business, or home-service tools',
  'Newsletter writers or bloggers with an audience of contractors or business owners',
  'Current Vireek customers who know another contractor missing calls',
  'Anyone with a genuine audience who thinks their audience would use Vireek',
];

const FAQ_ITEMS = [
  { q: 'How is this different from the Partners program?', a: 'This page is the simple, self-serve version: sign up, get a link, share it, earn a commission. Partners covers the bigger relationships — agencies, resellers, and white-label deals — that usually need a real conversation first. If you are an agency or consultant, visit the Partners page instead.' },
  { q: 'How much commission do I earn?', a: 'The exact rate is confirmed when you apply, since it can depend on the volume and type of referrals you plan to make. Reach out and we will walk you through current terms.' },
  { q: 'Is there a minimum audience size to join?', a: 'No. Anyone with a genuine way to reach home-service business owners is welcome to apply — audience size is not a requirement.' },
  { q: 'When and how do I get paid?', a: 'Payout method and schedule are confirmed during setup after you apply, so you know exactly when to expect your first payment.' },
  { q: "What counts as a valid referral?", a: 'Anyone who signs up through your tracked link and becomes a paying Vireek customer counts as your referral. Attribution is handled automatically by the link — you do not need to do anything manually.' },
];

function SEO() {
  useSEO({
    title: 'Affiliate Program — Refer Vireek, Earn Commission',
    description:
      'Join the Vireek affiliate program: get a personal referral link, share Vireek with your audience, and earn recurring commission on every business that signs up.',
    canonical: 'https://vireek.com/affiliate',
  });
  return null;
}

export function AffiliatePage() {
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
              <p className={eyebrowClass()}>Affiliate Program</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Refer Vireek. Earn Real Commission.
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Know a contractor missing calls, or have an audience that would care about this?
                Share your link and earn recurring commission on every business you bring to
                Vireek — no minimum size, no cost to join.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a href={APPLY_HREF}>
                  <Button variant="primary" size="lg">
                    Join the Affiliate Program
                    <ArrowRight size={18} />
                  </Button>
                </a>
                <a
                  href="#how-it-works"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  See how it works
                </a>
              </div>
              <p className="mt-6 flex items-center justify-center gap-1.5 text-xs font-medium text-text-secondary/70">
                <ShieldCheck size={13} className="shrink-0" />
                Free to join. No audience minimum. Commission confirmed when you apply.
              </p>
            </motion.div>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="scroll-mt-24 px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
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
              <p className={`${bodyClass()} mx-auto text-center`}>
                Four simple steps — no dashboard to learn, no software to install.
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
            >
              {HOW_IT_WORKS.map(({ icon: Icon, step, title, body }) => (
                <motion.div key={step} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="relative h-full">
                    <span className="absolute right-6 top-6 text-3xl font-extrabold text-text-primary/[0.06]">
                      {step}
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

        {/* Why it's worth it */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Why Join</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                Built to be worth your time
              </h2>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-2"
            >
              {WHY_ITEMS.map(({ icon: Icon, title, body }) => (
                <motion.div key={title} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="flex h-full items-start gap-4">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                      <Icon size={20} />
                    </span>
                    <div>
                      <h3 className="text-base font-semibold text-text-primary">{title}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-text-secondary">{body}</p>
                    </div>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Who this is for */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
            >
              <Card>
                <p className={eyebrowClass()}>Who It's For</p>
                <h2 className="mt-3 text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
                  This is the simple track
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-text-secondary md:text-base">
                  If you just want a link to share and a commission when someone signs up, this
                  is it. It's a fit for:
                </p>
                <ul className="mt-6 space-y-3">
                  {WHO_FOR.map((item) => (
                    <li key={item} className="flex items-start gap-2.5 text-sm text-text-secondary md:text-base">
                      <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-6 text-sm leading-relaxed text-text-secondary/80">
                  Running an agency, consultancy, or want to white-label Vireek for your own
                  clients? That's a different relationship — see the{' '}
                  <a href="/partners" className="font-semibold text-accent hover:text-accent/80">
                    Partners program
                  </a>{' '}
                  instead.
                </p>
              </Card>
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
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Affiliate Program FAQ</h2>
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
              <Wallet className="mx-auto h-10 w-10 text-white/90" />
              <h2 className="mt-5 text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                Ready to start earning?
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Apply in a couple of minutes and we'll get your referral link set up.
              </p>
              <div className="mt-9 flex justify-center">
                <a href={APPLY_HREF}>
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    Join the Affiliate Program
                    <ArrowRight size={18} />
                  </Button>
                </a>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-white/70">
                <ShieldCheck size={13} className="shrink-0" />
                Free to join. No minimum audience required.
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
