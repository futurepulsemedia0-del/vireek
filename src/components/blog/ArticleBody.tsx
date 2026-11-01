import { Fragment, lazy, Suspense, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, BarChart3, Lightbulb } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { blogEvents } from '@/lib/blogAnalytics';
import type { Block, CtaType, Inline } from '@/lib/blogTypes';

const MissedCallCalculator = lazy(() =>
  import('@/components/sections/MissedCallCalculator').then((m) => ({ default: m.MissedCallCalculator })),
);

const linkClass =
  'focus-ring rounded-sm font-medium text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent';

function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  if (href.startsWith('/')) return <Link to={href} className={linkClass}>{children}</Link>;
  if (href.startsWith('#') || href.startsWith('mailto:')) return <a href={href} className={linkClass}>{children}</a>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
      {children}
    </a>
  );
}

/** Renders the inline AST. Every string is a React text node, so content can never inject markup. */
export function InlineContent({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'text':
            return <Fragment key={i}>{n.v}</Fragment>;
          case 'code':
            return <code key={i} className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[0.9em] text-text-primary">{n.v}</code>;
          case 'strong':
            return <strong key={i} className="font-semibold text-text-primary"><InlineContent nodes={n.c} /></strong>;
          case 'em':
            return <em key={i}><InlineContent nodes={n.c} /></em>;
          case 'link':
            return <InlineLink key={i} href={n.href}><InlineContent nodes={n.c} /></InlineLink>;
        }
      })}
    </>
  );
}

const CTA_DEFAULTS: Record<CtaType, { to: string; heading: string; button: string }> = {
  trial: { to: '/login', heading: 'Try Vireek free', button: 'Start Free Trial' },
  demo: { to: '/demo', heading: 'See Vireek answer a real call', button: 'Book a Demo' },
  pricing: { to: '/pricing', heading: 'See what Vireek costs', button: 'View Pricing' },
  calculator: { to: '/calculator', heading: 'Put a number on your missed calls', button: 'Open the Calculator' },
};

export function CtaCard({
  slug,
  type,
  heading,
  button,
  body,
  placement,
}: {
  slug: string;
  type: CtaType;
  heading?: string;
  button?: string;
  body?: Inline[];
  placement: 'inline' | 'end';
}) {
  const d = CTA_DEFAULTS[type];
  return (
    <aside aria-label="Call to action" className="not-prose rounded-3xl border border-border bg-bg-secondary p-6 text-center shadow-card dark:shadow-card-dark sm:p-8">
      <p className="text-xl font-bold tracking-tight text-text-primary">{heading || d.heading}</p>
      {body && body.length > 0 && (
        <p className="mx-auto mt-2 max-w-xl text-base leading-7 text-text-secondary"><InlineContent nodes={body} /></p>
      )}
      <div className="mt-5 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link to={d.to} onClick={() => blogEvents.ctaClick(slug, type, placement)}>
          <Button variant="primary" size="lg">{button || d.button}</Button>
        </Link>
        {placement === 'end' && type !== 'demo' && (
          <Link to="/demo" onClick={() => blogEvents.ctaClick(slug, 'demo', placement)} className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent">
            Book a Demo <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        )}
      </div>
    </aside>
  );
}

