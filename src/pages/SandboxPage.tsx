import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowRight, FlaskConical, Mail, RefreshCw, ShieldCheck, TerminalSquare } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { useSEO } from '@/lib/seo';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

const SANDBOX_EMAIL = 'ali@vireek.com';

const FEATURES = [
  {
    icon: TerminalSquare,
    title: 'Synthetic calls & leads',
    body: 'Trigger realistic call, lead, and appointment events on demand instead of waiting for real phone traffic.',
  },
  {
    icon: RefreshCw,
    title: 'Reset anytime',
    body: 'Wipe your sandbox data back to a clean state with one request, so every test run starts from the same baseline.',
  },
  {
    icon: ShieldCheck,
    title: 'Fully isolated',
    body: 'Sandbox keys are scoped separately from production — nothing you do in sandbox can touch a real customer or job.',
  },
];

function SEO() {
  useSEO({
    title: 'Sandbox — Test Environment | Vireek',
    description:
      'Build and test Vireek integrations against synthetic calls and leads in an isolated sandbox environment before going live.',
    canonical: 'https://vireek.com/sandbox',
  });
  return null;
}

export function SandboxPage() {
  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24">
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
              <p className={eyebrowClass()}>Developer Preview</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                Build Against a Sandbox, Not Live Data
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary">
                Test your integration against synthetic calls, leads, and appointments in an
                environment that's fully isolated from production — no risk of touching a real
                customer while you build.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a href={`mailto:${SANDBOX_EMAIL}?subject=${encodeURIComponent('Sandbox access request')}`}>
                  <Button variant="primary" size="lg">
                    <FlaskConical className="h-4 w-4" /> Request Sandbox Access
                  </Button>
                </a>
                <Link
                  to="/sdks"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  See the SDKs
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Features */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="grid gap-6 sm:grid-cols-3"
            >
              {FEATURES.map(({ icon: Icon, title, body }) => (
                <motion.div key={title} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="h-full">
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                      <Icon size={22} />
                    </span>
                    <h3 className="mt-5 text-lg font-semibold text-text-primary">{title}</h3>
                    <p className="mt-3 text-sm leading-relaxed text-text-secondary">{body}</p>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* How it works */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl">
            <div className="text-center">
              <p className={`${eyebrowClass()} text-center`}>How it works</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>From request to first test call</h2>
            </div>
            <ol className="mt-12 space-y-6">
              {[
                { step: '01', title: 'Request access', body: 'Tell us what you\u2019re building — we issue a sandbox key scoped only to test data.' },
                { step: '02', title: 'Trigger synthetic events', body: 'Use the SDK or API to fire synthetic calls, leads, and appointments on demand.' },
                { step: '03', title: 'Promote to production', body: 'Once your integration works end-to-end, we switch you over to a live, scoped production key.' },
              ].map(({ step, title, body }) => (
                <li key={step} className="flex gap-5 rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6">
                  <span className="shrink-0 text-2xl font-extrabold text-text-primary/[0.12]">{step}</span>
                  <div>
                    <h3 className="text-base font-semibold text-text-primary">{title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className={`${bodyClass()} mx-auto mt-8 max-w-xl text-center`}>
              Sandbox access is currently granted by request while the API is in developer
              preview — see{' '}
              <Link to="/docs" className="font-semibold text-accent hover:text-cta">
                Developer Docs
              </Link>{' '}
              for the full access model.
            </p>
          </div>
        </section>

        {/* CTA */}
        <section className="px-6 pb-24">
          <div className="mx-auto max-w-4xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <h2 className="text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Ready to start building?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-text-secondary">
              Tell us what you're integrating and we'll get you a sandbox key.
            </p>
            <div className="mt-8 flex justify-center">
              <a href={`mailto:${SANDBOX_EMAIL}?subject=${encodeURIComponent('Sandbox access request')}`}>
                <Button variant="primary" size="lg">
                  <Mail className="h-4 w-4" /> Request Sandbox Access
                </Button>
              </a>
            </div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
