// Plan, quota and overage card for the API Usage page. Read-only: enforcement is in the database / api-v1.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Pill, type Tone } from '@/components/vehicles/shared';
import { useApiPlansT } from '@/i18n/apiPlansNamespace';
import {
  fetchPlanUsage, formatCents, formatCount, projectMonthEnd, quotaStatus,
  type PlanUsage, type QuotaState,
} from '@/lib/apiPlans';

interface KeyRef { id: string; name: string; revoked_at: string | null }

const STATE_TONE: Record<QuotaState, Tone> = { unlimited: 'neutral', ok: 'success', warning: 'warning', over_quota: 'warning', blocked: 'danger' };
const BAR_CLASS: Record<QuotaState, string> = { unlimited: 'bg-accent', ok: 'bg-success', warning: 'bg-warning', over_quota: 'bg-warning', blocked: 'bg-danger' };

export function ApiPlanPanel({ ownerId, keys }: { ownerId: string; keys: readonly KeyRef[] }) {
  const { t, language } = useApiPlansT();
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setUsage(await fetchPlanUsage(ownerId));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => { void load(); }, [load]);

  const keyById = useMemo(() => new Map(keys.map((k) => [k.id, k])), [keys]);

  if (loading && !usage) {
    return <Card interactive={false} padding="sm" aria-busy="true"><p role="status" className="text-sm text-text-secondary">{t('loading')}</p></Card>;
  }
  if (failed || !usage) {
    return (
      <Card interactive={false} padding="sm">
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-text-primary">
          {t('loadError')}
          <Button variant="secondary" onClick={() => void load()}>{t('retry')}</Button>
        </div>
      </Card>
    );
  }

  const plan = usage.plan;
  if (!plan) return null;
  const status = quotaStatus(usage.total_requests, plan);
  const projected = projectMonthEnd(usage.total_requests, usage.period_start, usage.period_end);
  const endDate = new Date(`${usage.period_end}T00:00:00Z`);
  const resets = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }).format(endDate);
  const quota = plan.monthly_quota;

  return (
    <Card interactive={false} padding="sm" className="space-y-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">{t('title')}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={STATE_TONE[status.state]}>{t(`state.${status.state}`)}</Pill>
          {plan.is_proposed && <Pill tone="neutral">{t('proposed')}</Pill>}
        </div>
      </div>

      {!usage.enabled && <p role="note" className="rounded-xl border border-border bg-bg-primary p-3 text-xs text-text-secondary">{t('preview')}</p>}

      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-xs text-text-secondary">{t('plan')}</dt><dd className="font-medium text-text-primary">{plan.name}</dd><dd className="text-xs text-text-secondary">{t(usage.assigned ? 'planSource.assigned' : 'planSource.default')}</dd></div>
        <div><dt className="text-xs text-text-secondary">{t('rateLimit', { count: plan.rate_limit_per_minute })}</dt><dd className="font-medium text-text-primary">{formatCount(plan.rate_limit_per_minute, language)} / min</dd></div>
        <div><dt className="text-xs text-text-secondary">{t('resets', { date: resets })}</dt><dd className="font-medium text-text-primary">{usage.period}</dd></div>
      </dl>

      {usage.enabled && (
        <div className="space-y-2">
          <p className="text-sm text-text-primary">
            {quota === null
              ? t('usedOnly', { used: formatCount(usage.total_requests, language) })
              : t('usedOf', { used: formatCount(usage.total_requests, language), quota: formatCount(quota, language) })}
            {status.remaining !== null && <span className="text-text-secondary"> · {t('remaining', { count: formatCount(status.remaining, language) })}</span>}
          </p>
          {quota !== null && (
            <div role="progressbar" aria-label={t('title')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(status.pctUsed)} className="h-2.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
              <div className={`h-full rounded-full ${BAR_CLASS[status.state]}`} style={{ width: `${status.pctUsed}%` }} />
            </div>
          )}
          {projected !== null && quota !== null && <p className="text-xs text-text-secondary">{t('projected', { count: formatCount(projected, language) })}</p>}
        </div>
      )}

      <section aria-label={t('overage.title')} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('overage.title')}</h3>
        {quota === null ? (
          <p className="mt-1 text-text-secondary">{t('unlimited')}</p>
        ) : plan.overage_policy === 'block' ? (
          <p className="mt-1 text-text-secondary">{t('overage.block')}</p>
        ) : (
          <p className="mt-1 text-text-secondary">{t('overage.meter', { pct: plan.max_overage_pct, price: formatCents(plan.overage_cents_per_1000, language) })}</p>
        )}
        {usage.enabled && usage.overage_requests > 0 && plan.overage_policy === 'meter' && (
          <p className="mt-2 font-medium text-text-primary">{t('overage.now', { count: formatCount(usage.overage_requests, language), amount: formatCents(usage.estimated_overage_cents, language) })}</p>
        )}
      </section>

      {usage.enabled && (
        <section aria-label={t('perKey.title')}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('perKey.title')}</h3>
          {usage.keys.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('perKey.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-start text-xs text-text-secondary"><th scope="col" className="py-1 pe-3 text-start font-medium">{t('perKey.key')}</th><th scope="col" className="py-1 text-end font-medium">{t('perKey.requests')}</th></tr></thead>
                <tbody>
                  {usage.keys.map((k) => {
                    const ref = keyById.get(k.key_id);
                    return (
                      <tr key={k.key_id} className="border-t border-border">
                        <td className="py-1.5 pe-3 text-text-primary">{ref ? ref.name : t('perKey.deleted')}{ref?.revoked_at ? <span className="text-text-secondary"> ({t('perKey.revoked')})</span> : null}</td>
                        <td className="py-1.5 text-end tabular-nums text-text-primary">{formatCount(k.requests, language)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <p className="text-xs text-text-secondary">{t('testNote')}{plan.is_proposed ? ` ${t('proposedNote')}` : ''}</p>
    </Card>
  );
}
