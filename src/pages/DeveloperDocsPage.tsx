import { motion } from 'framer-motion';
import {
  ArrowRight,
  ShieldCheck,
  Code2,
  Webhook,
  KeyRound,
  PhoneCall,
  Users,
  Wrench,
  Mail,
  Lock,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

const DOCS_EMAIL = 'ali@vireek.com';

const SAMPLE_REQUEST = `POST /v1/calls/lookup
Authorization: Bearer {api_key}
Content-Type: application/json

{
  "phone": "+15551234567"
}`;

const SAMPLE_RESPONSE = `{
  "call_id": "call_9f2a1c",
  "status": "completed",
  "lead": {
    "name": "Jordan Reyes",
    "issue": "No AC — unit blowing warm air",
    "urgency": "same_day"
  },
  "appointment_booked": true
}`;

type Capability = {
  icon: typeof PhoneCall;
  title: string;
  body: string;
};

const CAPABILITIES: Capability[] = [
  {
    icon: PhoneCall,
    title: 'Calls API',
    body: 'Pull call recordings, transcripts, and structured summaries for every call Vireek answers.',
  },
  {
    icon: Users,
    title: 'Leads & Jobs API',
    body: 'Read and sync lead and job records programmatically — useful for connecting Vireek to a custom CRM or internal tool.',
  },
  {
    icon: Webhook,
    title: 'Webhooks',
    body: 'Get notified in real time when a call ends, a lead is captured, or an appointment is booked, instead of polling.',
  },
  {
    icon: Wrench,
    title: 'Custom Integrations',
    body: 'Build a private integration between Vireek and internal systems that our standard integrations do not cover.',
  },
];

const ACCESS_STEPS = [
  {
    icon: Mail,
    title: 'Request Access',
    body: 'Tell us what you are building and which capabilities you need.',
  },
  {
    icon: KeyRound,
    title: 'Get Scoped Credentials',
    body: 'We issue an API key scoped to your account, plus the exact request/response shapes for your use case.',
  },
  {
    icon: Code2,
    title: 'Integrate',
    body: 'We walk you through the integration directly — no generic ticket queue for API access.',
  },
];

function SEO() {
  useSEO({
    title: 'Developer Docs & API Reference — Vireek',
    description:
      'API and integration access for agencies and enterprise teams building on top of Vireek — calls, leads, jobs, and webhooks.',
    canonical: 'https://vireek.com/docs',
  });
  return null;
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-bg-tertiary">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary/70">{label}</span>
      </div>
      <pre className="overflow-x-auto px-4 py-4 text-[13px] leading-relaxed text-text-primary">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function DeveloperDocsPage() {
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
              <p className={eyebrowClass()}>Developers</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Build on Top of Vireek
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                API and webhook access for agencies and enterprise teams that need to connect
                Vireek to a custom CRM or internal system. Access is granted per account — no
                public, self-serve API keys yet.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a href={`mailto:${DOCS_EMAIL}?subject=${encodeURIComponent('API access request')}`}>
                  <Button variant="primary" size="lg">
                    Request API Access
                  </Button>
                </a>
                <a href="#capabilities" className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent">
                  See What's Possible
                  <ArrowRight className="h-4 w-4" />
                </a>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Capabilities */}
        <section id="capabilities" className="scroll-mt-24 px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-7xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Capabilities</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                What you can build with Vireek's API
              </h2>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4"
            >
              {CAPABILITIES.map(({ icon: Icon, title, body }) => (
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

        {/* Sample request/response */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Illustrative Example</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                What a request looks like
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                This is a representative example, not a live public endpoint. Exact routes,
                fields, and authentication are confirmed with you during onboarding.
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
              className="mt-12 grid gap-6 md:grid-cols-2"
            >
              <CodeBlock label="Request" code={SAMPLE_REQUEST} />
              <CodeBlock label="Response" code={SAMPLE_RESPONSE} />
            </motion.div>
          </div>
        </section>

        {/* Access + how it works */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Getting Access</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                How API access works
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                API and webhook access is included with Business and Enterprise plans, and
                available by request for agencies building integrations on a client's behalf.
              </p>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-3"
            >
              {ACCESS_STEPS.map(({ icon: Icon, title, body }, index) => (
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

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, delay: 0.15, ease: EASE }}
              className="mx-auto mt-10 flex max-w-2xl items-start gap-3 rounded-2xl border border-border bg-bg-secondary p-5"
            >
              <Lock size={18} className="mt-0.5 shrink-0 text-text-secondary" />
              <p className="text-sm leading-relaxed text-text-secondary">
                Every API key is scoped to a single account and can be revoked instantly. We do
                not offer unscoped or account-wide keys.
              </p>
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
              <Code2 className="mx-auto h-10 w-10 text-white/90" />
              <h2 className="mt-5 text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                Building something custom?
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Tell us what you are trying to connect and we will confirm whether it is possible
                today and what access you will need.
              </p>
              <div className="mt-9 flex justify-center">
                <a href={`mailto:${DOCS_EMAIL}?subject=${encodeURIComponent('API access request')}`}>
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    <Mail size={18} />
                    Request API Access
                  </Button>
                </a>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-white/70">
                <ShieldCheck size={13} className="shrink-0" />
                Scoped keys only. Revoke access anytime.
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
