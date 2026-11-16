import { Mail, Megaphone, MessageSquareText, Repeat, ScanLine, ScrollText, Star } from 'lucide-react';
import { asRecords, useHomeT } from '@/i18n/homeNamespace';
import { container, eyebrow, h2, sectionY } from './sectionStyles';

const ICONS = [MessageSquareText, Mail, Star, Repeat, Megaphone, ScanLine, ScrollText] as const;

/** Varied tile widths on a 6-column grid (4+2, 2+2+2, 3+3). Two columns on tablets, one on phones. */
const SPANS = [
  'md:col-span-2 lg:col-span-4',
  'lg:col-span-2',
  'lg:col-span-2',
  'lg:col-span-2',
  'lg:col-span-2',
  'lg:col-span-3',
  'md:col-span-2 lg:col-span-3',
] as const;

export function BentoGrid() {
  const { t } = useHomeT();
  const items = asRecords(t('bento.items', { returnObjects: true }), ['title', 'body'] as const);

  return (
    <section id="features" aria-labelledby="bento-heading" className={`${sectionY} border-t border-border`}>
      <div className={container}>
        <p className={eyebrow}>{t('bento.eyebrow')}</p>
        <h2 id="bento-heading" className={h2}>{t('bento.title')}</h2>

        <ul className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-6">
          {items.map((item, i) => {
            const Icon = ICONS[i] ?? ICONS[0];
            return (
              <li
                key={item.title}
                className={`${SPANS[i] ?? ''} rounded-2xl border border-border bg-bg-secondary p-6 motion-safe:transition-[transform,box-shadow] motion-safe:duration-200 motion-safe:hover:-translate-y-0.5 hover:shadow-card-hover dark:hover:shadow-card-hover-dark`}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
                  <Icon size={18} aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-lg font-semibold text-text-primary">{item.title}</h3>
                <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-text-secondary">{item.body}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
