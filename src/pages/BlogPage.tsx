import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  PhoneMissed,
  Siren,
  Wrench,
  TrendingUp,
  ArrowRight,
  BookOpen,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

// ============================================================
// CONTENT
// ============================================================
// Titles are Vireek's own upcoming editorial roadmap — grounded in what
// the product actually does (call answering, triage, booking for home
// service trades), not generic marketing filler. No fabricated dates,
// authors, or read counts: in line with the "radical transparency"
// value stated on /about, this reads as a roadmap, not a claim that
// these already exist and have traction.

type Category = 'All' | 'Missed Calls' | 'Emergency Response' | 'Industry Playbooks' | 'Growth & ROI';

const CATEGORIES: { key: Category; icon: typeof PhoneMissed }[] = [
  { key: 'All', icon: BookOpen },
  { key: 'Missed Calls', icon: PhoneMissed },
  { key: 'Emergency Response', icon: Siren },
  { key: 'Industry Playbooks', icon: Wrench },
  { key: 'Growth & ROI', icon: TrendingUp },
];

interface Post {
  title: string;
  excerpt: string;
  category: Exclude<Category, 'All'>;
}

const POSTS: Post[] = [
  {
    title: 'Why Home Service Businesses Lose Calls to Voicemail — And What It Actually Costs',
    excerpt:
      'A plain-language breakdown of what happens on the other end of an unanswered call, and why the caller rarely tries again.',
    category: 'Missed Calls',
  },
  {
    title: "AI Receptionist vs. Traditional Answering Service: What's Actually Different",
    excerpt:
      'Call scripts, escalation logic, and integration with your calendar — where the two approaches genuinely diverge for a trades business.',
    category: 'Missed Calls',
  },
  {
    title: "Why 'We'll Call You Back' Loses the Job Before You Ever Call Back",
    excerpt:
      'What homeowners do in the fifteen minutes after they hang up, and why the first business to answer usually wins the work.',
    category: 'Missed Calls',
  },
  {
    title: 'How to Triage Emergency Calls Without a 24/7 Dispatcher on Payroll',
    excerpt:
      'A practical look at building escalation rules that separate a true no-heat or active-leak emergency from a routine request.',
    category: 'Emergency Response',
  },
  {
    title: 'Building an Escalation Rule Set: Emergency vs. Routine, Explained',
    excerpt:
      'The specific signals worth training your call handling around, and how to avoid both over- and under-escalating.',
    category: 'Emergency Response',
  },
  {
    title: 'What Homeowners Actually Expect When They Call a Plumber After Hours',
    excerpt:
      'What a caller with an active leak wants to hear in the first ten seconds — and what makes them hang up.',
    category: 'Emergency Response',
  },
  {
    title: '5 Questions Every HVAC Call Should Ask Before Booking a Truck Roll',
    excerpt:
      'System type, symptoms, and duration — the intake questions that save a wasted visit without frustrating the caller.',
    category: 'Industry Playbooks',
  },
  {
    title: 'Storm Season, Slammed Phones: A Call-Handling Playbook for Roofers',
    excerpt:
      'How roofing companies can handle a sudden spike in calls after a storm without every one of them going to voicemail.',
    category: 'Industry Playbooks',
  },
  {
    title: 'Locksmith Calls Are Different: Designing Intake Around Urgency and Trust',
    excerpt:
      'Verifying a legitimate lockout call quickly, and why locksmith intake scripts need their own logic.',
    category: 'Industry Playbooks',
  },
  {
    title: 'The Real Difference Between a Call Center and an AI Voice Receptionist',
    excerpt:
      'Cost, consistency, and how each one actually handles an industry-specific term it has never heard before.',
    category: 'Growth & ROI',
  },
  {
    title: 'From Ringing Phone to Booked Job: Mapping the Full After-Hours Call Journey',
    excerpt:
      'Every step between a first ring and a confirmed appointment on the calendar, and where most of it quietly breaks down.',
    category: 'Growth & ROI',
  },
  {
    title: 'How Answering One More Call a Week Pays for a Front-Desk Tool',
    excerpt:
      'A simple way to think about the math, using your own average job value instead of an industry-wide average.',
    category: 'Growth & ROI',
  },
];

