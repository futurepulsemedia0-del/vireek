import { motion } from 'framer-motion';
import {
  ArrowRight,
  ShieldCheck,
  Eye,
  Users,
  Handshake,
  Globe,
  Scale,
  Accessibility,
  Cloud,
  Leaf,
  Recycle,
  Mail,
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

const CONTACT_EMAIL = 'ali@vireek.com';

const HOW_WE_WORK = [
  {
    icon: Users,
    title: 'Ownership, Not Oversight',
    body: 'Everyone who works on Vireek owns real outcomes, not tasks handed down from a manager. We hire people we trust, then get out of their way.',
  },
  {
    icon: Handshake,
    title: 'No Layers, No Bureaucracy',
    body: 'Vireek is a small, early-stage team. Decisions get made in a conversation, not a committee, and there is a direct line to the founder on anything that matters.',
  },
  {
    icon: Eye,
    title: 'Radical Transparency',
    body: 'Internally and externally, we say where things actually stand — no inflated numbers, no pretending we are further along than we are.',
  },
  {
    icon: Globe,
    title: 'Remote-First, Outcome-Focused',
    body: 'We care about the work getting done well, not about seat time or time zone. People work from wherever they are most effective.',
  },
];

const DEI_COMMITMENTS = [
  {
    icon: Scale,
    title: 'Fair, Consistent Hiring',
    body: 'Every candidate for a given role is evaluated against the same criteria, tied to the actual work — not pedigree, background, or who they know.',
  },
  {
    icon: Globe,
    title: 'Open to the World',
    body: 'Vireek is remote-first by design, which means we hire based on ability, not geography. Great people are not confined to one city or country.',
  },
  {
    icon: Accessibility,
    title: 'Built for Everyone',
    body: (
      <>
        Our commitment to inclusion extends to the product itself. See our{' '}
        <Link to="/accessibility" className="font-semibold text-accent underline underline-offset-2">
          accessibility commitments
        </Link>{' '}
        for how Vireek is built to work for people with different needs.
      </>
    ),
  },
  {
    icon: ShieldCheck,
    title: 'Zero Tolerance for Discrimination',
    body: 'Vireek does not discriminate on the basis of race, color, religion, sex, national origin, age, disability, sexual orientation, gender identity, or any other protected status — in hiring or in how we treat customers.',
  },
];

const SUSTAINABILITY_COMMITMENTS = [
  {
    icon: Cloud,
    title: 'Cloud-Native, Not Data-Center Heavy',
    body: 'Vireek runs on modern, serverless infrastructure rather than servers we own and operate ourselves. Our hosting and database providers run on major cloud platforms that have made public, long-term commitments to renewable-powered infrastructure.',
  },
  {
    icon: Leaf,
    title: 'A Small Footprint by Design',
    body: 'Being remote-first means no office to heat, cool, or commute to. Being a lean, early-stage team means our day-to-day footprint is small — and we intend to keep it that way as we grow.',
  },
  {
    icon: Recycle,
    title: 'Paperless by Default',
    body: 'Contracts, documentation, onboarding, and internal operations are digital-first. We are not printing what does not need to be printed.',
  },
  {
    icon: ShieldCheck,
    title: 'Accountable as We Scale',
    body: 'As Vireek grows, we will keep favoring infrastructure providers and hosting regions with credible, verifiable sustainability practices, and we will keep this page current as those choices evolve.',
  },
];

function SEO() {
  useSEO({
    title: 'Culture, Diversity & Sustainability at Vireek',
    description:
      'How Vireek works, our commitment to diversity, equity, and inclusion, and the sustainability principles behind the infrastructure we build on.',
    canonical: 'https://vireek.com/culture',
  });
  return null;
}

export function CulturePage() {
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
              <p className={eyebrowClass()}>Culture, DEI &amp; Sustainability</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                How We Work, Who We Include, and What We Owe the Planet
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Vireek is a small, early-stage team. That shapes how we work, who gets to join us,
                and how seriously we take the footprint of the infrastructure we build on. This
                page is our honest account of all three — not a polished statement written once
                and forgotten.
              </p>
            </motion.div>
          </div>
        </section>

        {/* How We Work */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>How We Work</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                The culture behind the product
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                We are not a 500-person company pretending to be scrappy. We are genuinely small,
                and that shapes everything about how we operate.
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
            >
              {HOW_WE_WORK.map(({ icon: Icon, title, body }) => (
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

        {/* Diversity, Equity & Inclusion */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
            >
              <p className={eyebrowClass()}>Diversity, Equity &amp; Inclusion</p>
              <h2 className={`${sectionHeadingClass()} mt-3`}>Our commitment</h2>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
              className="mt-8 space-y-6 text-lg leading-8 text-text-secondary"
            >
              <p>
                Vireek is small today, and we are not going to pretend otherwise or point to a
                diversity report full of numbers we do not have yet. What we can commit to is how
                we build the team from here: every role is evaluated on the same criteria for
                every candidate, every candidate is judged on their ability to do the work, and
                geography, background, and identity are never a reason to say no.
              </p>
              <p>
                That commitment extends past hiring. It shapes a product that needs to work for
                the contractor running a one-truck operation just as well as it works for a
                50-person shop, and for customers calling in with every kind of need — including
                accessibility needs. It also means a workplace where nobody has to hide who they
                are to be taken seriously.
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-12 grid gap-6 sm:grid-cols-2"
            >
              {DEI_COMMITMENTS.map(({ icon: Icon, title, body }) => (
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

        {/* Sustainability */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
            >
              <p className={eyebrowClass()}>Sustainability</p>
              <h2 className={`${sectionHeadingClass()} mt-3`}>The footprint behind the product</h2>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
              className="mt-8 space-y-6 text-lg leading-8 text-text-secondary"
            >
              <p>
                Vireek does not own or run physical servers. We run on managed, serverless cloud
                infrastructure — our hosting and database providers operate on top of major cloud
                platforms that have made public, long-term commitments to powering their
                infrastructure with renewable energy. Choosing that kind of infrastructure, rather
                than standing up our own data center, is itself a sustainability decision.
              </p>
              <p>
                Beyond hosting, we keep our own footprint small on purpose: a remote-first team
                with no office to power, and digital-first operations with no unnecessary paper
                trail. We are early-stage, so this is not a fully audited carbon program — it is
                an honest set of choices we intend to keep making as the company grows, and we
                will update this page as our infrastructure and practices evolve.
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-12 grid gap-6 sm:grid-cols-2"
            >
              {SUSTAINABILITY_COMMITMENTS.map(({ icon: Icon, title, body }) => (
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
                Questions about how we work?
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Whether you are considering joining the team or just want to know more about how
                Vireek operates, we are glad to talk about it directly.
              </p>
              <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Question about Vireek culture')}`}>
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    Email the team
                    <ArrowRight size={18} />
                  </Button>
                </a>
                <Link
                  to="/careers"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white/90 transition-colors hover:text-white"
                >
                  See open roles
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-white/70">
                <Mail size={13} className="shrink-0" />
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
