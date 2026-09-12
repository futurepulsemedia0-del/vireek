import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import {
  ShieldCheck, Lock, Database, UserCog, FileText, Activity, Globe,
  ArrowRight, ExternalLink, type LucideIcon,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useSEO } from '@/lib/seo';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';

// ============================================================
// CONTENT
// ============================================================
//
// Same rule as SecurityPage.tsx: every statement here is a factual
// description of how the platform is built (encryption, RLS-based
// isolation, role-based access, sub-processor list) rather than a
// compliance certification Vireek does not currently hold. Do not add a
// "SOC 2 certified", "HIPAA compliant", or similar badge unless that
// certification has actually been obtained and can be substantiated.

interface Pillar {
  icon: LucideIcon;
  title: string;
  body: string;
}

const PILLARS: Pillar[] = [
  {
    icon: Lock,
    title: 'Encryption in transit and at rest',
    body: 'All traffic between your browser, the Vireek dashboard, and our database runs over TLS. Data at rest is encrypted by our infrastructure provider.',
  },
  {
    icon: Database,
    title: 'Isolated by account, by design',
    body: 'Every account\u2019s calls, leads, and jobs are protected with row-level security policies, so one business can never query or see another business\u2019s data.',
  },
  {
    icon: UserCog,
    title: 'Role-based team access',
    body: 'Account owners control who on their team can view billing, manage the team, edit the business profile, or see all jobs \u2014 down to the individual permission.',
  },
  {
    icon: FileText,
    title: 'Clear data-handling documentation',
    body: 'Our Privacy Policy and Terms of Service spell out exactly what\u2019s collected, why, and how long it\u2019s kept.',
  },
];

interface SubProcessor {
  name: string;
  purpose: string;
  href: string;
}

const SUB_PROCESSORS: SubProcessor[] = [
  { name: 'Stripe', purpose: 'Payment processing and subscription billing', href: '/integrations/stripe' },
  { name: 'Google Calendar', purpose: 'Appointment scheduling, when connected by you', href: '/integrations/google-calendar' },
  { name: 'QuickBooks', purpose: 'Accounting sync, when connected by you', href: '/integrations/quickbooks' },
  { name: 'Zapier', purpose: 'Workflow automation, when connected by you', href: '/integrations/zapier' },
];

const RESOURCES = [
  { label: 'Security overview', description: 'How call and customer data is protected.', href: '/security' },
  { label: 'Privacy Policy', description: 'What we collect and why.', href: '/privacy' },
  { label: 'Terms of Service', description: 'The legal terms of using Vireek.', href: '/terms' },
  { label: 'Cookie Policy', description: 'How cookies are used on this site.', href: '/cookies' },
  { label: 'Data Processing Agreement', description: 'Our standard DPA for enterprise procurement.', href: '/dpa' },
  { label: 'Sub-processor List', description: 'Every third party that touches your data.', href: '/subprocessors' },
  { label: 'System Status', description: 'Live uptime and incident history.', href: '/status' },
  { label: 'Service Level Agreement', description: 'Our uptime commitment and service credits.', href: '/sla' },
  { label: 'Acceptable Use Policy', description: 'Rules for lawful use of the platform.', href: '/acceptable-use-policy' },
  { label: 'Vulnerability Disclosure', description: 'How to report a security issue.', href: '/vulnerability-disclosure' },
  { label: 'Refund & Cancellation Policy', description: 'How billing and cancellation work.', href: '/refund-policy' },
];

