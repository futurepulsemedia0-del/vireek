// Recreated: verify against original intent
import { GitMerge } from 'lucide-react';
import { Panel } from '@/components/ui/Panel';
import { useChiefT } from '@/i18n/chiefOfStaffNamespace';
import type { ConflictRow, SuppressedRow } from '@/lib/chiefOfStaff';

interface Props {
  conflicts: ConflictRow[];
  suppressed: SuppressedRow[];
}

const SEVERITY_TONE: Record<ConflictRow['severity'], string> = {
  info: 'text-text-secondary',
  warning: 'text-warning-500',
  critical: 'text-danger',
};

/** Where two agents or goals disagreed, and which recommendations were held back because of it. */
export function CoordinationPanel({ conflicts, suppressed }: Props) {
  const { t } = useChiefT();

  return (
    <Panel title={t('conflicts.title')} aria-label={t('conflicts.title')}>
      <p className="mb-3 text-xs text-text-secondary">{t('conflicts.subtitle')}</p>

      {conflicts.length === 0 && suppressed.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-text-secondary">
          <GitMerge size={14} aria-hidden="true" />
          {t('conflicts.none')}
        </p>
      ) : (
        <div className="space-y-4">
          {conflicts.length > 0 && (
            <ul className="space-y-2">
              {conflicts.map((c) => (
                <li key={c.id} className="rounded-lg border border-border px-3 py-2">
                  <p className={`text-xs font-semibold ${SEVERITY_TONE[c.severity]}`}>
                    {t(`conflicts.rule.${c.rule_key}`, { defaultValue: c.rule_key })}
                  </p>
                  <p className="mt-0.5 text-sm text-text-primary">{c.summary}</p>
                </li>
              ))}
            </ul>
          )}

          {suppressed.length > 0 && (
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">{t('conflicts.heldBack')}</h3>
              <ul className="mt-1.5 divide-y divide-border rounded-lg border border-border">
                {suppressed.map((s) => (
                  <li key={s.id} className="px-3 py-2">
                    <p className="text-sm text-text-primary">{s.title}</p>
                    {s.suppressed_reason && <p className="text-xs text-text-secondary">{s.suppressed_reason}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
