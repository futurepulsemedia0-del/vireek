import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ShieldCheck, Lock, Database, UserCog, Eye, ArrowRight } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';

// ============================================================
// CONTENT
// ============================================================
//
// Every claim below is a factual statement about how the platform is
// built (encryption in transit/at rest via the hosting provider, RLS-based
// per-account isolation, role-based access) rather than a compliance
// certification Vireek does not currently hold. If/when a SOC 2 report,
// HIPAA BAA, etc. is obtained, add it explicitly here — don't imply one
// that doesn't exist.

const PILLARS = [
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
    icon: Eye,
    title: 'You control what Vireek says and does',
    body: 'Escalation rules, greetings, and business details are all set by you. Nothing is shared with a caller that you haven\u2019t configured.',
  },
];

function SEO() {
  useEffect(() => {
    const title = 'Trust & Security | Vireek';
    const description =
      'How Vireek protects your business data: encryption, account isolation, role-based access, and data handling practices.';
    const previousTitle = document.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousContent = meta?.getAttribute('content') ?? null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', description);
    document.title = title;
    return () => {
      document.title = previousTitle;
      if (previousContent === null) meta?.remove();
      else meta?.setAttribute('content', previousContent);
    };
  }, []);
  return null;
}

export function SecurityPage() {
  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-3xl text-center">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <ShieldCheck className="h-4 w-4 text-accent" />
                Trust & Security
              </div>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                Your calls and customer data, protected by design.
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-lg leading-8 text-text-secondary">
                A plain-language look at how Vireek handles the data your business trusts it with.
              </p>
            </motion.div>
          </div>
        </section>

        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto grid max-w-6xl gap-6 sm:grid-cols-2">
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

        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl">
            <p className={`${eyebrowClass()} text-center`}>Data Handling</p>
            <h2 className={`${sectionHeadingClass()} text-center`}>What we store, and why</h2>
            <div className="mt-10 space-y-4">
              <div className="rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark">
                <h3 className="text-base font-semibold text-text-primary">Call data</h3>
                <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                  Call transcripts and summaries are stored so your team can review conversations
                  and follow up. Access is limited to your account and any team members you
                  grant permission to.
                </p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark">
                <h3 className="text-base font-semibold text-text-primary">Customer & lead information</h3>
                <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                  Names, phone numbers, and job details captured on calls are stored under your
                  account and synced to your CRM if you\u2019ve connected one, so leads never live
                  only in a call log.
                </p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark">
                <h3 className="text-base font-semibold text-text-primary">Payment information</h3>
                <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                  Billing is handled by a dedicated payment processor. Vireek does not store your
                  raw card details on its own servers.
                </p>
              </div>
            </div>
            <p className="mt-6 text-center text-sm text-text-secondary">
              For the full legal terms, see our{' '}
              <Link to="/privacy" className="font-semibold text-accent hover:text-cta">
                Privacy Policy
              </Link>{' '}
              and{' '}
              <Link to="/terms" className="font-semibold text-accent hover:text-cta">
                Terms of Service
              </Link>
              .
            </p>
          </div>
        </section>

        <section className="px-6 pb-24">
          <div className="mx-auto max-w-4xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">Questions about security?</p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Talk to us before you connect anything.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-text-secondary">
              If your business has specific security or compliance requirements, we\u2019re happy to
              walk through them before you sign up.
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
