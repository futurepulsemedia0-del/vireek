import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { BookOpen, Check, Copy, FileJson, KeyRound, Send } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { ApiPlayground } from '@/components/sandbox/ApiPlayground';
import { ApiRequestLogs } from '@/components/developers/ApiRequestLogs';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { SANDBOX_ENDPOINTS, buildCurl } from '@/lib/sandbox';
import {
  ERROR_RESPONSES,
  LIST_PARAMETERS,
  RESOURCES,
  buildOpenApiSpec,
  buildPostmanCollection,
  downloadJsonFile,
  resolveApiBaseUrl,
  resourceOfEndpoint,
  type ResourceDef,
} from '@/lib/openapi';

const METHOD_CLASS = 'rounded-md bg-success-500/10 px-2 py-0.5 font-mono text-xs font-bold text-success-500';

function SEO() {
  useSEO({
    title: 'API Reference — OpenAPI, Playground & Request Logs | Vireek',
    description:
      'Complete Vireek API reference: OpenAPI 3 spec, Postman collection, a live playground and per-key request logs for calls, leads and jobs.',
    canonical: 'https://vireek.com/developers/api-reference',
  });
  return null;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable (insecure context / denied) */
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={label}
      className="focus-ring rounded-lg border border-border bg-bg-secondary/90 p-1.5 text-text-secondary transition hover:text-text-primary"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function FieldsTable({ resource }: { resource: ResourceDef }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-bg-tertiary/60 text-xs uppercase tracking-wide text-text-secondary">
          <tr>
            <th className="px-4 py-2.5 font-medium">Field</th>
            <th className="px-4 py-2.5 font-medium">Type</th>
            <th className="px-4 py-2.5 font-medium">Description</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {resource.fields.map((field) => (
            <tr key={field.name}>
              <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-text-primary">{field.name}</td>
              <td className="whitespace-nowrap px-4 py-2 text-xs text-text-secondary">
                {field.type === 'array' ? 'string[]' : field.format ?? field.type}
                {field.nullable ? ' | null' : ''}
              </td>
              <td className="px-4 py-2 text-text-secondary">{field.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ApiReferencePage() {
  const baseUrl = useMemo(() => resolveApiBaseUrl(), []);
  const [copiedBase, setCopiedBase] = useState(false);

  const copyBase = async () => {
    try {
      await navigator.clipboard.writeText(baseUrl);
      setCopiedBase(true);
      setTimeout(() => setCopiedBase(false), 1800);
    } catch {
      /* ignore */
    }
  };

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
              <p className={eyebrowClass()}>Developers</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                API Reference
              </h1>
              <p className={`mx-auto mt-6 max-w-2xl ${bodyClass()}`}>
                Read-only access to your calls, leads and jobs. Import the OpenAPI spec or Postman collection,
                try live requests in the playground, and audit every request each key has made.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Button
                  variant="primary"
                  size="lg"
                  onClick={() => downloadJsonFile('vireek-openapi.json', buildOpenApiSpec(baseUrl))}
                >
                  <FileJson className="h-4 w-4" />
                  Download OpenAPI 3 spec
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={() => downloadJsonFile('vireek.postman_collection.json', buildPostmanCollection(baseUrl))}
                >
                  <Send className="h-4 w-4" />
                  Download Postman collection
                </Button>
              </div>
              <Link
                to="/docs"
                className="focus-ring mt-4 inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
              >
                <BookOpen className="h-4 w-4" />
                Guides &amp; webhooks
              </Link>
            </motion.div>
          </div>
        </section>

        {/* Basics */}
        <section className="px-6 py-12">
          <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-2">
            <Card className="border-border bg-bg-secondary/60 p-6 hover:translate-y-0">
              <h2 className="text-base font-semibold text-text-primary">Base URL</h2>
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-bg-primary p-3">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-text-primary">{baseUrl}</code>
                <button
                  type="button"
                  onClick={() => void copyBase()}
                  aria-label="Copy base URL"
                  className="focus-ring shrink-0 rounded-lg border border-border bg-bg-secondary/90 p-1.5 text-text-secondary transition hover:text-text-primary"
                >
                  {copiedBase ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
              <h2 className="mt-6 text-base font-semibold text-text-primary">Authentication</h2>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                Send your key as a bearer token. Keys are scoped per resource — create, rotate or revoke them in{' '}
                <Link to="/dashboard/settings/api-keys" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                  <KeyRound size={12} /> Settings → API Keys
                </Link>
                .
              </p>
              <pre className="mt-3 overflow-x-auto rounded-xl border border-border bg-bg-primary p-3 font-mono text-xs text-text-primary">
                Authorization: Bearer vrk_live_…
              </pre>
            </Card>

            <Card className="border-border bg-bg-secondary/60 p-6 hover:translate-y-0">
              <h2 className="text-base font-semibold text-text-primary">Pagination</h2>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                List endpoints return newest first as <code className="font-mono text-xs">{'{ data, has_more, next_before }'}</code>.
                Pass <code className="font-mono text-xs">next_before</code> back as <code className="font-mono text-xs">before</code> for the next page.
              </p>
              <ul className="mt-3 space-y-2 text-sm">
                {LIST_PARAMETERS.map((p) => (
                  <li key={p.name} className="rounded-xl border border-border bg-bg-primary px-3 py-2">
                    <code className="font-mono text-xs font-semibold text-text-primary">{p.name}</code>
                    <span className="ml-2 text-xs text-text-secondary">{p.type}</span>
                    <p className="mt-0.5 text-text-secondary">{p.description}</p>
                  </li>
                ))}
              </ul>
              <h2 className="mt-6 text-base font-semibold text-text-primary">Errors</h2>
              <ul className="mt-3 space-y-1.5 text-sm">
                {Object.entries(ERROR_RESPONSES).map(([code, description]) => (
                  <li key={code} className="flex gap-3">
                    <code className="w-9 shrink-0 font-mono text-xs font-semibold text-text-primary">{code}</code>
                    <span className="text-text-secondary">{description}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </section>

        {/* Endpoints */}
        <section className="px-6 pb-4">
          <div className="mx-auto max-w-6xl space-y-10">
            <div>
              <h2 className={sectionHeadingClass()}>Endpoints</h2>
              <p className={`mt-2 max-w-2xl ${bodyClass()}`}>
                Generated from the same catalog as the spec and the playground, so this page never drifts from what you download.
              </p>
            </div>
            {RESOURCES.map((resource) => {
              const endpoints = SANDBOX_ENDPOINTS.filter((ep) => resourceOfEndpoint(ep) === resource.name);
              return (
                <div key={resource.name} id={resource.name} className="scroll-mt-28">
                  <h3 className="text-xl font-bold text-text-primary">{resource.tag}</h3>
                  <p className="mt-1 text-sm text-text-secondary">{resource.description}</p>
                  <ul className="mt-4 space-y-3">
                    {endpoints.map((ep) => {
                      const curl = buildCurl({
                        method: ep.method,
                        url: `${baseUrl}${ep.hasId ? ep.path.replace(':id', '<id>') : `${ep.path}?limit=25`}`,
                        apiKey: '',
                      });
                      return (
                        <li key={ep.id} className="rounded-2xl border border-border bg-bg-secondary/60 p-4 sm:p-5">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <span className={METHOD_CLASS}>{ep.method}</span>
                            <code className="break-all font-mono text-sm text-text-primary">{ep.path}</code>
                            <span className="rounded-full bg-accent/10 px-2.5 py-0.5 font-mono text-[11px] text-accent">{ep.scope}</span>
                          </div>
                          <p className="mt-2 text-sm text-text-secondary">{ep.description}</p>
                          <div className="relative mt-3">
                            <pre className="overflow-x-auto rounded-xl border border-border bg-bg-primary p-3 pr-12 font-mono text-xs leading-relaxed text-text-primary">
                              {curl}
                            </pre>
                            <div className="absolute right-2 top-2">
                              <CopyButton value={curl} label={`Copy cURL for ${ep.method} ${ep.path}`} />
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <details className="group mt-4">
                    <summary className="focus-ring cursor-pointer select-none rounded-lg text-sm font-semibold text-accent hover:underline">
                      {resource.schema} object fields
                    </summary>
                    <div className="mt-3">
                      <FieldsTable resource={resource} />
                    </div>
                  </details>
                </div>
              );
            })}
          </div>
        </section>

        {/* Playground */}
        <section id="playground" className="scroll-mt-28 px-6 py-10">
          <div className="mx-auto max-w-6xl space-y-6">
            <div>
              <h2 className={sectionHeadingClass()}>Try it</h2>
              <p className={`mt-2 max-w-2xl ${bodyClass()}`}>
                Live requests against your account with a key you paste in. Anything you send here shows up in the request logs below.
              </p>
            </div>
            <ApiPlayground />
          </div>
        </section>

        {/* Logs */}
        <section id="logs" className="scroll-mt-28 px-6 pb-20">
          <div className="mx-auto max-w-6xl space-y-6">
            <div>
              <h2 className={sectionHeadingClass()}>Request logs</h2>
              <p className={`mt-2 max-w-2xl ${bodyClass()}`}>
                Method, path, status and latency for every authenticated request, per key. The key itself is never logged.
              </p>
            </div>
            <ApiRequestLogs />
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
