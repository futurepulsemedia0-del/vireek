import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
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
const API_BASE_URL = 'https://<your-project-ref>.supabase.co/functions/v1/api-v1';

const ENDPOINTS: {
  method: string; path: string; scope: string; description: string;
}[] = [
  { method: 'GET', path: '/calls', scope: 'calls:read', description: 'List recent calls (recordings, transcripts, summaries, sentiment).' },
  { method: 'GET', path: '/calls/:id', scope: 'calls:read', description: 'Fetch a single call by ID.' },
  { method: 'GET', path: '/leads', scope: 'leads:read', description: 'List leads captured from calls.' },
  { method: 'GET', path: '/leads/:id', scope: 'leads:read', description: 'Fetch a single lead by ID.' },
  { method: 'GET', path: '/jobs', scope: 'jobs:read', description: 'List booked/scheduled jobs.' },
  { method: 'GET', path: '/jobs/:id', scope: 'jobs:read', description: 'Fetch a single job by ID.' },
];

const QUERY_PARAMS = [
  { name: 'limit', type: 'integer', description: 'Max rows to return (1–100). Defaults to 25.' },
  { name: 'before', type: 'ISO 8601 timestamp', description: 'Return rows created before this timestamp, for pagination.' },
];

const WEBHOOK_EVENTS = [
  { event: 'call.created', description: 'Fired the moment a new call record is saved.' },
  { event: 'lead.created', description: 'Fired when a new lead is captured.' },
  { event: 'job.created', description: 'Fired when a new job is booked.' },
];

const CODE_CURL = `curl "${'{base_url}'}/calls?limit=5" \\
  -H "Authorization: Bearer vrk_live_..."`;

const CODE_JS = `const res = await fetch('${'{base_url}'}/calls?limit=5', {
  headers: { Authorization: 'Bearer vrk_live_...' },
});
const { data } = await res.json();`;

const CODE_PY = `import requests

res = requests.get(
    "${'{base_url}'}/calls",
    params={"limit": 5},
    headers={"Authorization": "Bearer vrk_live_..."},
)
data = res.json()["data"]`;

const WEBHOOK_PAYLOAD = `POST <your-webhook-url>
Content-Type: application/json

{
  "event": "call.created",
  "data": {
    "id": "3f8a1c9e-...",
    "caller_name": "Jordan Reyes",
    "is_emergency": false,
    "status": "booked",
    "created_at": "2026-09-14T18:22:03Z"
  }
}`;

const SAMPLE_REQUEST = `GET /calls?limit=5 HTTP/1.1
Host: <your-project-ref>.supabase.co
Authorization: Bearer vrk_live_...
`;

