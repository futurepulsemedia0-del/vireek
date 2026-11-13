// Recreated: verify against original intent
import { Panel } from '@/components/ui/Panel';
import { useChiefT } from '@/i18n/chiefOfStaffNamespace';
import type { UsefulnessRow } from '@/lib/chiefOfStaff';

interface Props {
  rows: UsefulnessRow[];
}

/** Honest feedback loop: per source engine, how many recommendations were done / dismissed / expired. */
export function UsefulnessPanel({ rows }: Props) {
  const { t, language } = useChiefT();
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 0 });

  if (rows.length === 0) return null;

  return (
    <Panel title={t('usefulness.title')} aria-label={t('usefulness.title')}>
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.source_engine}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-text-primary">
                {t(`rec.engine.${r.source_engine}`, { defaultValue: r.source_engine })}
              </span>
              {/* No rate is shown until the server has enough decisions to compute one: never a made-up 0%. */}
              <span className="text-xs text-text-secondary">
                {r.accept_rate_pct === null ? t('usefulness.notEnough') : t('usefulness.rate', { rate: number.format(r.accept_rate_pct) })}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-text-secondary">
              {t('usefulness.row', { accepted: r.accepted, dismissed: r.dismissed, expired: r.expired })}
            </p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
