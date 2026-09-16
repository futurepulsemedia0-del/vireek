import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  FlaskConical,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
  KeyRound,
  BookOpen,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { useSEO } from '@/lib/seo';
import {
  EASE,
  eyebrowClass,
  sectionHeadingClass,
  bodyClass,
  staggerContainer,
  fadeUpItem,
  viewport,
} from '@/lib/motion';
import { useAuth } from '@/contexts/AuthContext';
import { ApiPlayground } from '@/components/sandbox/ApiPlayground';
import { SyntheticEventsPanel } from '@/components/sandbox/SyntheticEventsPanel';

const FEATURES = [
  {
    icon: TerminalSquare,
    title: 'Live API playground',
    body: 'Hit real endpoints with your own key — see status, latency, and JSON in one place. Copy as cURL when you’re ready to wire it up.',
  },
  {
    icon: RefreshCw,
    title: 'Synthetic event payloads',
    body: 'Copy production-shaped call, lead, and job events for your webhook tests. Nothing is written to your account from this page.',
  },
  {
    icon: ShieldCheck,
    title: 'Scoped keys only',
    body: 'Keys are limited by the scopes you grant (calls:read, leads:read, jobs:read). Revoke or rotate anytime from API Keys.',
  },
];

function SEO() {
  useSEO({
    title: 'Sandbox — Test Environment | Vireek',
    description:
      'Test Vireek API integrations against live endpoints and synthetic webhook payloads in a developer sandbox — before you go live.',
    canonical: 'https://vireek.com/sandbox',
  });
  return null;
}

export function SandboxPage() {
  const { session } = useAuth();

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-16 sm:py-20">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-5xl">
            <div className="mb-8">
              <BackButton />
            </div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>Developer tools</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                Sandbox — build against real shapes, zero guesswork
              </h1>
              <p className={`mx-auto mt-6 max-w-2xl ${bodyClass()}`}>
                Use the interactive playground to call the same API your production integration will hit,
                and copy synthetic webhook payloads that match live events. No waiting for phone traffic.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                {session ? (
                  <a href="#playground">
                    <Button variant="primary" size="lg">
                      <FlaskConical className="h-4 w-4" />
                      Open playground
                    </Button>
                  </a>
                ) : (
                  <Link to="/login">
                    <Button variant="primary" size="lg">
                      <KeyRound className="h-4 w-4" />
                      Sign in to use your keys
                    </Button>
                  </Link>
                )}
                <Link
                  to="/developers"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  <BookOpen className="h-4 w-4" />
                  API docs
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Features */}
        <section className="px-6 py-12 sm:py-16">
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
                  <Card className="h-full border-border bg-bg-secondary/60 p-6">
                    <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                      <Icon size={20} />
                    </span>
                    <h3 className="mt-4 text-base font-semibold text-text-primary">{title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">{body}</p>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Playground */}
        <section id="playground" className="scroll-mt-28 px-6 pb-10">
          <div className="mx-auto max-w-6xl space-y-8">
            <div>
              <h2 className={sectionHeadingClass()}>Try it now</h2>
              <p className={`mt-2 max-w-2xl ${bodyClass()}`}>
                Paste a key with the scopes you need. Requests go to the live{' '}
                <code className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-[12px]">api-v1</code>{' '}
                edge function — the same surface your production code will call.
              </p>
            </div>
            <ApiPlayground />
            <SyntheticEventsPanel />
          </div>
        </section>

        {/* Quick links */}
        <section className="px-6 pb-20">
          <div className="mx-auto max-w-6xl">
            <div className="grid gap-4 sm:grid-cols-3">
              <Link
                to="/dashboard/api-keys"
                className="rounded-2xl border border-border bg-bg-secondary/50 p-5 transition hover:border-accent/40 hover:bg-bg-secondary"
              >
                <KeyRound className="mb-2 h-5 w-5 text-accent" />
                <p className="font-semibold text-text-primary">Create API keys</p>
                <p className="mt-1 text-sm text-text-secondary">Owner-only. Scoped, rotatable, never stored in plain text.</p>
              </Link>
              <Link
                to="/developers"
                className="rounded-2xl border border-border bg-bg-secondary/50 p-5 transition hover:border-accent/40 hover:bg-bg-secondary"
              >
                <BookOpen className="mb-2 h-5 w-5 text-accent" />
                <p className="font-semibold text-text-primary">Developer docs</p>
                <p className="mt-1 text-sm text-text-secondary">Endpoints, scopes, webhooks, and authentication.</p>
              </Link>
              <Link
                to="/sdks"
                className="rounded-2xl border border-border bg-bg-secondary/50 p-5 transition hover:border-accent/40 hover:bg-bg-secondary"
              >
                <TerminalSquare className="mb-2 h-5 w-5 text-accent" />
                <p className="font-semibold text-text-primary">SDKs</p>
                <p className="mt-1 text-sm text-text-secondary">Client libraries and quickstarts for common stacks.</p>
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
