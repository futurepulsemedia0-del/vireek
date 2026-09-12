import { motion } from 'framer-motion';
import {
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  Globe2,
  Image as ImageIcon,
  Inbox,
  MessageCircle,
  Zap,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { Card } from '@/components/ui/Card';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

// ============================================================
// CONTENT
// ============================================================
// Standalone deep-dive for "WhatsApp / Instagram DM Handling", extending
// Sarah beyond voice calls into the messaging channels customers already
// use. Follows the same pattern as SmsTextBackPage.tsx and
// LeadQualificationPage.tsx.

const WHAT_IT_DOES = [
  {
    icon: MessageCircle,
    title: 'Replies within seconds',
    body: 'A WhatsApp message or Instagram DM gets an instant, on-brand reply from Sarah — no customer waits hours for someone to check the inbox.',
  },
  {
    icon: Inbox,
    title: 'One inbox, every channel',
    body: 'Voice calls, WhatsApp, and Instagram DMs all land in the same Vireek lead inbox — nothing lives in a separate app your team has to check.',
  },
  {
    icon: ImageIcon,
    title: 'Understands photos, not just text',
    body: 'Customers can send a photo of the leaking pipe or the cracked panel — Sarah reads the context and asks the right follow-up question.',
  },
  {
    icon: Zap,
    title: 'Qualifies and books, not just chats',
    body: 'The same qualification logic Sarah uses on calls applies to DMs — urgency, service type, and address are captured before a human ever steps in.',
  },
  {
    icon: Globe2,
    title: 'Multilingual by default',
    body: 'A DM in Spanish gets a Spanish reply automatically, using the same language engine that powers Sarah\u2019s voice conversations.',
  },
  {
    icon: BadgeCheck,
    title: 'Logged to the same lead record',
    body: 'If a customer called last month and DMs today, Sarah recognizes them — the conversation adds to their existing history, not a new disconnected thread.',
  },
];

const STEPS = [
  {
    title: 'A message comes in',
    detail: 'A customer messages your WhatsApp Business number or Instagram profile instead of calling.',
  },
  {
    title: 'Sarah reads and replies instantly',
    detail: 'She answers questions, asks qualifying follow-ups, and can share photos, pricing ranges, or a booking link.',
  },
  {
    title: 'The lead is captured and booked',
    detail: 'Details sync to your dashboard and CRM, and the customer can be booked directly in the conversation.',
  },
];

const FAQ = [
  {
    q: 'Do I need a separate WhatsApp Business number?',
    a: 'You can connect an existing WhatsApp Business number or set up a new one during onboarding — either way, it plugs into the same Sarah that answers your calls.',
  },
  {
    q: 'Does this replace my Instagram inbox app?',
    a: 'It replaces the need to check it manually. Instagram DMs still arrive on Instagram, but Sarah drafts and sends replies automatically and every conversation is mirrored in your Vireek dashboard.',
  },
  {
    q: 'What happens with messages that need a human?',
    a: 'Sarah flags anything outside her scope — a complaint, a pricing negotiation, an unusual request — and hands it to your team with the full conversation already summarized.',
  },
  {
    q: 'Can customers book an appointment directly inside the chat?',
    a: 'Yes. Sarah can send a booking link or, where supported, complete the booking inside the conversation itself, checking your live calendar the same way she does on a call.',
  },
];

function WhatsAppInstagramDMSEO() {
  useSEO({
    title: 'WhatsApp & Instagram DM Handling — Vireek',
    description:
      'Sarah answers WhatsApp messages and Instagram DMs instantly, qualifies the lead, and books the job — the same intelligence that powers your phone line, extended to messaging.',
    canonical: 'https://vireek.com/features/whatsapp-instagram-dm',
  });
  return null;
}

export function WhatsAppInstagramDMPage() {
  return (
    <>
      <WhatsAppInstagramDMSEO />
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
              <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <MessageCircle className="h-4 w-4 text-accent" />
                Customer Communication
              </div>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                WhatsApp &amp; Instagram DM Handling
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Not every customer wants to call. Sarah answers WhatsApp messages and Instagram DMs with the same
                speed, qualification, and booking logic she uses on the phone.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/login">
                  <Button variant="primary" size="lg">
                    Start Free Trial
                  </Button>
                </Link>
                <Link
                  to="/features"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  All features <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* What it does */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={eyebrowClass()}>What It Does</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>Every channel, one Sarah</h2>
              <p className={bodyClass()}>
                Customers message the way they already prefer — Sarah meets them there instead of forcing a phone call.
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
            >
              {WHAT_IT_DOES.map((item) => (
                <motion.div key={item.title} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="h-full">
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                      <item.icon size={19} />
                    </span>
                    <h3 className="mt-4 text-base font-semibold text-text-primary">{item.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">{item.body}</p>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* How it works */}
        <section className="bg-bg-tertiary/50 px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>How It Works</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>From a DM to a booked job</h2>
            </motion.div>

            <div className="mt-12 grid gap-6 sm:grid-cols-3">
              {STEPS.map((step, i) => (
                <motion.div
                  key={step.title}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.4, delay: i * 0.08, ease: EASE }}
                  className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/10 text-sm font-bold text-accent">
                    {i + 1}
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-text-primary">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{step.detail}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>FAQ</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>Questions about DM handling</h2>
            </motion.div>

            <div className="mt-10 space-y-4">
              {FAQ.map((item) => (
                <motion.div
                  key={item.q}
                  initial={{ opacity: 0, y: 12 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.4, ease: EASE }}
                  className="rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark"
                >
                  <h3 className="flex items-start gap-2.5 text-base font-semibold text-text-primary">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                    {item.q}
                  </h3>
                  <p className="mt-2 pl-6.5 text-sm leading-relaxed text-text-secondary">{item.a}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Related */}
        <section className="px-6 pb-4">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-3 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
          >
            <span className="text-sm font-semibold text-text-primary">Keep exploring:</span>
            <Link
              to="/features"
              className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-3.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary"
            >
              All Features
            </Link>
            <Link
              to="/features/sms-text-back"
              className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-3.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary"
            >
              SMS Text-Back
            </Link>
            <Link
              to="/features/lead-qualification"
              className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-3.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary"
            >
              Lead Qualification
            </Link>
            <Link
              to="/integrations"
              className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-3.5 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary"
            >
              Integrations
            </Link>
          </motion.div>
        </section>

        {/* Final CTA */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Beyond the phone line</p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Meet your customers on WhatsApp and Instagram too
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary">
              Every channel feeds the same lead inbox — no new app to check, no lead left on read.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link to="/login">
                <Button variant="primary" size="lg">
                  Start Free Trial <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <Link
                to="/demo"
                className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
              >
                Book a demo <ArrowRight className="h-4 w-4" />
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
