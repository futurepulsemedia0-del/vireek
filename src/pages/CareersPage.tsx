import { motion } from 'framer-motion';
import {
  ArrowRight,
  ShieldCheck,
  Rocket,
  Wrench,
  Heart,
  Globe,
  TrendingUp,
  Users,
  MessageCircle,
  ClipboardCheck,
  Handshake,
  Mail,
  Briefcase,
  MapPin,
  Clock,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

const CAREERS_EMAIL = 'ali@vireek.com';

/**
 * Open roles live here. There are none listed by default — when a real
 * position opens, add an entry to this array; the "Open Roles" section
 * below automatically switches from the empty state to a listed role, no
 * other changes needed.
 *
 * type Role = {
 *   title: string;
 *   department: string;
 *   location: string;
 *   type: string; // e.g. 'Full-time', 'Contract'
 *   description: string;
 *   applyHref?: string; // defaults to a mailto with the role title in the subject
 * };
 */
type Role = {
  title: string;
  department: string;
  location: string;
  type: string;
  description: string;
  applyHref?: string;
};

const OPEN_ROLES: Role[] = [];

const WHY_VIREEK = [
  {
    icon: Rocket,
    title: 'Real Impact From Day One',
    body: 'Vireek is early — every person who joins shapes the product, not just a corner of it. What you ship this week is what contractors use next week.',
  },
  {
    icon: Wrench,
    title: 'Built for One Industry, Done Right',
    body: 'We are not a generic AI wrapper. Everyone here works on a product deeply focused on home-service businesses — HVAC, plumbing, roofing, electrical.',
  },
  {
    icon: ShieldCheck,
    title: 'Radical Transparency',
    body: 'No fake customer counts, no inflated titles, no pretending we are further along than we are. You will always know exactly where the company stands.',
  },
  {
    icon: Handshake,
    title: 'Direct Line to the Founder',
    body: 'A small team means no layers between you and the decisions that matter. Your ideas get heard and shipped, not filtered through five meetings.',
  },
];

const BENEFITS = [
  {
    icon: Globe,
    title: 'Remote-First, Flexible Hours',
    body: 'Work from wherever you are most productive. We care about the work getting done well, not about seat time.',
  },
  {
    icon: TrendingUp,
    title: 'Meaningful Equity',
    body: "Early team members get real ownership. If Vireek wins, the people who built it early win with it.",
  },
  {
    icon: Users,
    title: 'Small Team, Big Trust',
    body: 'You will not be micromanaged. We hire people we trust to own outcomes, then get out of their way.',
  },
  {
    icon: Heart,
    title: 'Work That Matters to Real Businesses',
    body: 'Every feature you build helps an actual contractor stop losing jobs to voicemail. The feedback loop is short and it is real.',
  },
];

const HIRING_STEPS = [
  {
    icon: Mail,
    title: 'Reach Out',
    body: 'Send your background and why you are interested — no rigid application form required.',
  },
  {
    icon: MessageCircle,
    title: 'Intro Conversation',
    body: 'A relaxed, honest call about the role, the product, and what you would actually be working on.',
  },
  {
    icon: ClipboardCheck,
    title: 'Practical Work Session',
    body: 'A short, paid, real-world exercise related to the role — never a whiteboard trivia round.',
  },
  {
    icon: Handshake,
    title: 'Offer',
    body: 'If it is a mutual fit, we move fast. No weeks-long committee process for an early-stage team.',
  },
];

function SEO() {
  useSEO({
    title: 'Careers at Vireek — Join the Team Building AI for Home Services',
    description:
      'Vireek is hiring people who want real ownership and direct impact building the AI voice receptionist for HVAC, plumbing, roofing, and electrical contractors.',
    canonical: 'https://vireek.com/careers',
  });
  return null;
}

function RoleCard({ role }: { role: Role }) {
  const applyHref =
    role.applyHref ?? `mailto:${CAREERS_EMAIL}?subject=${encodeURIComponent(`Application: ${role.title}`)}`;

  return (
    <Card className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
          <Briefcase size={12} />
          {role.department}
        </span>
      </div>
      <h3 className="mt-4 text-xl font-bold text-text-primary">{role.title}</h3>
      <p className="mt-3 flex-1 text-sm leading-relaxed text-text-secondary">{role.description}</p>
      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-text-secondary/80">
        <span className="flex items-center gap-1.5">
          <MapPin size={13} />
          {role.location}
        </span>
        <span className="flex items-center gap-1.5">
          <Clock size={13} />
          {role.type}
        </span>
      </div>
      <a href={applyHref} className="mt-6">
        <Button variant="primary" size="sm" className="w-full">
          Apply
          <ArrowRight size={16} />
        </Button>
      </a>
    </Card>
  );
}

function OpenRolesEmptyState() {
  return (
    <Card className="mx-auto max-w-2xl text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
        <Briefcase size={24} />
      </span>
      <h3 className="mt-5 text-lg font-semibold text-text-primary">No open roles right now</h3>
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-text-secondary">
        We do not have a listed position open at this moment, but we are always interested in
        meeting exceptional people who want to build something real for the trades. Send us a note
        and tell us what you would want to work on.
      </p>
      <a href={`mailto:${CAREERS_EMAIL}?subject=${encodeURIComponent('Introduction')}`} className="mt-6 inline-block">
        <Button variant="secondary" size="md">
          Introduce yourself
          <ArrowRight size={16} />
        </Button>
      </a>
    </Card>
  );
}

export function CareersPage() {
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
              <p className={eyebrowClass()}>Careers</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Help Us Make Sure Contractors Never Miss Another Call
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Vireek is a small, early team building the AI voice receptionist for home-service
                businesses. If you want direct ownership, real impact, and a product that solves a
                problem contractors actually have, we would like to hear from you.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a href="#open-roles">
                  <Button variant="primary" size="lg">
                    View Open Roles
                  </Button>
                </a>
                <a
                  href={`mailto:${CAREERS_EMAIL}?subject=${encodeURIComponent('Introduction')}`}
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  Email us directly
                  <ArrowRight className="h-4 w-4" />
                </a>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Why work here */}
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
                What it is actually like to work here
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                We are not a 500-person company pretending to be scrappy. We are genuinely small,
                and that shapes everything about how we work.
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
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

        {/* Benefits */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>What We Offer</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                How we support the people who build Vireek
              </h2>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
            >
              {BENEFITS.map(({ icon: Icon, title, body }) => (
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

        {/* How we hire */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>How We Hire</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                A short, honest process — not a month of committees
              </h2>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
            >
              {HIRING_STEPS.map(({ icon: Icon, title, body }, index) => (
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

        {/* Open Roles */}
        <section id="open-roles" className="scroll-mt-24 px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Open Roles</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                Current openings at Vireek
              </h2>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
              className="mt-14"
            >
              {OPEN_ROLES.length === 0 ? (
                <OpenRolesEmptyState />
              ) : (
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                  {OPEN_ROLES.map((role) => (
                    <RoleCard key={role.title} role={role} />
                  ))}
                </div>
              )}
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
                Don't see the right role listed?
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                We are growing and roles open up as the product does. Reach out anyway — the best
                hires often happen before a job posting exists.
              </p>
              <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a href={`mailto:${CAREERS_EMAIL}?subject=${encodeURIComponent('Introduction')}`}>
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    Email the team
                    <ArrowRight size={18} />
                  </Button>
                </a>
                <Link
                  to="/about"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white/90 transition-colors hover:text-white"
                >
                  Learn about Vireek
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-white/70">
                <ShieldCheck size={13} className="shrink-0" />
                We reply to every message ourselves.
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
