import { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Mail, Package, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { useSEO } from '@/lib/seo';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';

const SDK_EMAIL = 'ali@vireek.com';

type SdkLang = 'node' | 'python';

const INSTALL: Record<SdkLang, string> = {
  node: 'npm install @vireek/sdk',
  python: 'pip install vireek',
};

const SAMPLE: Record<SdkLang, string> = {
  node: `import { Vireek } from '@vireek/sdk';

const vireek = new Vireek({ apiKey: process.env.VIREEK_API_KEY });

// Look up a call by phone number
const call = await vireek.calls.lookup({ phone: '+15551234567' });
console.log(call.lead.issue, call.appointment_booked);

// Listen for real-time events instead of polling
vireek.webhooks.on('call.completed', (event) => {
  console.log('Call finished:', event.call_id);
});`,
  python: `from vireek import Vireek

vireek = Vireek(api_key=os.environ["VIREEK_API_KEY"])

# Look up a call by phone number
call = vireek.calls.lookup(phone="+15551234567")
print(call.lead.issue, call.appointment_booked)

# Verify an incoming webhook payload
event = vireek.webhooks.construct_event(
    payload=request.body,
    signature=request.headers["Vireek-Signature"],
)
if event.type == "call.completed":
    handle_completed_call(event.data)`,
};

function SEO() {
  useSEO({
    title: 'Official SDKs — Node.js & Python | Vireek',
    description:
      'Official Vireek client libraries for Node.js and Python: typed wrappers around the Calls, Leads/Jobs, and Webhooks APIs.',
    canonical: 'https://vireek.com/sdks',
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

export function SdksPage() {
  const [lang, setLang] = useState<SdkLang>('node');

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
                Official Node.js &amp; Python SDKs
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary">
                Typed client libraries for the Calls, Leads/Jobs, and Webhooks APIs, so you spend
                time on your integration instead of hand-rolling HTTP requests. Available today for
                accounts with API access — see{' '}
                <Link to="/docs" className="font-semibold text-accent hover:text-cta">
                  Developer Docs
                </Link>{' '}
                for how access works.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Language switcher + code */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl">
            <div className="flex justify-center gap-2.5">
              {(['node', 'python'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setLang(option)}
                  className={`focus-ring rounded-full border px-5 py-2 text-sm font-semibold transition-colors ${
                    lang === option
                      ? 'border-accent bg-accent text-white'
                      : 'border-border bg-bg-secondary text-text-secondary hover:border-accent/40 hover:text-text-primary'
                  }`}
                >
                  {option === 'node' ? 'Node.js' : 'Python'}
                </button>
              ))}
            </div>

            <div className="mt-8 space-y-6">
              <CodeBlock label="Install" code={INSTALL[lang]} />
              <CodeBlock label="Usage" code={SAMPLE[lang]} />
            </div>

            <div className="mx-auto mt-8 flex max-w-2xl items-start gap-3 rounded-2xl border border-border bg-bg-secondary p-5">
              <ShieldCheck size={18} className="mt-0.5 shrink-0 text-text-secondary" />
              <p className="text-sm leading-relaxed text-text-secondary">
                Both SDKs are in developer preview: the interface above reflects the intended
                shape and may still change before general availability. Pin a version once you
                ship to production.
              </p>
            </div>
          </div>
        </section>

        {/* What's included */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <div className="mx-auto max-w-2xl text-center">
              <p className={`${eyebrowClass()} text-center`}>What's included</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Same SDK, both languages</h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                Both libraries wrap the exact same API, so the concepts below carry over whichever
                one you use.
              </p>
            </div>
            <div className="mt-14 grid gap-6 sm:grid-cols-3">
              {[
                { title: 'Calls & Leads clients', body: 'Typed methods for looking up calls and reading lead/job records — no raw JSON parsing.' },
                { title: 'Webhook verification', body: 'Built-in signature verification so you can trust that an incoming event actually came from Vireek.' },
                { title: 'Automatic retries', body: 'Safe, idempotent requests are retried on transient network errors with exponential backoff.' },
              ].map(({ title, body }) => (
                <Card key={title} className="h-full">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                    <Package size={22} />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold text-text-primary">{title}</h3>
                  <p className="mt-3 text-sm leading-relaxed text-text-secondary">{body}</p>
                </Card>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="px-6 pb-24">
          <div className="mx-auto max-w-4xl rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
            <h2 className="text-3xl font-bold tracking-tight text-text-primary sm:text-4xl">
              Don't have API access yet?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-text-secondary">
              API and SDK access is included with Business and Enterprise plans, and available by
              request for agencies building on a client's behalf.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <a href={`mailto:${SDK_EMAIL}?subject=${encodeURIComponent('API access request')}`}>
                <Button variant="primary" size="lg">
                  <Mail className="h-4 w-4" /> Request API Access
                </Button>
              </a>
              <Link to="/sandbox">
                <Button variant="secondary" size="lg">
                  Try the Sandbox <ArrowRight className="h-4 w-4" />
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
