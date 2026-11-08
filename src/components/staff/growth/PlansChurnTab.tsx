import { Link } from 'react-router-dom';
import { useGrowthT } from '@/i18n/growthNamespace';
import { fetchChurnReasons, fetchPlans } from '@/lib/growth/growthApi';
import { AsyncBoundary, DataTable, Notice, SectionTitle, Td, useAsync, useFormatters } from './growthShared';

export function PlansChurnTab({ from, to }: { from: Date; to: Date }) {
  const { t } = useGrowthT();
  const f = useFormatters();
  const key = `${from.getTime()}-${to.getTime()}`;
  const plans = useAsync(() => fetchPlans(from, to), `p${key}`);
  const churn = useAsync(() => fetchChurnReasons(from, to), `c${key}`);
  return (
    <div className="space-y-8">
      <section aria-labelledby="g-mix" className="space-y-3">
        <SectionTitle id="g-mix" hint={t('plans.mixHint')}>{t('plans.mix')}</SectionTitle>
        <AsyncBoundary state={plans}>
          {(d) => (
            <div className="space-y-4">
              {d.mix.length === 0 ? <Notice>{t('revenue.noHistory')}</Notice> : (
                <DataTable caption={t('plans.mix')} head={[t('plans.plan'), t('common.currency'), t('plans.paying'), t('plans.trialing'), t('plans.mrr')]}>
                  {d.mix.map((m) => (
                    <tr key={`${m.planId}-${m.currency}`}><Td>{m.planId}</Td><Td>{m.currency.toUpperCase()}</Td><Td>{m.payingN}</Td><Td>{m.trialingN}</Td><Td>{f.money(m.mrrCents, m.currency)}</Td></tr>
                  ))}
                </DataTable>
              )}
              {d.mix.some((m) => m.planId === 'unmapped') && <Notice>{t('plans.unmapped')}</Notice>}
              <SectionTitle id="g-paths" hint={t('plans.pathsHint')}>{t('plans.paths')}</SectionTitle>
              {d.paths.length === 0 ? <Notice>{t('plans.noPaths')}</Notice> : (
                <DataTable caption={t('plans.paths')} head={[t('plans.from'), t('plans.to'), t('plans.kind'), t('common.accounts'), t('plans.delta')]}>
                  {d.paths.map((p) => (
                    <tr key={`${p.fromPlan}-${p.toPlan}-${p.currency}`}><Td>{p.fromPlan}</Td><Td>{p.toPlan}</Td><Td>{t(`plans.${p.kind}`)}</Td><Td>{p.n}</Td><Td>{f.money(p.deltaCents, p.currency)}</Td></tr>
                  ))}
                </DataTable>
              )}
            </div>
          )}
        </AsyncBoundary>
      </section>

      <section aria-labelledby="g-reasons" className="space-y-3">
        <SectionTitle id="g-reasons" hint={t('plans.reasonsHint')}>{t('plans.reasons')}</SectionTitle>
        <AsyncBoundary state={churn}>
          {(d) => {
            const total = d.reasons.reduce((s, r) => s + r.n, 0);
            return (
              <div className="space-y-3">
                {total === 0 ? <Notice>{t('plans.noReasons')}</Notice> : (
                  <DataTable caption={t('plans.reasons')} head={[t('plans.reason'), t('common.accounts'), t('acq.step.share')]}>
                    {d.reasons.map((r) => (
                      <tr key={r.reason}><Td>{r.reason}</Td><Td>{r.n}</Td><Td>{f.pct(r.n / total, 0)}</Td></tr>
                    ))}
                  </DataTable>
                )}
                <p className="text-xs text-text-secondary">
                  {t('plans.actions', { scheduled: d.actions.cancel_scheduled ?? 0, resumed: d.actions.resumed ?? 0 })}
                </p>
                {total > 0 && total < 30 && <Notice>{t('common.lowSample', { min: 30 })}</Notice>}
              </div>
            );
          }}
        </AsyncBoundary>
      </section>

      <section aria-labelledby="g-risk" className="space-y-2">
        <SectionTitle id="g-risk">{t('plans.atRisk')}</SectionTitle>
        <p className="text-sm text-text-secondary">{t('plans.atRiskBody')}</p>
        <Link to="/staff/customers" className="focus-ring inline-block rounded-lg text-sm font-semibold text-accent underline">{t('plans.atRiskLink')}</Link>
      </section>
    </div>
  );
}
