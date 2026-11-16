import { Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import { asStrings, useHomeT } from '@/i18n/homeNamespace';
import { MockWindow, mockChip, mockRow } from './MockWindow';
import { container, eyebrow, h2, lead, sectionY, textLink } from './sectionStyles';

const KEYS = ['answer', 'dispatch', 'money', 'intel'] as const;
type BlockKey = (typeof KEYS)[number];

/** Visuals are static markup with made-up data. Strings come from home.json so they follow the page language. */
function Visual({ kind }: { kind: BlockKey }) {
  const { t } = useHomeT();
  const base = { exampleLabel: t('common.example'), ariaLabel: t('common.example') };
  const rows = (key: string) => asStrings(t(`showcase.mock.${key}`, { returnObjects: true }));

  if (kind === 'answer') {
    return (
      <MockWindow title={t('showcase.mock.callTitle')} {...base}>
        {rows('callRows').map((r) => (
          <div key={r} className={mockRow}><span className="text-text-primary">{r}</span></div>
        ))}
        <p><span className={mockChip}>{t('showcase.mock.callChip')}</span></p>
      </MockWindow>
    );
  }
  if (kind === 'dispatch') {
    const board = Array.from({ length: 3 }, (_, i) => ({
      tech: t(`showcase.mock.boardRows.${i}.tech`),
      job: t(`showcase.mock.boardRows.${i}.job`),
    }));
    return (
      <MockWindow title={t('showcase.mock.boardTitle')} {...base}>
        {board.map((r) => (
          <div key={r.tech} className={mockRow}>
            <span className="font-semibold text-text-primary">{r.tech}</span>
            <span>{r.job}</span>
          </div>
        ))}
        <p><span className={mockChip}>{t('showcase.mock.boardChip')}</span></p>
      </MockWindow>
    );
  }
  if (kind === 'money') {
    return (
      <MockWindow title={t('showcase.mock.invoiceTitle')} {...base}>
        {rows('invoiceRows').map((r) => (
          <div key={r} className={mockRow}><span>{r}</span></div>
        ))}
        <div className={mockRow}>
          <span className="font-semibold text-text-primary">{t('showcase.mock.invoiceTotal')}</span>
          <strong className="text-text-primary" dir="ltr">{t('showcase.mock.invoiceAmount')}</strong>
        </div>
        <p><span className={mockChip}>{t('showcase.mock.invoiceChip')}</span></p>
      </MockWindow>
    );
  }
  return (
    <MockWindow title={t('showcase.mock.unitTitle')} {...base}>
      {rows('unitRows').map((r) => (
        <div key={r} className={mockRow}><span className="text-text-primary">{r}</span></div>
      ))}
      <p><span className={mockChip}>{t('showcase.mock.unitChip')}</span></p>
    </MockWindow>
  );
}

export function FeatureShowcase() {
  const { t } = useHomeT();

  return (
    <section id="product" aria-labelledby="product-heading" className={`${sectionY} border-t border-border`}>
      <div className={container}>
        <p className={eyebrow}>{t('showcase.eyebrow')}</p>
        <h2 id="product-heading" className={h2}>{t('showcase.title')}</h2>
        <p className={lead}>{t('showcase.lead')}</p>

        <div className="mt-14 space-y-16 sm:space-y-24">
          {KEYS.map((key, i) => {
            const bullets = asStrings(t(`showcase.blocks.${i}.bullets`, { returnObjects: true }));
            return (
              <article key={key} className="grid items-center gap-8 lg:grid-cols-2 lg:gap-16">
                {/* Alternating layout: `order` follows the writing direction, so RTL mirrors automatically. */}
                <div className={i % 2 === 1 ? 'lg:order-2' : ''}>
                  <h3 className="text-balance font-display text-2xl font-semibold leading-snug tracking-tight text-text-primary rtl:tracking-normal sm:text-3xl">
                    {t(`showcase.blocks.${i}.title`)}
                  </h3>
                  <p className="mt-3 max-w-prose text-base leading-relaxed text-text-secondary">
                    {t(`showcase.blocks.${i}.body`)}
                  </p>
                  <ul className="mt-5 space-y-2.5">
                    {bullets.map((b) => (
                      <li key={b} className="flex items-start gap-2.5 text-sm text-text-primary sm:text-base">
                        <Check size={16} aria-hidden="true" className="mt-1 shrink-0 text-text-secondary" />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="mx-auto w-full max-w-md">
                  <Visual kind={key} />
                </div>
              </article>
            );
          })}
        </div>

        <div className="mt-12">
          <Link to="/platform" className={textLink}>{t('bento.more')}</Link>
        </div>
      </div>
    </section>
  );
}
