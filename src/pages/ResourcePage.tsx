import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Link, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, CheckCircle2, Copy, Download } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { ResourceGate } from '@/components/resources/ResourceGate';
import { MissedCallCalculator } from '@/components/sections/MissedCallCalculator';
import { EstimateRoiCalculator } from '@/components/sections/EstimateRoiCalculator';
import { EASE, eyebrowClass } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { readUnlock } from '@/lib/resourceLeads';
import {
  KIND_LABEL,
  getPublishedResource,
  publishedResources,
  resourcePath,
  resourceUrl,
  resourceJsonLd,
} from '@/lib/resources';
import type { CalculatorId, EbookResource, Resource, TemplateResource } from '@/lib/resources';

const CALCULATORS: Record<CalculatorId, ComponentType> = {
  'missed-call': MissedCallCalculator,
  'estimate-roi': EstimateRoiCalculator,
};

function downloadTextFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TemplateContent({ resource }: { resource: TemplateResource }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(resource.body);
      setState('copied');
    } catch {
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2500);
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-semibold text-text-primary">{resource.fileName}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={handleCopy}>
            <Copy size={14} aria-hidden="true" /> Copy
          </Button>
          <Button variant="secondary" size="sm" onClick={() => downloadTextFile(resource.fileName, resource.body)}>
            <Download size={14} aria-hidden="true" /> Download
          </Button>
        </div>
      </div>
      <p className="mt-2 min-h-[1.25rem] text-xs text-text-secondary" role="status" aria-live="polite">
        {state === 'copied' && 'Copied to clipboard.'}
        {state === 'failed' && "Couldn't copy automatically. Select the text and copy it manually."}
      </p>
      <pre className="mt-2 max-h-[560px] overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-bg-primary p-4 font-sans text-sm leading-relaxed text-text-primary">
        {resource.body}
      </pre>
    </div>
  );
}

function EbookContent({ resource }: { resource: EbookResource }) {
  if (!resource.fileUrl) return null;
  const fileUrl = resource.fileUrl;
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 text-center sm:p-10">
      <h2 className="text-xl font-bold text-text-primary">Your ebook is ready</h2>
      {resource.pages && <p className="mt-1 text-sm text-text-secondary">PDF · {resource.pages} pages</p>}
      <Button size="lg" className="mt-6" onClick={() => window.open(fileUrl, '_blank', 'noopener,noreferrer')}>
        <Download size={16} aria-hidden="true" /> Download PDF
      </Button>
    </div>
  );
}

function ResourceContent({ resource }: { resource: Resource }) {
  if (resource.kind === 'template') return <TemplateContent resource={resource} />;
  if (resource.kind === 'ebook') return <EbookContent resource={resource} />;
  const Calculator = CALCULATORS[resource.calculator];
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-8">
      <Calculator />
    </div>
  );
}

export function ResourcePage() {
  const { slug } = useParams<{ slug: string }>();
  const resource = useMemo(() => getPublishedResource(slug ?? ''), [slug]);
  const [unlocked, setUnlocked] = useState(() => readUnlock());

  useSEO(
    resource
      ? {
          title: `${resource.title} — Free ${KIND_LABEL[resource.kind]} | Vireek`,
          description: resource.summary,
          canonical: resourceUrl(resource.slug),
          jsonLd: resourceJsonLd(resource),
        }
      : {
          title: 'Resource not found — Vireek',
          description: 'This resource is not available.',
          canonical: 'https://vireek.com/resources',
        },
  );

  const related = useMemo(
    () => publishedResources().filter((r) => r.slug !== slug).slice(0, 3),
    [slug],
  );

  if (!resource) {
    return (
      <>
        <Header />
        <main className="flex min-h-screen items-center justify-center bg-bg-primary px-6 pt-24">
          <div className="max-w-md text-center">
            <h1 className="text-2xl font-bold text-text-primary">This resource isn't available</h1>
            <p className="mt-2 text-sm text-text-secondary">The link may be wrong, or the resource has moved.</p>
            <Link to="/resources" className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline">
              Browse all resources <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </div>
        </main>
        <Footer />
        <CookieConsent />
      </>
    );
  }

  const updatedLabel = new Date(resource.updated).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  const details = (
    <div>
      <p className="text-base leading-relaxed text-text-secondary sm:text-lg">{resource.description}</p>
      <ul className="mt-6 space-y-3">
        {resource.highlights.map((h) => (
          <li key={h} className="flex items-start gap-3 text-sm text-text-primary sm:text-base">
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
            {h}
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-6 py-14 sm:py-20">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <BackButton fallback="/resources" />
            </div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
            >
              <p className={eyebrowClass()}>
                Free {KIND_LABEL[resource.kind]} · Updated {updatedLabel}
              </p>
              <h1 className="mt-4 text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                {resource.title}
              </h1>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-text-secondary">{resource.summary}</p>
            </motion.div>
          </div>
        </section>

        <section className="px-6 py-12 sm:py-16">
          {unlocked ? (
            <div className="mx-auto max-w-5xl space-y-10">
              <p className="inline-flex items-center gap-2 rounded-full bg-success/10 px-4 py-1.5 text-sm font-semibold text-success">
                <CheckCircle2 size={16} aria-hidden="true" /> Unlocked
              </p>
              <ResourceContent resource={resource} />
              {details}
            </div>
          ) : (
            <div className="mx-auto grid max-w-5xl gap-10 lg:grid-cols-[1fr_420px] lg:items-start">
              {details}
              <div className="lg:sticky lg:top-28">
                <ResourceGate
                  resourceSlug={resource.slug}
                  resourceTitle={resource.title}
                  onUnlocked={() => setUnlocked(true)}
                />
              </div>
            </div>
          )}
        </section>

        {related.length > 0 && (
          <section className="border-t border-border px-6 py-14">
            <div className="mx-auto max-w-5xl">
              <h2 className="text-xl font-bold text-text-primary">More free resources</h2>
              <ul className="mt-6 grid gap-4 sm:grid-cols-3">
                {related.map((r) => (
                  <li key={r.slug}>
                    <Link
                      to={resourcePath(r.slug)}
                      className="focus-ring block h-full rounded-2xl border border-border bg-bg-secondary p-5 transition-colors hover:border-accent/40"
                    >
                      <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                        {KIND_LABEL[r.kind]}
                      </p>
                      <p className="mt-2 text-base font-semibold text-text-primary">{r.title}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
