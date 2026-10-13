import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Download, FileText, Loader2, ShieldCheck } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { EASE } from '@/lib/motion';
import {
  RELATED_DOCS,
  SECTIONS,
  SECTION_IDS,
  WHITEPAPER,
  estimateReadMinutes,
  formatWhitepaperDate,
  type WhitepaperBlock,
} from '@/lib/securityWhitepaper';

function SEO() {
  useEffect(() => {
    const title = `${WHITEPAPER.shortTitle} | Vireek`;
    const previousTitle = document.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousContent = meta?.getAttribute('content') ?? null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', WHITEPAPER.description);
    document.title = title;
    return () => {
      document.title = previousTitle;
      if (previousContent === null) meta?.remove();
      else meta?.setAttribute('content', previousContent);
    };
  }, []);
  return null;
}

/** Highlights the section currently in view. No-ops where IntersectionObserver is unavailable. */
function useActiveSection(ids: readonly string[]): [string, (id: string) => void] {
  const [active, setActive] = useState(ids[0] ?? '');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-15% 0px -70% 0px' },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);
  return [active, setActive];
}

function jumpTo(e: MouseEvent<HTMLAnchorElement>, id: string, onJump: (id: string) => void) {
  const el = document.getElementById(id);
  if (!el) return; // fall back to the native anchor
  e.preventDefault();
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  el.focus({ preventScroll: true });
  window.history.replaceState(null, '', `#${id}`);
  onJump(id);
}