const CALLOUT = {
  tip: { Icon: Lightbulb, label: 'Tip', box: 'border-accent/30 bg-accent/[0.04]', chip: 'bg-accent/15 text-accent' },
  stat: { Icon: BarChart3, label: 'Stat', box: 'border-accent/30 bg-accent/[0.04]', chip: 'bg-accent/15 text-accent' },
  warning: { Icon: AlertTriangle, label: 'Warning', box: 'border-amber-500/40 bg-amber-500/10', chip: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
} as const;

function Blocks({ blocks, slug }: { blocks: Block[]; slug: string }) {
  const calcUsed = useRef(false);
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h2':
            return <h2 key={i} id={b.id} className="scroll-mt-28 !mt-12 text-2xl font-bold tracking-tight text-text-primary"><InlineContent nodes={b.c} /></h2>;
          case 'h3':
            return <h3 key={i} id={b.id} className="scroll-mt-28 !mt-8 text-xl font-semibold tracking-tight text-text-primary"><InlineContent nodes={b.c} /></h3>;
          case 'p':
            return <p key={i}><InlineContent nodes={b.c} /></p>;
          case 'ul':
            return (
              <ul key={i} className="ml-1 space-y-2.5">
                {b.items.map((it, j) => (
                  <li key={j} className="flex gap-3">
                    <span aria-hidden="true" className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    <span><InlineContent nodes={it} /></span>
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} className="ml-6 list-decimal space-y-2.5 marker:font-semibold marker:text-accent">
                {b.items.map((it, j) => <li key={j} className="pl-1"><InlineContent nodes={it} /></li>)}
              </ol>
            );
          case 'quote':
            return (
              <blockquote key={i} className="!my-10 border-l-4 border-accent pl-6 text-2xl font-semibold leading-snug tracking-tight text-text-primary">
                <InlineContent nodes={b.c} />
              </blockquote>
            );
          case 'table':
            return (
              <div key={i} role="region" aria-label="Table, scrolls horizontally on small screens" tabIndex={0} className="focus-ring overflow-x-auto rounded-2xl border border-border">
                <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
                  <thead className="bg-bg-secondary">
                    <tr>{b.head.map((h, j) => <th key={j} scope="col" className="px-4 py-3 font-semibold text-text-primary"><InlineContent nodes={h} /></th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j} className="border-t border-border align-top">
                        {r.map((c, k) => <td key={k} className="px-4 py-3 leading-6"><InlineContent nodes={c} /></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'callout': {
            const c = CALLOUT[b.kind];
            return (
              <div key={i} role="note" className={`flex gap-4 rounded-2xl border-2 p-5 sm:p-6 ${c.box}`}>
                <span aria-hidden="true" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${c.chip}`}><c.Icon className="h-4 w-4" /></span>
                <div className="min-w-0 space-y-3 text-base leading-7 text-text-primary">
                  <p className="text-xs font-semibold uppercase tracking-wider text-text-secondary">{c.label}</p>
                  <Blocks blocks={b.c} slug={slug} />
                </div>
              </div>
            );
          }
          case 'takeaways':
            return (
              <section key={i} aria-label="Key takeaways" className="rounded-2xl border border-accent/30 bg-accent/[0.04] p-6">
                <p className="text-sm font-semibold uppercase tracking-wider text-accent">Key takeaways</p>
                <ul className="mt-4 space-y-3 text-text-primary">
                  {b.items.map((it, j) => (
                    <li key={j} className="flex gap-3"><span aria-hidden="true" className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /><span><InlineContent nodes={it} /></span></li>
                  ))}
                </ul>
              </section>
            );
          case 'steps':
            return (
              <ol key={i} role="list" className="space-y-4">
                {b.items.map((it, j) => (
                  <li key={j} className="flex gap-4 rounded-2xl border border-border bg-bg-secondary p-5">
                    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-white">{j + 1}</span>
                    <span className="pt-0.5 text-text-primary"><InlineContent nodes={it} /></span>
                  </li>
                ))}
              </ol>
            );
          case 'cta':
            return <CtaCard key={i} slug={slug} type={b.type} heading={b.heading} button={b.button} body={b.body} placement="inline" />;
          case 'calculator':
            return (
              <div
                key={i}
                className="-mx-2 rounded-3xl border border-border bg-bg-secondary/40 sm:mx-0"
                onChangeCapture={() => { if (!calcUsed.current) { calcUsed.current = true; blogEvents.calculatorUse(slug); } }}
                onPointerDownCapture={() => { if (!calcUsed.current) { calcUsed.current = true; blogEvents.calculatorUse(slug); } }}
              >
                <Suspense fallback={<div className="h-96 animate-pulse rounded-3xl bg-bg-tertiary" aria-busy="true" />}>
                  <MissedCallCalculator />
                </Suspense>
              </div>
            );
          case 'figure':
            return (
              <figure key={i} className="!my-10">
                <img src={b.src} alt={b.alt} width={b.width} height={b.height} loading="lazy" decoding="async" className="h-auto w-full rounded-2xl border border-border" />
                {b.caption.length > 0 && <figcaption className="mt-3 text-center text-sm text-text-secondary"><InlineContent nodes={b.caption} /></figcaption>}
              </figure>
            );
        }
      })}
    </>
  );
}

export function ArticleBody({ blocks, slug }: { blocks: Block[]; slug: string }) {
  return (
    <div className="space-y-6 text-base leading-8 text-text-secondary">
      <Blocks blocks={blocks} slug={slug} />
    </div>
  );
}
