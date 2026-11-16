import { useEffect, useId } from 'react';
import { Link } from 'react-router-dom';
import type { DeepBlock, DeepContentData } from '@/lib/deepContent/types';
import { eyebrowClass, sectionHeadingClass, bodyClass } from '@/lib/motion';

interface DeepContentProps {
  data: DeepContentData;
  /** Prefix for anchor ids so several instances/pages never collide. */
  idPrefix: string;
  /** Emit FAQPage JSON-LD for data.faqs. Keep false on pages that already emit their own FAQPage schema. */
  emitFaqSchema?: boolean;
}

function Block({ block }: { block: DeepBlock }) {
  switch (block.kind) {
    case 'p':
      return <p className="text-base leading-8 text-text-secondary">{block.text}</p>;
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag className={`${block.ordered ? 'list-decimal' : 'list-disc'} space-y-2 ps-6 text-base leading-8 text-text-secondary marker:text-accent`}>
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </Tag>
      );
    }
    case 'steps':
      return (
        <ol className="space-y-4">
          {block.items.map((step, i) => (
            <li key={step.title} className="flex gap-4 rounded-2xl border border-border bg-bg-secondary/50 p-5">
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent/10 text-sm font-semibold text-accent"
              >
                {i + 1}
              </span>
              <div>
                <h4 className="text-base font-semibold text-text-primary">{step.title}</h4>
                <p className="mt-1 text-sm leading-7 text-text-secondary">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
      );
    case 'callout':
      return (
        <aside className="rounded-2xl border border-accent/25 bg-accent/5 p-5">
          <p className="text-sm font-semibold text-text-primary">{block.title}</p>
          <p className="mt-2 text-sm leading-7 text-text-secondary">{block.text}</p>
        </aside>
      );
    case 'table':
      return (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[32rem] border-collapse text-start text-sm">
            <caption className="px-4 py-3 text-start text-xs font-medium uppercase tracking-wide text-text-secondary">
              {block.caption}
            </caption>
            <thead className="bg-bg-tertiary/60">
              <tr>
                {block.headers.map((h) => (
                  <th key={h} scope="col" className="px-4 py-3 text-start font-semibold text-text-primary">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row) => (
                <tr key={row.join('|')} className="border-t border-border">
                  {row.map((cell, ci) =>
                    ci === 0 ? (
                      <th key={`${row[0]}-${ci}`} scope="row" className="px-4 py-3 text-start font-medium text-text-primary">
                        {cell}
                      </th>
                    ) : (
                      <td key={`${row[0]}-${ci}`} className="px-4 py-3 align-top text-text-secondary">
                        {cell}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

export function DeepContent({ data, idPrefix, emitFaqSchema = false }: DeepContentProps) {
  const reactId = useId();
  const schemaId = `deep-faq-schema-${idPrefix}-${reactId.replace(/:/g, '')}`;
  const faqs = data.faqs ?? [];

  useEffect(() => {
    if (!emitFaqSchema || faqs.length === 0) return;
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = schemaId;
    script.text = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqs.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    });
    document.head.appendChild(script);
    return () => {
      script.remove();
    };
  }, [emitFaqSchema, faqs, schemaId]);

  const anchor = (id: string) => `${idPrefix}-${id}`;

  return (
    <section aria-labelledby={`${idPrefix}-deep-title`} className="px-6 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <header className="mx-auto max-w-3xl">
          <p className={eyebrowClass()}>{data.eyebrow}</p>
          <h2 id={`${idPrefix}-deep-title`} className={sectionHeadingClass()}>
            {data.title}
          </h2>
          <p className={bodyClass()}>{data.intro}</p>
        </header>

        <div className="mt-14 grid gap-12 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <nav aria-label={data.title} className="lg:sticky lg:top-28 lg:self-start">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">On this page</p>
            <ul className="mt-3 space-y-1 border-s border-border">
              {data.sections.map((s) => (
                <li key={s.id}>
                  <a
                    href={`#${anchor(s.id)}`}
                    className="focus-ring -ms-px block border-s border-transparent py-1.5 ps-4 text-sm text-text-secondary hover:border-accent hover:text-text-primary"
                  >
                    {s.title}
                  </a>
                </li>
              ))}
              {faqs.length > 0 && (
                <li>
                  <a
                    href={`#${anchor('faq')}`}
                    className="focus-ring -ms-px block border-s border-transparent py-1.5 ps-4 text-sm text-text-secondary hover:border-accent hover:text-text-primary"
                  >
                    Common questions
                  </a>
                </li>
              )}
            </ul>
            {data.related && data.related.length > 0 && (
              <div className="mt-8">
                <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Related</p>
                <ul className="mt-3 space-y-1">
                  {data.related.map((r) => (
                    <li key={r.href}>
                      <Link to={r.href} className="focus-ring block rounded py-1 text-sm text-accent hover:underline">
                        {r.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </nav>

          <div className="min-w-0 space-y-16">
            {data.sections.map((section) => (
              <article key={section.id} id={anchor(section.id)} className="scroll-mt-28 space-y-5">
                <h3 className="font-display text-2xl font-medium tracking-tight text-text-primary md:text-3xl">
                  {section.title}
                </h3>
                {section.blocks.map((block, i) => (
                  <Block key={`${section.id}-${i}`} block={block} />
                ))}
              </article>
            ))}

            {faqs.length > 0 && (
              <article id={anchor('faq')} className="scroll-mt-28 space-y-4">
                <h3 className="font-display text-2xl font-medium tracking-tight text-text-primary md:text-3xl">
                  Common questions
                </h3>
                <div className="divide-y divide-border rounded-2xl border border-border">
                  {faqs.map((f) => (
                    <details key={f.q} className="group p-5">
                      <summary className="focus-ring cursor-pointer list-none rounded-lg text-base font-semibold text-text-primary marker:hidden">
                        {f.q}
                      </summary>
                      <p className="mt-3 text-sm leading-7 text-text-secondary">{f.a}</p>
                    </details>
                  ))}
                </div>
              </article>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
