import { motion } from 'framer-motion';
import {
  ArrowRight,
  Gift,
  Link2,
  Send,
  Users,
  ShieldCheck,
  Sparkles,
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

// This page is the CUSTOMER referral program — for businesses already on
// Vireek who know another contractor who'd benefit. It is intentionally
// separate from:
//  - /affiliate  → external creators/audiences, cash commission, open to anyone
//  - /partners   → agencies/resellers/white-label, a sales-led relationship
// Keep the three distinct rather than merging copy, so each visitor lands
// on the track that actually fits them.

const REFERRAL_EMAIL = 'ali@vireek.com';
const REFERRAL_SUBJECT = 'Customer referral';
const REFERRAL_HREF = `mailto:${REFERRAL_EMAIL}?subject=${encodeURIComponent(REFERRAL_SUBJECT)}`;

const HOW_IT_WORKS = [
  { icon: Send, step: '01', title: 'Tell us who to invite', body: "Send us the contractor's name and contact info, or just introduce them to us directly — however is easiest for you." },
  { icon: Link2, step: '02', title: 'They get a personal link', body: 'Your referral gets a signup link tied to your account, so Vireek always knows the introduction came from you.' },
  { icon: Users, step: '03', title: 'They sign up and go live', body: 'Once they become a paying Vireek customer, the referral is confirmed on both your accounts.' },
  { icon: Gift, step: '04', title: 'You both get rewarded', body: 'Account credit is applied to your subscription once the referral is confirmed — full terms are shared when you refer someone.' },
];

const WHY_ITEMS = [
  { icon: Sparkles, title: 'For customers, not creators', body: 'This track is built for contractors already using Vireek who know another business owner missing calls — not for public audiences or content creators (that\u2019s the Affiliate Program).' },
  { icon: ShieldCheck, title: 'No cap on referrals', body: 'Refer as many contractors as you genuinely think would benefit — there is no limit on how many times you can earn credit.' },
  { icon: CheckCircle2, title: 'Simple to track', body: 'Every referral is tied to your account, so you can always ask our team for a status update on who you\u2019ve referred.' },
];

const FAQ_ITEMS = [
  { q: 'How is this different from the Affiliate Program?', a: 'Affiliate is the public, self-serve track for creators and audiences who earn recurring cash commission. Referral is for existing Vireek customers introducing another contractor, rewarded with account credit rather than a cash payout. If you don\u2019t currently use Vireek, the Affiliate Program is the right page.' },
  { q: 'What do I get for a successful referral?', a: 'Account credit toward your Vireek subscription, applied once your referral becomes a paying customer. Exact amounts are confirmed with you when you submit a referral.' },
  { q: 'Does my friend get anything?', a: 'Yes — new customers who sign up through a referral are also eligible for an incentive, confirmed at signup.' },
  { q: 'How do I refer someone right now?', a: 'Email us the contractor\u2019s details, or have them mention your business name when they sign up or book a demo, so we can credit the referral to your account.' },
  { q: 'Is there a limit on how many people I can refer?', a: 'No — there is no cap. Every confirmed referral is credited.' },
];

function SEO() {
  useSEO({
    title: 'Refer a Contractor, Get Account Credit — Vireek Referral Program',
    description:
      'Already a Vireek customer? Refer another contractor missing calls and earn account credit once they sign up — separate from the public Affiliate Program.',
    canonical: 'https://vireek.com/referral',
  });
  return null;
}

export function ReferralPage() {
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
              <p className={eyebrowClass()}>Referral Program</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Know a Contractor Missing Calls? Send Them Our Way.
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                You're already a Vireek customer — refer another business owner and earn account
                credit once they sign up. Built for customers, not for public audiences.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a href={REFERRAL_HREF}>
                  <Button variant="primary" size="lg">
                    Refer a contractor <ArrowRight size={18} />
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
                For existing Vireek customers. Looking to earn cash commission instead?{' '}
                <a href="/affiliate" className="font-semibold text-accent hover:text-accent/80">
                  See the Affiliate Program
                </a>
                .
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
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Four steps, no paperwork</h2>
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

        {/* Why */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Why It's Worth It</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Built for people already on Vireek</h2>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-3"
            >
              {WHY_ITEMS.map(({ icon: Icon, title, body }) => (
                <motion.div key={title} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="h-full">
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                      <Icon size={20} />
                    </span>
                    <h3 className="mt-5 text-base font-semibold text-text-primary">{title}</h3>
                    <p className="mt-2.5 text-sm leading-relaxed text-text-secondary">{body}</p>
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
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Referral Program FAQ</h2>
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
              <Gift className="mx-auto h-10 w-10 text-white/90" />
              <h2 className="mt-5 text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                Send the referral, earn the credit
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Takes two minutes. We'll confirm your reward once your referral goes live.
              </p>
              <div className="mt-9 flex justify-center">
                <a href={REFERRAL_HREF}>
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    Refer a contractor <ArrowRight size={18} />
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
