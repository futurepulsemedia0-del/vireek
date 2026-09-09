import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import {
  MonitorSmartphone,
  Wifi,
  PhoneForwarded,
  Chrome,
  Globe2,
  Smartphone,
  Plug,
  Calculator,
  Calendar,
  CreditCard,
  Zap,
  CheckCircle2,
  XCircle,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useSEO } from '@/lib/seo';
import { EASE, eyebrowClass, sectionHeadingClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

// ============================================================
// CONTENT
// ============================================================
// Vireek runs entirely in the browser and answers calls that are forwarded
// from a business's existing phone line. There is no hardware, PBX, or app
// to install. Keep every claim below aligned with that reality — see
// OnboardingGuidePage / HelpCenterPage / IntegrationsHubPage for the source
// of truth on call forwarding and integrations.

const CORE_REQUIREMENTS = [
  {
    icon: Wifi,
    title: 'An internet connection',
    body: 'The Vireek dashboard runs entirely online. Any stable broadband or mobile connection is enough \u2014 there\u2019s no local software to keep updated.',
  },
  {
    icon: MonitorSmartphone,
    title: 'A modern web browser',
    body: 'No app to install. Sign in from the browser you already use on a desktop, laptop, tablet, or phone, and your dashboard is ready.',
  },
  {
    icon: PhoneForwarded,
    title: 'A phone line that supports call forwarding',
    body: 'Keep the number your customers already call. Forward it \u2014 all calls, after-hours only, or overflow when you\u2019re busy \u2014 to the number Vireek gives you.',
  },
  {
    icon: Globe2,
    title: 'An email address for your team',
    body: 'Used to sign in, receive lead and job notifications, and invite teammates with the right role-based permissions.',
  },
];

const BROWSERS = [
  { name: 'Google Chrome', note: 'Recommended, latest version', icon: Chrome },
  { name: 'Safari', note: 'macOS and iOS, latest version', icon: Globe2 },
  { name: 'Microsoft Edge', note: 'Latest version', icon: Globe2 },
  { name: 'Mozilla Firefox', note: 'Latest version', icon: Globe2 },
];

const DEVICES = [
  {
    icon: MonitorSmartphone,
    title: 'Desktop & laptop',
    body: 'Windows, macOS, ChromeOS, or Linux \u2014 anything that runs a modern browser runs the full Vireek dashboard.',
  },
  {
    icon: Smartphone,
    title: 'Phone & tablet',
    body: 'The dashboard is fully responsive, so you can check calls, leads, and jobs from your phone\u2019s browser between visits. No native app download required.',
  },
];

const PHONE_COMPATIBILITY = [
  'Any US or Canadian business number \u2014 landline, VoIP, or mobile \u2014 that your carrier lets you forward.',
  'Conditional forwarding (after-hours or busy/no-answer only) as well as forwarding every call.',
  'Multi-line and call-center setups, configured with your account manager.',
];

const PHONE_NOT_NEEDED = [
  'No new phone number to give out \u2014 customers keep dialing the number they already know.',
  'No PBX, SIP trunk, or on-site phone hardware to install or maintain.',
  'No porting your number away from your existing carrier.',
];

const INTEGRATIONS_COMPAT = [
  {
    icon: Calculator,
    name: 'QuickBooks',
    requirement: 'Requires a QuickBooks Online account.',
    href: '/integrations/quickbooks',
  },
  {
    icon: Calendar,
    name: 'Google Calendar',
    requirement: 'Requires a Google account with Calendar enabled.',
    href: '/integrations/google-calendar',
  },
  {
    icon: CreditCard,
    name: 'Stripe',
    requirement: 'Used automatically for billing \u2014 no separate account needed to get started.',
    href: '/integrations/stripe',
  },
  {
    icon: Zap,
    name: 'Zapier',
    requirement: 'Requires a Zapier account to build your own automations.',
    href: '/integrations/zapier',
  },
];

function AnimatedSection({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={viewport}
      transition={{ duration: 0.5, ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function SystemRequirementsPage() {
  useSEO({
    title: 'System Requirements & Compatibility | Vireek',
    description:
      'What you need to run Vireek: a modern browser, an internet connection, and a phone line that supports call forwarding. No hardware, PBX, or app to install.',
    canonical: 'https://vireek.com/system-requirements',
  });

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-20 sm:pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-5 py-16 sm:px-6 sm:py-20 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl text-center">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-3 py-1.5 text-xs font-semibold text-text-secondary shadow-sm backdrop-blur sm:mb-6 sm:px-4 sm:text-sm">
                <MonitorSmartphone className="h-4 w-4 text-accent" />
                System Requirements
              </div>
              <h1 className="text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl lg:text-6xl">
                System Requirements & Compatibility
              </h1>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary sm:mt-6 sm:text-lg sm:leading-8 lg:text-xl">
                Vireek is a browser-based platform that answers calls forwarded from your existing
                phone line. No hardware, no PBX, and nothing to install \u2014 here\u2019s exactly what
                you need to get started.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:mt-10 sm:flex-row sm:gap-4">
                <Link to="/login" className="w-full sm:w-auto">
                  <Button variant="primary" size="lg" className="w-full sm:w-auto">
                    Start Free Trial
                  </Button>
                </Link>
                <Link
                  to="/help"
                  className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent sm:w-auto"
                >
                  Visit the Help Center <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Core requirements */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-6xl">
            <AnimatedSection className="text-center">
              <p className={eyebrowClass()}>What You Need</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>Four things, and you&apos;re live</h2>
            </AnimatedSection>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-8 grid gap-5 sm:mt-12 sm:grid-cols-2"
            >
              {CORE_REQUIREMENTS.map(({ icon: Icon, title, body }) => (
                <motion.div key={title} variants={fadeUpItem} transition={{ duration: 0.45, ease: EASE }}>
                  <Card className="h-full">
                    <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                      <Icon size={20} />
                    </span>
                    <h3 className="mt-4 text-lg font-semibold text-text-primary">{title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">{body}</p>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Browsers & devices */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-6xl">
            <AnimatedSection className="text-center">
              <p className={eyebrowClass()}>Dashboard Access</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>Supported browsers & devices</h2>
              <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-text-secondary sm:text-base">
                Vireek is a web app, not a download. It works on the current and previous major
                release of every browser below, on any device.
              </p>
            </AnimatedSection>

            <div className="mt-10 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
              <AnimatedSection>
                <Card className="h-full">
                  <h3 className="text-base font-semibold text-text-primary">Browsers</h3>
                  <ul className="mt-4 space-y-3">
                    {BROWSERS.map(({ name, note, icon: Icon }) => (
                      <li key={name} className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                          <Icon size={16} />
                        </span>
                        <div>
                          <p className="text-sm font-semibold text-text-primary">{name}</p>
                          <p className="text-xs text-text-secondary">{note}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>
              </AnimatedSection>

              <div className="grid gap-5">
                {DEVICES.map(({ icon: Icon, title, body }) => (
                  <AnimatedSection key={title}>
                    <Card className="h-full">
                      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                        <Icon size={20} />
                      </span>
                      <h3 className="mt-4 text-base font-semibold text-text-primary">{title}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-text-secondary">{body}</p>
                    </Card>
                  </AnimatedSection>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Phone compatibility */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-5xl">
            <AnimatedSection className="text-center">
              <p className={eyebrowClass()}>Phone Compatibility</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>Works with the phone line you already have</h2>
              <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-text-secondary sm:text-base">
                Vireek connects through call forwarding, not through swapping your number or your
                carrier. If your line can forward calls, it can work with Sarah.
              </p>
            </AnimatedSection>

            <div className="mt-10 grid gap-6 sm:grid-cols-2">
              <AnimatedSection>
                <Card className="h-full">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-success" />
                    <h3 className="text-base font-semibold text-text-primary">Compatible with</h3>
                  </div>
                  <ul className="mt-4 space-y-3">
                    {PHONE_COMPATIBILITY.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-sm leading-relaxed text-text-secondary">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </Card>
              </AnimatedSection>

              <AnimatedSection>
                <Card className="h-full">
                  <div className="flex items-center gap-2">
                    <XCircle className="h-5 w-5 text-text-secondary" />
                    <h3 className="text-base font-semibold text-text-primary">You won&apos;t need</h3>
                  </div>
                  <ul className="mt-4 space-y-3">
                    {PHONE_NOT_NEEDED.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-sm leading-relaxed text-text-secondary">
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary/60" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </Card>
              </AnimatedSection>
            </div>

            <AnimatedSection className="mt-6 text-center">
              <p className="text-sm text-text-secondary">
                See the full walkthrough in our{' '}
                <Link to="/onboarding-guide" className="font-semibold text-accent hover:underline">
                  Onboarding Guide
                </Link>
                .
              </p>
            </AnimatedSection>
          </div>
        </section>

        {/* Integrations compatibility */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-6xl">
            <AnimatedSection className="text-center">
              <p className={eyebrowClass()}>Integrations</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>What each connected tool requires</h2>
            </AnimatedSection>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-8 grid gap-5 sm:mt-12 sm:grid-cols-2 lg:grid-cols-4"
            >
              {INTEGRATIONS_COMPAT.map(({ icon: Icon, name, requirement, href }) => (
                <motion.div key={name} variants={fadeUpItem} transition={{ duration: 0.45, ease: EASE }}>
                  <Link to={href} className="block h-full">
                    <Card className="h-full">
                      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                        <Icon size={20} />
                      </span>
                      <h3 className="mt-4 text-base font-semibold text-text-primary">{name}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-text-secondary">{requirement}</p>
                    </Card>
                  </Link>
                </motion.div>
              ))}
            </motion.div>

            <AnimatedSection className="mt-6 text-center">
              <Link to="/integrations" className="inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline">
                <Plug className="h-4 w-4" /> See all integrations
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </AnimatedSection>
          </div>
        </section>

        {/* Trust / security note */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-4xl">
            <AnimatedSection>
              <Card className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-4">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    <ShieldCheck size={20} />
                  </span>
                  <div>
                    <h3 className="text-base font-semibold text-text-primary">Nothing to patch, nothing to maintain</h3>
                    <p className="mt-1 text-sm leading-relaxed text-text-secondary">
                      Because Vireek runs in the browser, every account is always on the current
                      version \u2014 there are no manual updates for your team to install.
                    </p>
                  </div>
                </div>
                <Link to="/security" className="w-full sm:w-auto">
                  <Button variant="secondary" size="md" className="w-full sm:w-auto">
                    Read about Security
                  </Button>
                </Link>
              </Card>
            </AnimatedSection>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-5 py-16 sm:px-6 sm:py-20 lg:py-24">
          <div className="mx-auto max-w-3xl text-center">
            <AnimatedSection>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>Ready to see it running on your line?</h2>
              <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-text-secondary sm:text-base">
                Most businesses are live in about 15 minutes \u2014 no new hardware, no waiting on IT.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
                <Link to="/login" className="w-full sm:w-auto">
                  <Button variant="primary" size="lg" className="w-full sm:w-auto">
                    Start Free Trial
                  </Button>
                </Link>
                <Link to="/demo" className="w-full sm:w-auto">
                  <Button variant="secondary" size="lg" className="w-full sm:w-auto">
                    Book a Demo
                  </Button>
                </Link>
              </div>
            </AnimatedSection>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
