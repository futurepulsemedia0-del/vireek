import { useMemo, useState } from 'react';
import { useGrowthT } from '@/i18n/growthNamespace';
import { fetchBridge, fetchCohorts } from '@/lib/growth/growthApi';
import { bridgeResidualCents, grossRevenueRetention, logoChurn, netRevenueRetention, MIN_SAMPLE } from '@/lib/growth/growthMetrics';
import { AsyncBoundary, DataTable, MetricTile, Notice, SectionTitle, Td, useAsync, useFormatters } from './growthShared';

export function RevenueTab({ from, to }: { from: Date; to: Date }) {
  const { t } = useGrowthT();
  const f = useFormatters();
  const key = `${from.getTime()}-${to.getTime()}`;
  const bridge = useAsync(() => fetchBridge(from, to), key);
  const cohorts = useAsync(() => fetchCohorts(12), 'cohorts');
  const [currency, setCurrency] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <section aria-labelledby="g-bridge" className="space-y-3">
        <SectionTitle id="g-bridge" hint={t('revenue.bridgeHint')}>
          {t('revenue.bridge')}
        </SectionTitle>
        <AsyncBoundary state={bridge}>
          {(rows) => {
            if (rows.length === 0) return <Notice>{t('revenue.noHistory')}</Notice>;
            const row = rows.find((r) => r.currency === currency) ?? rows[0];
            const mv = (k: keyof typeof row.movements) => row.movements[k]?.cents ?? 0;
            const residual = bridgeResidualCents(row);
            const lines: [string, number, number | undefined][] = [
              [t('revenue.opening'), row.opening_mrr_cents, undefined],
              [t('revenue.new'), mv('new'), row.movements.new?.n],
              [t('revenue.reactivation'), mv('reactivation'), row.movements.reactivation?.n],
              [t('revenue.expansion'), mv('expansion'), row.movements.expansion?.n],
              [t('revenue.contraction'), -mv('contraction'), row.movements.contraction?.n],
              [t('revenue.churn'), -mv('churn'), row.movements.churn?.n],
              [t('revenue.closing'), row.closing_mrr_cents, undefined],
            ];
            return (
              <div className="space-y-4">
                {rows.length > 1 && (
                  <div className="flex items-center gap-2">
                    <label htmlFor="g-cur" className="text-xs text-text-secondary">
                      {t('common.currency')}
                    </label>
                    <select id="g-cur" className="focus-ring rounded-lg border border-border bg-bg-secondary px-2 py-1 text-sm text-text-primary" value={row.currency} onChange={(e) => setCurrency(e.target.value)}>
                      {rows.map((r) => (
                        <option key={r.currency} value={r.currency}>
                          {r.currency.toUpperCase()}
                        </option>
                      ))}
                    </select>
                    <span className="text-xs text-text-secondary">{t('revenue.noFx')}</span>
                  </div>
                )}
                <DataTable caption={t('revenue.bridge')} head={[t('revenue.line'), t('revenue.amount'), t('common.accounts')]}>
                  {lines.map(([label, cents, n]) => (
                    <tr key={label}>
                      <Td>{label}</Td>
                      <Td>{f.money(cents, row.currency)}</Td>
                      <Td>{n === undefined ? '' : f.num(n, 0)}</Td>
                    </tr>
                  ))}
                </DataTable>
                {residual !== 0 && <Notice>{t('revenue.residual', { amount: f.money(Math.abs(residual), row.currency) })}</Notice>}
                <div className="grid gap-3 sm:grid-cols-3">
                  <MetricTile label={t('revenue.nrr')} formula={t('revenue.nrrFormula')} metric={netRevenueRetention(row)} format={(v) => f.pct(v)} />
                  <MetricTile label={t('revenue.grr')} formula={t('revenue.grrFormula')} metric={grossRevenueRetention(row)} format={(v) => f.pct(v)} />
                  <MetricTile label={t('revenue.logoChurn')} formula={t('revenue.logoChurnFormula')} metric={logoChurn(row)} format={(v) => f.pct(v)} />
                </div>
              </div>
            );
          }}
        </AsyncBoundary>
      </section>

      <section aria-labelledby="g-cohorts" className="space-y-3">
        <SectionTitle id="g-cohorts" hint={t('revenue.cohortsHint')}>
          {t('revenue.cohorts')}
        </SectionTitle>
        <AsyncBoundary state={cohorts}>
          {(rows) => <CohortTable rows={rows} />}
        </AsyncBoundary>
      </section>
    </div>
  );
}

function CohortTable({ rows }: { rows: Awaited<ReturnType<typeof fetchCohorts>> }) {
  const { t } = useGrowthT();
  const f = useFormatters();
  const grouped = useMemo(() => {
    const m = new Map<string, typeof rows>();
    for (const r of rows) m.set(`${r.cohortMonth}|${r.currency}`, [...(m.get(`${r.cohortMonth}|${r.currency}`) ?? []), r]);
    return [...m.entries()];
  }, [rows]);
  if (grouped.length === 0) return <Notice>{t('revenue.noCohorts')}</Notice>;
  const maxOffset = Math.max(...rows.map((r) => r.offset));
  const head = [t('revenue.cohort'), t('revenue.cohortSize'), ...Array.from({ length: maxOffset + 1 }, (_, i) => t('revenue.monthN', { n: i }))];
  return (
    <div className="space-y-2">
      <DataTable caption={t('revenue.cohorts')} head={head}>
        {grouped.map(([k, list]) => {
          const size = list[0]?.cohortSize ?? 0;
          return (
            <tr key={k}>
              <Td>
                {list[0].cohortMonth.slice(0, 7)} · {list[0].currency.toUpperCase()}
              </Td>
              <Td>
                {size}
                {size < MIN_SAMPLE && <span className="ms-1 text-xs text-text-secondary">({t('common.lowSampleShort')})</span>}
              </Td>
              {Array.from({ length: maxOffset + 1 }, (_, i) => {
                const c = list.find((r) => r.offset === i);
                return <Td key={i}>{c ? `${f.pct(c.cohortSize ? c.activeN / c.cohortSize : 0, 0)}${c.isPartial ? ` ${t('revenue.partial')}` : ''}` : '—'}</Td>;
              })}
            </tr>
          );
        })}
      </DataTable>
      <p className="text-xs text-text-secondary">{t('revenue.cohortLegend')}</p>
    </div>
  );
}