export function TrustCenterPage() {
  useSEO({
    title: 'Trust Center | Vireek',
    description:
      'Vireek\u2019s Trust Center: how call and customer data is secured, which sub-processors we use, and where to find our security, privacy, and compliance documentation.',
    canonical: 'https://vireek.com/trust',
  });

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-20 sm:pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-5 py-16 sm:px-6 sm:py-20 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-3xl text-center">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-3 py-1.5 text-xs font-semibold text-text-secondary shadow-sm backdrop-blur sm:mb-6 sm:px-4 sm:text-sm">
                <ShieldCheck className="h-4 w-4 text-accent" />
                Trust Center
              </div>
              <h1 className="text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl lg:text-5xl">
                How Vireek Earns Your Trust
              </h1>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-text-secondary sm:mt-6 sm:text-lg sm:leading-8">
                One place for how we handle your data, who we share it with, and where to find our
                security, privacy, and compliance documentation.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Pillars */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto grid max-w-6xl gap-5 sm:grid-cols-2">
            {PILLARS.map(({ icon: Icon, title, body }, i) => (
              <motion.div
                key={title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.45, ease: EASE, delay: Math.min(i * 0.06, 0.2) }}
              >
                <Card className="h-full">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    <Icon size={20} />
                  </span>
                  <h3 className="mt-4 text-lg font-semibold text-text-primary">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{body}</p>
                </Card>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Sub-processors */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>Sub-processors</p>
              <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>Who else touches your data</h2>
              <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-text-secondary sm:text-base">
                Vireek uses a small number of vetted providers to run core features. Some are only
                involved if you choose to connect them.
              </p>
            </motion.div>

            <div className="mt-8 space-y-3 sm:mt-10 sm:space-y-4">
              {SUB_PROCESSORS.map((sp) => (
                <Link
                  key={sp.name}
                  to={sp.href}
                  className="focus-ring flex items-center justify-between gap-4 rounded-2xl border border-border bg-bg-secondary/90 p-5 shadow-card transition-colors hover:border-accent/30 dark:shadow-card-dark sm:p-6"
                >
                  <div>
                    <h3 className="text-base font-semibold text-text-primary">{sp.name}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-text-secondary">{sp.purpose}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-accent" />
                </Link>
              ))}
            </div>
          </div>
        </section>
                {/* Data location */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
            >
              <div className="flex items-start gap-3">
                <Globe className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                <div>
                  <h3 className="text-base font-semibold text-text-primary">Where your data is stored</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                    Vireek runs on cloud infrastructure hosted in the United States today &mdash; see our{' '}
                    <Link to="/subprocessors" className="font-semibold text-accent hover:underline">
                      sub-processor list
                    </Link>{' '}
                    for the specific providers behind that. We don&rsquo;t currently offer EU-region data
                    residency. If that&rsquo;s a hard requirement for your business, tell us on a call and
                    we&rsquo;ll give you a straight answer on timeline and options rather than a vague
                    &ldquo;coming soon.&rdquo;
                  </p>
                </div>
              </div>
            </motion.div>
          </div>
        </section>
        {/* Compliance status */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark sm:p-8"
            >
              <div className="flex items-start gap-3">
                <Activity className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                <div>
                  <h3 className="text-base font-semibold text-text-primary">Compliance roadmap</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                    We build on infrastructure providers who maintain their own compliance
                    certifications, and we follow the data-isolation and access-control practices
                    described above today. We&rsquo;ll publish any additional certifications (such as a
                    SOC 2 report) here as soon as they&rsquo;re formally completed &mdash; if your business
                    needs a specific certification before signing up, tell us on a call and we&rsquo;ll
                    give you a straight answer.
                  </p>
                </div>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Resources */}
        <section className="px-5 py-12 sm:px-6 sm:py-16 lg:py-20">
          <div className="mx-auto max-w-4xl">
            <p className={`${eyebrowClass()} text-center`}>Documentation</p>
            <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>Everything in one place</h2>
            <div className="mt-8 grid gap-3 sm:mt-10 sm:grid-cols-2">
              {RESOURCES.map((r) => (
                <Link
                  key={r.href}
                  to={r.href}
                  className="focus-ring flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary/90 p-5 shadow-card transition-colors hover:border-accent/30 dark:shadow-card-dark"
                >
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary">{r.label}</h3>
                    <p className="mt-1 text-xs leading-relaxed text-text-secondary">{r.description}</p>
                  </div>
                  <ExternalLink className="h-4 w-4 shrink-0 text-text-secondary" />
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-5 pb-16 sm:px-6 sm:pb-24">
          <div className="mx-auto max-w-4xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Questions about trust or compliance?</p>
            <h2 className="mt-4 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl md:text-4xl">
              Talk to us before you connect anything.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-text-secondary sm:text-base">
              If your business has specific security, privacy, or compliance requirements, we&rsquo;re
              happy to walk through them before you sign up.
            </p>
            <div className="mt-8">
              <Link to="/demo">
                <Button variant="primary" size="lg">
                  Book a Demo <ArrowRight className="h-4 w-4" />
                </Button>
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