function Block({ block }: { block: WhitepaperBlock }) {
  if (block.type === 'p') {
    return <p className="mt-4 text-sm leading-relaxed text-text-secondary first:mt-0 sm:text-base">{block.text}</p>;
  }
  if (block.type === 'ul') {
    return (
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-relaxed text-text-secondary marker:text-accent first:mt-0 sm:text-base">
        {block.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  }
  return (
    <dl className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border first:mt-0">
      {block.items.map((item) => (
        <div key={item.term} className="grid gap-1 px-4 py-3 sm:grid-cols-[13rem_1fr] sm:gap-6">
          <dt className="text-sm font-semibold text-text-primary">{item.term}</dt>
          <dd className="text-sm leading-relaxed text-text-secondary">{item.text}</dd>
        </div>
      ))}
    </dl>
  );
}

type DownloadState = 'idle' | 'loading' | 'error';

export function SecurityWhitepaperPage() {
  const [download, setDownload] = useState<DownloadState>('idle');
  const [current, setCurrent] = useActiveSection(SECTION_IDS);

  const handleDownload = useCallback(async () => {
    if (download === 'loading') return;
    setDownload('loading');
    try {
      const { downloadSecurityWhitepaperPdf } = await import('@/lib/securityWhitepaperPdf');
      await downloadSecurityWhitepaperPdf();
      setDownload('idle');
    } catch {
      setDownload('error');
    }
  }, [download]);

  const downloadButton = (
    <Button variant="primary" size="lg" onClick={() => void handleDownload()} disabled={download === 'loading'} aria-busy={download === 'loading'}>
      {download === 'loading' ? (
        <>
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          Preparing PDF…
        </>
      ) : (
        <>
          <Download size={16} aria-hidden="true" />
          Download PDF
        </>
      )}
    </Button>
  );

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-6 py-16 sm:py-24">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-3xl text-center">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <Link to="/security" className="mb-6 inline-flex items-center gap-1.5 text-sm font-semibold text-text-secondary hover:text-accent">
                <ArrowLeft size={14} aria-hidden="true" />
                Trust &amp; Security
              </Link>
              <div className="mx-auto mb-6 flex w-fit items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <FileText className="h-4 w-4 text-accent" aria-hidden="true" />
                Whitepaper
              </div>
              <h1 className="text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                How Vireek protects your business data.
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-lg leading-8 text-text-secondary">
                Architecture, encryption, account isolation, access control and AI data handling — written for security reviewers and
                procurement teams.
              </p>
              <div className="mt-8 flex flex-col items-center gap-3">
                {downloadButton}
                {download === 'error' && (
                  <p role="alert" className="text-sm text-danger">
                    We couldn&apos;t generate the PDF. Please try again, or{' '}
                    <a href="mailto:ali@vireek.com" className="font-semibold underline">
                      email us
                    </a>{' '}
                    and we&apos;ll send it.
                  </p>
                )}
                <p className="text-xs text-text-secondary">
                  Version {WHITEPAPER.version} · Updated {formatWhitepaperDate()} · {estimateReadMinutes()} min read
                </p>
              </div>
            </motion.div>
          </div>
        </section>

        <div className="mx-auto max-w-6xl px-6 py-12 sm:py-16 lg:grid lg:grid-cols-[15rem_1fr] lg:gap-12">
          <nav aria-label="Whitepaper contents" className="mb-8 lg:mb-0">
            <div className="-mx-6 flex gap-2 overflow-x-auto px-6 pb-2 lg:sticky lg:top-28 lg:mx-0 lg:block lg:space-y-1 lg:overflow-visible lg:px-0 lg:pb-0">
              <p className="mb-2 hidden text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary lg:block">Contents</p>
              {SECTIONS.map((s, i) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  onClick={(e) => jumpTo(e, s.id, setCurrent)}
                  aria-current={current === s.id ? 'location' : undefined}
                  className={`focus-ring min-h-[40px] shrink-0 whitespace-nowrap rounded-full border px-3.5 py-2 text-sm transition-colors lg:flex lg:whitespace-normal lg:rounded-lg lg:border-0 lg:px-3 lg:py-2 ${
                    current === s.id
                      ? 'border-accent/40 bg-accent/10 font-semibold text-accent'
                      : 'border-border text-text-secondary hover:text-text-primary'
                  }`}
                >
                  <span className="mr-2 tabular-nums opacity-60">{i + 1}.</span>
                  {s.title}
                </a>
              ))}
            </div>
          </nav>

          <div className="min-w-0 space-y-6">
            {SECTIONS.map((s, i) => (
              <section
                key={s.id}
                id={s.id}
                tabIndex={-1}
                aria-labelledby={`${s.id}-title`}
                className="scroll-mt-28 rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card focus:outline-none dark:shadow-card-dark sm:p-8"
              >
                <h2 id={`${s.id}-title`} className="text-xl font-bold tracking-tight text-text-primary sm:text-2xl">
                  <span className="mr-2 text-accent">{i + 1}.</span>
                  {s.title}
                </h2>
                <div className="mt-5">
                  {s.blocks.map((block, bi) => (
                    <Block key={bi} block={block} />
                  ))}
                </div>
              </section>
            ))}

            <section aria-labelledby="related-title" className="rounded-2xl border border-border bg-bg-secondary/90 p-6 shadow-card dark:shadow-card-dark sm:p-8">
              <h2 id="related-title" className="text-xl font-bold tracking-tight text-text-primary sm:text-2xl">
                Related documents
              </h2>
              <ul className="mt-5 grid gap-3 sm:grid-cols-2">
                {RELATED_DOCS.map((d) => (
                  <li key={d.href}>
                    <Link
                      to={d.href}
                      className="focus-ring flex h-full flex-col rounded-xl border border-border p-4 transition-colors hover:border-accent/40"
                    >
                      <span className="text-sm font-semibold text-text-primary">{d.label}</span>
                      <span className="mt-1 text-xs leading-relaxed text-text-secondary">{d.description}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>

            <section className="rounded-[2rem] border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:p-12">
              <ShieldCheck className="mx-auto h-8 w-8 text-accent" aria-hidden="true" />
              <h2 className="mt-4 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">Need something more specific?</h2>
              <p className="mx-auto mt-3 max-w-xl text-base leading-7 text-text-secondary">
                If your business has specific security or compliance requirements, we&apos;re happy to walk through them before you sign up.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Link to="/demo">
                  <Button variant="primary" size="lg">
                    Book a Demo <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </Link>
                <a href="mailto:ali@vireek.com">
                  <Button variant="secondary" size="lg">
                    Email security
                  </Button>
                </a>
              </div>
            </section>
          </div>
        </div>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}
