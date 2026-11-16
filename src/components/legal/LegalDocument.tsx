import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { LegalDoc } from '@/lib/legalDocs';

const INLINE = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
const SAFE_HREF = /^(\/[A-Za-z0-9\-_/#?=&.]*|mailto:[^\s]+|https:\/\/[^\s]+)$/;

/** Minimal, XSS-safe inline renderer: **bold** and [label](href). Everything else is plain text. */
export function renderInline(text: string): ReactNode {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="text-text-primary">{part.slice(2, -2)}</strong>;
    }
    const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (m) {
      const [, label, href] = m;
      if (!SAFE_HREF.test(href)) return <Fragment key={i}>{label}</Fragment>;
      const cls = 'font-medium text-accent underline-offset-2 hover:underline focus-ring rounded';
      return href.startsWith('/') ? (
        <Link key={i} to={href} className={cls}>{label}</Link>
      ) : (
        <a key={i} href={href} className={cls} {...(href.startsWith('https:') ? { rel: 'noopener noreferrer' } : {})}>{label}</a>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function LegalDocument({ doc }: { doc: LegalDoc }) {
  const [activeId, setActiveId] = useState<string>(doc.sections[0]?.id ?? '');
  const [mobileTocOpen, setMobileTocOpen] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-96px 0px -72% 0px' },
    );
    doc.sections.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [doc]);

  const toc = (
    <>
      {doc.sections.map((s, i) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          onClick={() => setMobileTocOpen(false)}
          aria-current={activeId === s.id ? 'true' : undefined}
          className={`-ml-px border-l-2 py-1.5 pl-4 text-sm transition-colors ${
            activeId === s.id ? 'border-accent font-medium text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'
          }`}
        >
          <span className="mr-1.5 text-text-muted">{i + 1}.</span>
          {s.title}
        </a>
      ))}
    </>
  );

  return (
    <section className="py-12 md:py-16">
      <div className="mx-auto max-w-7xl px-6">
        <header className="mb-12 max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight text-text-primary md:text-5xl">{doc.title}</h1>
          <p className="mt-4 text-lg leading-relaxed text-text-secondary">{doc.summary}</p>
          <p className="mt-3 text-sm text-text-secondary">Last updated: {formatDate(doc.updated)}</p>
        </header>

        <div className="grid gap-12 lg:grid-cols-[16rem_1fr] lg:gap-16">
          <aside className="hidden lg:block">
            <div className="sticky top-28">
              <p className="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-text-secondary">Table of Contents</p>
              <nav aria-label="Table of contents" className="flex flex-col gap-1 border-l border-border">{toc}</nav>
            </div>
          </aside>

          <div className="min-w-0 max-w-3xl">
            <div className="mb-8 lg:hidden">
              <button
                type="button"
                aria-expanded={mobileTocOpen}
                onClick={() => setMobileTocOpen((v) => !v)}
                className="focus-ring flex min-h-[48px] w-full items-center justify-between rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm font-medium text-text-primary"
              >
                Jump to section
                <ChevronDown size={18} aria-hidden="true" className={`text-text-secondary transition-transform ${mobileTocOpen ? 'rotate-180' : ''}`} />
              </button>
              {mobileTocOpen && (
                <nav aria-label="Table of contents" className="mt-2 flex flex-col gap-1 rounded-xl border border-border bg-bg-secondary p-3">{toc}</nav>
              )}
            </div>

            {doc.sections.map((s, i) => (
              <div key={s.id} className="mt-14 first:mt-0">
                <h2 id={s.id} className="scroll-mt-24 text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
                  <a href={`#${s.id}`} className="group flex items-baseline gap-3">
                    <span className="text-accent">{i + 1}.</span>
                    {s.title}
                    <span aria-hidden="true" className="ml-1 text-base font-normal text-text-secondary/0 transition-colors group-hover:text-graphic-muted">#</span>
                  </a>
                </h2>
                <div className="mt-4 space-y-4 text-base leading-relaxed text-text-secondary">
                  {s.paragraphs?.map((p, j) => <p key={j}>{renderInline(p)}</p>)}
                  {s.bullets && (
                    <ul className="ml-1 space-y-2">
                      {s.bullets.map((b, j) => <li key={j}>• {renderInline(b)}</li>)}
                    </ul>
                  )}
                  {s.callout && (
                    <div className="rounded-2xl border-2 border-accent/40 bg-accent/[0.04] p-5 md:p-6">
                      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-accent">{s.callout.label}</p>
                      <p className="mt-2">{renderInline(s.callout.text)}</p>
                    </div>
                  )}
                </div>
              </div>
            ))}

            <aside aria-labelledby="related-heading" className="mt-16 rounded-2xl border border-border bg-bg-secondary p-6">
              <h2 id="related-heading" className="text-sm font-semibold uppercase tracking-[0.18em] text-text-secondary">Related</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {doc.related.map((r) => (
                  <li key={r.href}>
                    <Link to={r.href} className="font-medium text-accent underline-offset-2 hover:underline focus-ring rounded">{r.label} &rarr;</Link>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-text-secondary">
                This document is provided for transparency and is not legal advice. See the <Link to="/terms" className="underline">Terms of Service</Link> for the binding agreement.
              </p>
            </aside>
          </div>
        </div>
      </div>
    </section>
  );
}
