import { CircleAlert, CircleCheck, CircleDashed, CircleMinus, ExternalLink, Info } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { useAgentReadinessT } from '@/i18n/agentReadinessNamespace';
import { SUBSCORE_ORDER, type Check, type CheckStatus, type SubscoreResult } from '@/lib/agentReadinessCore';
import { RULES, type RuleId } from '../../../supabase/functions/_shared/agent-readiness/rules';

const ICON: Record<CheckStatus, { Icon: typeof CircleCheck; cls: string }> = {
  pass: { Icon: CircleCheck, cls: 'text-success-500' },
  partial: { Icon: CircleMinus, cls: 'text-warning-500' },
  fail: { Icon: CircleAlert, cls: 'text-danger-500' },
  not_measured: { Icon: CircleDashed, cls: 'text-text-secondary' },
};

export function ScoreChecklist({ subscores, checks }: { subscores: SubscoreResult[]; checks: Check[] }) {
  const { t } = useAgentReadinessT();
  const groups = SUBSCORE_ORDER.map((id) => ({ id, sub: subscores.find((s) => s.id === id), items: checks.filter((c) => c.subscore === id) })).filter((g) => g.items.length > 0);
  return (
    <div className="space-y-4">
      {groups.map(({ id, sub, items }) => (
        <section key={id} className="rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby={`ar-sub-${id}`}>
          <div className="flex items-baseline justify-between gap-3">
            <h3 id={`ar-sub-${id}`} className="text-base font-semibold text-text-primary">{t(`subscores.${id}`)}</h3>
            <span className="text-sm tabular-nums text-text-secondary">{sub?.score === null || sub === undefined ? t('status.not_measured') : `${sub.score}/100`}</span>
          </div>
          <ul className="mt-3 space-y-3">
            {items.map((c) => {
              const { Icon, cls } = ICON[c.status];
              const rule = RULES[c.ruleId as RuleId];
              return (
                <li key={c.ruleId} className="flex items-start gap-3 text-sm">
                  <Icon size={18} className={`mt-0.5 shrink-0 ${cls}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-text-primary">
                      <span className="font-medium">{t(`rules.${c.ruleId}.title`)}</span>
                      <span className="sr-only">{t(`status.${c.status}`)}</span>
                      {c.sampled && <span className="rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary">{t('sampled')}</span>}
                      {rule?.mayChange && <span className="rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary">{t('mayChange')}</span>}
                    </p>
                    <p className="text-xs text-text-secondary">{t(`evidence.${c.evidence.k}`, c.evidence.p ?? {})}</p>
                    {(c.status === 'fail' || c.status === 'partial') && <p className="mt-1 text-xs text-text-secondary">{t('howToFix')}: {t(`rules.${c.ruleId}.fix`)}</p>}
                  </div>
                  <Tooltip openOnTap maxWidth={320} content={
                    <span className="block text-left">
                      <span className="block font-semibold">{t('why')}</span>
                      <span className="block">{t(`rules.${c.ruleId}.why`)}</span>
                      {rule && <a href={rule.source} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 underline">{t('source')}<ExternalLink size={12} aria-hidden /></a>}
                    </span>}>
                    <button type="button" aria-label={`${t('why')}: ${t(`rules.${c.ruleId}.title`)}`} className="focus-ring shrink-0 rounded-full p-1 text-text-secondary hover:text-text-primary">
                      <Info size={16} aria-hidden />
                    </button>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
