import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { computeKnowledge } from '@/lib/sarahKnowledge';
import type { LearnField, LearnRun } from '@/pages/onboarding/sarah/sarahLearnLogic';
import { KnowledgeRing } from './KnowledgeRing';
import { HUB_NS } from './sarahHubI18n';

interface Props {
  run: LearnRun | null;
  fields: readonly LearnField[];
}

/** Hub header: score, coverage per area, and the three gaps that would help most. */
export function SarahKnowledgeSummary({ run, fields }: Props) {
  const { t } = useTranslation(HUB_NS);
  const snap = useMemo(() => computeKnowledge(run, fields), [run, fields]);
  if (!run) return null;
  const top = snap.gaps.slice(0, 3);

  return (
    <section aria-labelledby="sk-summary" className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <div className="flex items-center gap-4">
        <KnowledgeRing size={72} score={snap.score} label={t('card.scoreAria', { score: snap.score })} valueText={t('card.scoreLabel', { score: snap.score })} />
        <div className="min-w-0">
          <h2 id="sk-summary" className="text-base font-semibold text-text-primary">
            {t('summary.heading')}
          </h2>
          <p className="text-sm text-text-secondary">{t(`card.tier.${snap.tier}`)}</p>
        </div>
      </div>

      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('summary.coverage')}</h3>
      <ul className="mt-2 space-y-2">
        {snap.groups.map((g) => (
          <li key={g.group} className="flex items-center gap-3 text-sm">
            <span className="w-36 shrink-0 truncate text-text-primary">{t(`summary.group.${g.group}`)}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-tertiary" aria-hidden="true">
              <span className="block h-full rounded-full bg-accent" style={{ width: `${g.score}%` }} />
            </span>
            <span className="w-10 shrink-0 text-end tabular-nums text-text-secondary">{t('card.scoreLabel', { score: g.score })}</span>
          </li>
        ))}
      </ul>

      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('summary.gapsHeading')}</h3>
      {top.length === 0 ? (
        <p className="mt-2 text-sm text-text-secondary">{t('summary.noGaps')}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {top.map((gap) => (
            <li key={gap.key} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="text-text-primary">{t(`field.${gap.key}`)}</span>
              <span className="text-xs text-text-secondary">{t(`summary.reason.${gap.reason}`)}</span>
            </li>
          ))}
        </ul>
      )}

      {snap.requiredMissing.length > 0 && snap.stage !== 'live' && (
        <p className="mt-4 text-xs text-text-secondary">{t('summary.required', { list: snap.requiredMissing.map((k) => t(`field.${k}`)).join(', ') })}</p>
      )}
    </section>
  );
}
