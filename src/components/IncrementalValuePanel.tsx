import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import enIncrementality from '@/locales/incrementality/en.json';
import { Card } from '@/components/ui/Card';
import { formatMoney, type IncrementalRow } from '../../supabase/functions/_shared/value-scoreboard/engine';

export const INCREMENTALITY_NS = 'incrementality';

if (!i18n.hasResourceBundle('en', INCREMENTALITY_NS)) {
  i18n.addResourceBundle('en', INCREMENTALITY_NS, enIncrementality, true, true);
}

interface Props {
  rows: readonly IncrementalRow[];
}

/**
 * Third value tier. Always shows the interval next to the point estimate, never the point alone, and
 * never contributes to any total. Rendered as its own section so it cannot be read as part of the
 * measured or estimated figures.
 */
export function IncrementalValuePanel({ rows }: Props) {
  const { t, i18n: inst } = useTranslation(INCREMENTALITY_NS);
  const fmtDate = (iso: string) => new Intl.DateTimeFormat(inst.language, { dateStyle: 'medium' }).format(new Date(iso));

  return (
    <section aria-labelledby="vs-incremental">
      <Card>
      <h2 id="vs-incremental" className="text-lg font-semibold text-text-primary">{t('title')}</h2>
      <p className="mt-1 text-sm text-text-secondary">{t('intro')}</p>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-text-secondary">{t('empty')}</p>
      ) : (
        <ul className="mt-4 space-y-4">
          {rows.map((r) => (
            <li key={r.id} className="border-t border-border pt-4 first:border-t-0 first:pt-0">
              <p className="text-xs font-medium text-text-secondary">{t('tierBadge')} · {t('period', { date: fmtDate(r.occurredAt) })}</p>
              <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-text-secondary">{t('rangeLabel')}</dt>
                  <dd className="text-2xl font-bold text-text-primary">
                    {t('rangeValue', { low: formatMoney(r.ciLowCents, r.currency), high: formatMoney(r.ciHighCents, r.currency) })}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-text-secondary">{t('pointLabel')}</dt>
                  <dd className="text-base text-text-primary">{formatMoney(r.pointCents, r.currency)}</dd>
                </div>
              </dl>
              <p className="mt-2 text-sm text-text-secondary">
                {r.spansZero ? t('spansZero') : r.ciHighCents < 0 ? t('negative') : t('excludesZero')}
              </p>
              <p className="mt-1 text-xs text-text-secondary">{r.methodNote}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-text-secondary">{t('notBilling')}</p>
      </Card>
    </section>
  );
}