const SAMPLE_RESPONSE = `{
  "data": [
    {
      "id": "3f8a1c9e-...",
      "caller_name": "Jordan Reyes",
      "caller_phone": "+15551234567",
      "summary": "No AC — unit blowing warm air",
      "is_emergency": false,
      "status": "booked",
      "duration_seconds": 174,
      "created_at": "2026-09-14T18:22:03Z"
    }
  ],
  "has_more": false,
  "next_before": null
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
    icon: KeyRound,
    title: 'Generate a Key',
    body: 'Head to Settings → API Keys, name your key, and pick the scopes you need.',
  },
  {
    icon: Code2,
    title: 'Make a Request',
    body: 'Call any endpoint below with your key in the Authorization header. That\u2019s it.',
  },
  {
    icon: Webhook,
    title: 'Add Webhooks',
    body: 'Set a URL under Integrations to get pushed events instead of polling.',
  },
];

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
                Every account can generate its own scoped API key from Settings — read calls,
                leads, and jobs programmatically, and receive real-time webhooks. No request
                queue, no waiting on us.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/dashboard/settings/api-keys">
                  <Button variant="primary" size="lg">
                    Generate an API Key
                  </Button>
                </Link>
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
                 {/* Authentication + Endpoints */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <p className={`${eyebrowClass()} text-center`}>Reference</p>
            <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Authentication &amp; Endpoints</h2>

            <div className="mt-10 rounded-2xl border border-border bg-bg-secondary p-6">
              <h3 className="text-base font-semibold text-text-primary">Authentication</h3>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                Every request needs an <code className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs">Authorization: Bearer &lt;api_key&gt;</code> header.
                Generate a key from <Link to="/dashboard/settings/api-keys" className="font-medium text-accent hover:underline">Settings → API Keys</Link> — each key is scoped to specific resources and can be rotated or revoked anytime.
              </p>
              <div className="mt-4 rounded-xl border border-border bg-bg-tertiary px-4 py-3">
                <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary/70">Base URL</span>
                <code className="mt-1 block text-sm text-text-primary">{API_BASE_URL}</code>
              </div>
            </div>

            <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-bg-secondary">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-bg-tertiary/50 text-left text-xs text-text-secondary">
                    <th className="px-5 py-3 font-medium">Method</th>
                    <th className="px-5 py-3 font-medium">Path</th>
                    <th className="px-5 py-3 font-medium">Scope</th>
                    <th className="px-5 py-3 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {ENDPOINTS.map((e) => (
                    <tr key={e.path} className="border-b border-border/60 last:border-0">
                      <td className="px-5 py-3"><span className="rounded-md bg-success-500/10 px-2 py-0.5 text-xs font-bold text-success-500">{e.method}</span></td>
                      <td className="px-5 py-3"><code className="text-xs text-text-primary">{e.path}</code></td>
                      <td className="px-5 py-3"><code className="text-xs text-text-secondary">{e.scope}</code></td>
                      <td className="px-5 py-3 text-text-secondary">{e.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-6 rounded-2xl border border-border bg-bg-secondary p-6">
              <h3 className="text-base font-semibold text-text-primary">Query parameters (list endpoints)</h3>
              <div className="mt-3 space-y-2">
                {QUERY_PARAMS.map((p) => (
                  <div key={p.name} className="flex flex-wrap items-baseline gap-2 text-sm">
                    <code className="text-text-primary">{p.name}</code>
                    <span className="text-xs text-text-secondary/70">{p.type}</span>
                    <span className="text-text-secondary">— {p.description}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 grid gap-6 md:grid-cols-3">
              <CodeBlock label="cURL" code={CODE_CURL} />
              <CodeBlock label="JavaScript" code={CODE_JS} />
              <CodeBlock label="Python" code={CODE_PY} />
            </div>
          </div>
        </section>

        {/* Webhooks */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-5xl">
            <p className={`${eyebrowClass()} text-center`}>Real-time</p>
            <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Webhooks</h2>
            <p className={`${bodyClass()} mx-auto text-center`}>
              Set your webhook URL under Dashboard → Integrations. We'll POST these events the moment they happen —
              delivery attempts are logged and visible from your dashboard's Webhook Logs.
            </p>

            <div className="mt-10 overflow-hidden rounded-2xl border border-border bg-bg-secondary">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-bg-tertiary/50 text-left text-xs text-text-secondary">
                    <th className="px-5 py-3 font-medium">Event</th>
                    <th className="px-5 py-3 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {WEBHOOK_EVENTS.map((w) => (
                    <tr key={w.event} className="border-b border-border/60 last:border-0">
                      <td className="px-5 py-3"><code className="text-xs text-text-primary">{w.event}</code></td>
                      <td className="px-5 py-3 text-text-secondary">{w.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-6">
              <CodeBlock label="Example payload" code={WEBHOOK_PAYLOAD} />
            </div>

            <div className="mx-auto mt-6 flex max-w-2xl items-start gap-3 rounded-2xl border border-warning-500/30 bg-warning-500/10 p-5">
              <Lock size={18} className="mt-0.5 shrink-0 text-warning-500" />
              <p className="text-sm leading-relaxed text-text-secondary">
                Payloads are not currently HMAC-signed — verify by checking the event came from an IP/URL you
                control and treat the payload as informational (re-fetch via the API for anything security-sensitive).
              </p>
            </div>
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
                API and webhook access is included with Business and Enterprise plans. Generate,
                rotate, and revoke your own keys — no ticket, no wait.
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

        {/* Developer Ecosystem cross-links */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <div className="mx-auto max-w-2xl text-center">
              <p className={`${eyebrowClass()} text-center`}>Developer Ecosystem</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Beyond the raw API</h2>
            </div>
            <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { href: '/marketplace', title: 'Marketplace', body: 'Browse apps built on Vireek, or list your own.' },
                { href: '/sdks', title: 'SDKs', body: 'Official Node.js and Python client libraries.' },
                { href: '/sandbox', title: 'Sandbox', body: 'Test against synthetic calls before going live.' },
                { href: '/developers/changelog', title: 'Developer Changelog', body: 'Track every API, SDK, and webhook change.' },
              ].map(({ href, title, body }) => (
                <Link key={href} to={href} className="block h-full">
                  <Card className="h-full">
                    <h3 className="text-lg font-semibold text-text-primary">{title}</h3>
                    <p className="mt-3 text-sm leading-relaxed text-text-secondary">{body}</p>
                    <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
                      Explore <ArrowRight className="h-4 w-4" />
                    </span>
                  </Card>
                </Link>
              ))}
            </div>
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
                <Link to="/dashboard/settings/api-keys">
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    <KeyRound size={18} />
                    Generate an API Key
                  </Button>
                </Link>
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
