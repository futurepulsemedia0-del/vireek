import { motion } from 'framer-motion';
import {
  ArrowRight,
  ShieldCheck,
  PhoneCall,
  Brain,
  PhoneForwarded,
  UserPlus,
  CalendarClock,
  MessageSquareText,
  MessageCircle,
  Database,
  BarChart3,
  Boxes,
  Zap,
  type LucideIcon,
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

type Feature = {
  icon: LucideIcon;
  title: string;
  body: string;
  href?: string;
};

type Category = {
  icon: LucideIcon;
  label: string;
  tagline: string;
  features: Feature[];
};

const CATEGORIES: Category[] = [
  {
    icon: PhoneCall,
    label: 'Call Intelligence',
    tagline: 'Every call answered, understood, and scored.',
    features: [
      { icon: PhoneCall, title: '24/7 AI Answering', body: 'Sarah picks up every call, day or night, so no lead ever hits voicemail.' },
      { icon: Brain, title: 'Call Summaries', body: 'A clean recap of every conversation lands in your inbox and CRM automatically.' },
      { icon: Brain, title: 'Intent Detection', body: 'Sarah detects what the caller needs and routes the conversation accordingly.' },
      { icon: PhoneForwarded, title: 'Live Escalation', body: 'Sarah brings a real team member into a call — warm transfer with full context, or live barge-in.', href: '/features/live-escalation' },
    ],
  },
  {
    icon: UserPlus,
    label: 'Lead Management',
    tagline: 'From first call to qualified lead — automatically.',
    features: [
      { icon: UserPlus, title: 'Customer Capture', body: 'Every caller\u2019s name, number, and issue is logged the moment they reach out.' },
      { icon: UserPlus, title: 'Lead Qualification', body: 'Sarah asks trade-relevant questions to separate routine service from urgent issues.', href: '/features/lead-qualification' },
      { icon: UserPlus, title: 'Deduplication', body: 'Repeat callers are recognized and their profile enriched — no manual data entry.' },
    ],
  },
  {
    icon: CalendarClock,
    label: 'Scheduling',
    tagline: 'From "hello" to a confirmed slot on the calendar.',
    features: [
      { icon: CalendarClock, title: 'Smart Booking', body: 'Sarah checks your calendar and books the appointment before the caller hangs up.' },
      { icon: CalendarClock, title: 'Google Calendar Sync', body: 'Booked slots sync live to your Google Calendar with no double-booking.' },
      { icon: CalendarClock, title: 'Reschedule Handling', body: 'Customer texts "reschedule," Sarah offers new slots, and the booking updates itself.' },
    ],
  },
  {
    icon: MessageSquareText,
    label: 'Customer Communication',
    tagline: 'Every interaction confirmed and followed up.',
    features: [
      { icon: MessageSquareText, title: 'SMS Confirmations', body: 'Customers get an instant text confirming the time, address, and details.' },
      { icon: MessageSquareText, title: 'Appointment Reminders', body: '24-hour and 1-hour heads-up texts reduce no-shows automatically.' },
      { icon: MessageSquareText, title: 'Missed-Call Text-Back', body: 'A missed call gets an instant "sorry we missed you" text with a booking link.', href: '/features/sms-text-back' },
      { icon: MessageCircle, title: 'WhatsApp & Instagram DMs', body: 'Sarah answers WhatsApp messages and Instagram DMs instantly, qualifies the lead, and books the job.', href: '/features/whatsapp-instagram-dm' },
    ],
  },
  {
    icon: Database,
    label: 'CRM',
    tagline: 'Your customer data, synced everywhere.',
    features: [
      { icon: Database, title: 'CRM Sync', body: 'Call details, lead info, and bookings sync to ServiceTitan, Housecall Pro, and Jobber.' },
      { icon: Database, title: 'Knowledge Base Sync', body: 'Any update to your business info is pushed straight into Sarah\u2019s live prompt.' },
      { icon: Database, title: 'Unified Inbox', body: 'Facebook, Angi, Thumbtack, and Google chat all land in one thread.' },
    ],
  },
  {
    icon: BarChart3,
    label: 'Analytics',
    tagline: 'Know what happens on every call.',
    features: [
      { icon: BarChart3, title: 'Call Analytics', body: 'See call volume, outcomes, lead scores, and booking rates in real time.' },
      { icon: BarChart3, title: 'Sentiment Scoring', body: 'Every call is scored for sentiment, with alerts on negative interactions.' },
      { icon: BarChart3, title: 'Call QA', body: 'Daily random calls are graded on professionalism, empathy, and accuracy.' },
    ],
  },
  {
    icon: Boxes,
    label: 'Operations',
    tagline: 'What keeps the business running behind the scenes.',
    features: [
      { icon: Boxes, title: 'Multi-Location', body: 'Every new location gets its own workspace, technician roster, and isolated analytics.' },
      { icon: Boxes, title: 'Dynamic Dispatch', body: 'Matches the right technician by skill, truck stock, and live GPS.' },
      { icon: Boxes, title: 'Parts Intelligence', body: 'Checks truck inventory before dispatch and auto-orders missing parts.' },
    ],
  },
  {
    icon: Zap,
    label: 'Automation',
    tagline: 'Workflows that run themselves.',
    features: [
      { icon: Zap, title: 'Follow-Up Engine', body: 'Quotes that go quiet for 3 days get an automatic, friendly nudge by email and SMS.' },
      { icon: Zap, title: 'Review Generation', body: 'Two hours after job completion, a review link goes out automatically.' },
      { icon: Zap, title: 'Abandoned Call Recovery', body: 'A missed call gets a text 15 minutes later with an incentive to book today.' },
    ],
  },
];

export function FeaturesPage() {
  useSEO({
    title: 'Features — AI Call Intelligence, Booking, CRM & More | Vireek',
    description: 'Explore every Vireek feature: 24/7 AI answering, lead qualification, smart booking, SMS confirmations, CRM sync, call analytics, multi-location operations, and automated follow-up.',
    canonical: 'https://vireek.com/features',
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
              <p className={eyebrowClass()}>Features</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Everything Sarah Handles So You Don&rsquo;t Have To
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Eight capability areas covering the full customer call — from the first ring
                to the booked job and beyond.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/login">
                  <Button variant="primary" size="lg">Start Free Trial</Button>
                </Link>
                <Link
                  to="/platform"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  Explore the platform
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Feature categories */}
        {CATEGORIES.map((cat, catIndex) => (
          <section
            key={cat.label}
            className={catIndex % 2 === 1 ? 'px-6 py-20 sm:py-24 bg-bg-tertiary/50' : 'px-6 py-20 sm:py-24'}
          >
            <div className="mx-auto max-w-7xl">
              <motion.div
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.5, ease: EASE }}
                className="max-w-2xl"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
                  <cat.icon size={24} />
                </span>
                <h2 className={`${sectionHeadingClass()} mt-5`}>{cat.label}</h2>
                <p className={`${bodyClass()}`}>{cat.tagline}</p>
              </motion.div>

              <motion.div
                variants={staggerContainer}
                initial="initial"
                whileInView="whileInView"
                viewport={viewport}
                className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
              >
                {cat.features.map((feature) => {
                  const cardContent = (
                    <Card className="h-full transition-all duration-300 group-hover:-translate-y-0.5 group-hover:border-accent/25">
                      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                        <feature.icon size={19} />
                      </span>
                      <h3 className="mt-4 text-base font-semibold text-text-primary">{feature.title}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-text-secondary">{feature.body}</p>
                      {feature.href && (
                        <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-accent">
                          Learn more <ArrowRight className="h-3.5 w-3.5" />
                        </span>
                      )}
                    </Card>
                  );

                  return (
                    <motion.div key={feature.title} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                      {feature.href ? (
                        <Link to={feature.href} className="focus-ring group block h-full rounded-2xl">
                          {cardContent}
                        </Link>
                      ) : (
                        cardContent
                      )}
                    </motion.div>
                  );
                })}
              </motion.div>
            </div>
          </section>
        ))}

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
                Vireek doesn&rsquo;t just answer your phone
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                It turns every customer call into a handled business opportunity.
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