function SEO() {
  useSEO({
    title: 'Blog — Vireek | Call Handling for Home Service Businesses',
    description:
      'Practical guides on call answering, emergency triage, and booking more jobs — written for HVAC, plumbing, electrical, roofing, restoration, and locksmith businesses.',
    canonical: 'https://vireek.com/blog',
  });
  return null;
}

function PostCard({ post, index }: { post: Post; index: number }) {
  return (
    <motion.div variants={fadeUpItem} transition={{ duration: 0.5, ease: EASE, delay: index * 0.03 }}>
      <Card className="flex h-full flex-col justify-between hover:-translate-y-1">
        <div>
          <span className="inline-flex items-center rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
            {post.category}
          </span>
          <h3 className="mt-4 text-lg font-semibold leading-snug tracking-tight text-text-primary">
            {post.title}
          </h3>
          <p className="mt-2.5 text-sm leading-relaxed text-text-secondary">{post.excerpt}</p>
        </div>
        <span className="mt-5 inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-text-secondary/60">
          In progress
        </span>
      </Card>
    </motion.div>
  );
}

export function BlogPage() {
  const [active, setActive] = useState<Category>('All');

  const filtered = useMemo(
    () => (active === 'All' ? POSTS : POSTS.filter((p) => p.category === active)),
    [active]
  );

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="relative mx-auto max-w-3xl text-center">
            <div className="mb-6 text-left">
              <BackButton />
            </div>
            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: EASE }}
              className={eyebrowClass()}
            >
              Blog
            </motion.p>
            <motion.h1
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: EASE, delay: 0.05 }}
              className={sectionHeadingClass()}
            >
              Straight talk for teams who can't afford a missed call
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: EASE, delay: 0.1 }}
              className={`${bodyClass()} mx-auto max-w-xl`}
            >
              We're building out Vireek's library of guides on call answering, emergency triage,
              and booking more jobs. Here's what's coming first.
            </motion.p>
          </div>
        </section>

        {/* Category filter */}
        <section className="mx-auto max-w-6xl px-6">
          <div className="flex flex-wrap justify-center gap-2 border-b border-border pb-8">
            {CATEGORIES.map(({ key, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setActive(key)}
                aria-pressed={active === key}
                className={`focus-ring flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition-all duration-200 ${
                  active === key
                    ? 'border-accent bg-accent text-white shadow-glow-accent'
                    : 'border-border bg-bg-secondary text-text-secondary hover:border-accent/30 hover:text-text-primary'
                }`}
              >
                <Icon size={15} />
                {key}
              </button>
            ))}
          </div>
        </section>

        {/* Post grid */}
        <section className="mx-auto max-w-6xl px-6 py-16">
          <motion.div
            key={active}
            variants={staggerContainer}
            initial="initial"
            whileInView="whileInView"
            viewport={viewport}
            className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
          >
            {filtered.map((post, i) => (
              <PostCard key={post.title} post={post} index={i} />
            ))}
          </motion.div>
        </section>

        {/* CTA */}
        <section className="mx-auto max-w-6xl px-6 pb-24">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-bg-secondary px-8 py-12 text-center"
          >
            <h2 className="text-xl font-semibold tracking-tight text-text-primary sm:text-2xl">
              Want new guides in your inbox?
            </h2>
            <p className="max-w-md text-sm leading-relaxed text-text-secondary">
              Subscribe below and we'll let you know as soon as each one is published.
            </p>
            <a
              href="#newsletter"
              className="focus-ring group mt-2 inline-flex items-center gap-2 rounded-xl bg-accent px-6 py-3 text-sm font-semibold text-white shadow-glow-accent transition-all hover:brightness-110"
            >
              Go to newsletter signup
              <ArrowRight size={16} className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </a>
          </motion.div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
