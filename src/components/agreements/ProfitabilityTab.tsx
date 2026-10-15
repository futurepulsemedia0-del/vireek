import { useMemo } from 'react';
import { Coins, LineChart, Percent, Wrench } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { formatMoney, formatPct, siteLabel } from '@/lib/serviceAgreement';
import { Panel, Pill, ProgressBar, StatTile, type TabProps } from './AgreementUi';

interface Bucket {
  key: string;
  label: string;
  jobs: number;
  revenue: number;
  cost: number;
}

export function ProfitabilityTab({ data, derived, canSeeMoney }: TabProps) {
  const { profit, reprice } = derived;

  const { byService, bySite } = useMemo(() => {
    const fin = new Map(data.jobFinancials.map((f) => [f.job_id, f]));
    const siteById = new Map(data.sites.map((s) => [s.id, s]));
    const svc = new Map<string, Bucket>();
    const site = new Map<string, Bucket>();
    const add = (m: Map<string, Bucket>, key: string, label: string, rev: number, cost: number) => {
      const b = m.get(key) ?? { key, label, jobs: 0, revenue: 0, cost: 0 };
      b.jobs += 1;
      b.revenue += rev;
      b.cost += cost;
      m.set(key, b);
    };
    for (const j of data.jobs) {
      const f = fin.get(j.id);
      if (!f) continue;
      const sLabel = j.service_type?.trim() || 'Unspecified';
      add(svc, sLabel.toLowerCase(), sLabel, f.revenue_cents, f.total_cost_cents);
      const s = j.site_id ? siteById.get(j.site_id) : undefined;
      add(site, j.site_id ?? 'none', s ? siteLabel(s) : 'No property recorded', f.revenue_cents, f.total_cost_cents);
    }
    const sort = (m: Map<string, Bucket>) => [...m.values()].sort((a, b) => b.cost - a.cost).slice(0, 8);
    return { byService: sort(svc), bySite: sort(site) };
  }, [data.jobs, data.jobFinancials, data.sites]);

  if (!canSeeMoney) {
    return <EmptyState icon={Coins} title="Profitability is restricted" description="Ask the account owner for billing access to see agreement margin and cost-to-serve." />;
  }

  const unpriced = data.jobs.length - data.jobFinancials.length;
  const maxCost = Math.max(1, ...byService.map((b) => b.cost), ...bySite.map((b) => b.cost));
  const marginTone = profit.marginPct === null ? 'text-text-secondary' : profit.marginPct < 0 ? 'text-danger' : profit.marginPct < 20 ? 'text-warning-500' : 'text-success-500';

  const lines: { label: string; cents: number; sign: 1 | -1; hint?: string }[] = [
    { label: 'Recurring fees earned', cents: profit.recurringRevenueCents, sign: 1, hint: `${profit.elapsedMonths.toFixed(1)} months elapsed` },
    { label: 'Billed job revenue', cents: profit.jobRevenueCents, sign: 1, hint: 'Work billed outside the allowance' },
    { label: 'Labor cost', cents: profit.laborCostCents, sign: -1 },
    { label: 'Parts & materials', cents: profit.partsCostCents, sign: -1 },
    { label: 'Other job costs', cents: Math.max(0, profit.costToServeCents - profit.laborCostCents - profit.partsCostCents), sign: -1 },
    { label: 'SLA penalties', cents: profit.penaltiesCents, sign: -1 },
    { label: 'Claim payouts', cents: profit.claimPayoutsCents, sign: -1 },
    { label: 'Manufacturer recoveries', cents: profit.recoveriesCents, sign: 1 },
  ];

  return (
    <>
      {!data.financialsAvailable && (
        <p className="mb-4 rounded-lg border border-warning-500/30 bg-warning-500/10 p-3 text-sm text-warning-500">
          Job cost data could not be read, so only recurring revenue is shown. Check that the job costing tables are available for this account.
        </p>
      )}
      {profit.lowConfidence && data.financialsAvailable && (
        <p className="mb-4 rounded-lg border border-border bg-bg-secondary p-3 text-sm text-text-secondary">Not enough history yet (needs about 2 months and 3 jobs) — treat this margin as an early estimate.</p>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Revenue to date" value={formatMoney(profit.totalRevenueCents)} icon={Coins} />
        <StatTile label="Cost to serve" value={formatMoney(profit.costToServeCents + profit.penaltiesCents + profit.claimPayoutsCents - profit.recoveriesCents)} icon={Wrench} tone="text-warning-500" />
        <StatTile label="Gross profit" value={formatMoney(profit.grossProfitCents)} icon={LineChart} tone={profit.grossProfitCents < 0 ? 'text-danger' : 'text-success-500'} />
        <StatTile label="Margin" value={formatPct(profit.marginPct, 1)} icon={Percent} tone={marginTone} sub={profit.costPerJobCents !== null ? `${formatMoney(profit.costPerJobCents)} per job · ${profit.jobCount} jobs` : undefined} />
      </div>

      <Panel title="Profit & loss to date" description="Recurring fees recognised pro-rata over the term, plus real job revenue and cost from Vireek job costing.">
        <table className="w-full text-sm">
          <caption className="sr-only">Agreement profit and loss</caption>
          <tbody className="divide-y divide-border">
            {lines.map((l) => (
              <tr key={l.label}>
                <th scope="row" className="py-2 pr-4 text-left font-normal text-text-primary">
                  {l.label}
                  {l.hint && <span className="ml-2 text-xs text-text-secondary">{l.hint}</span>}
                </th>
                <td className={`py-2 text-right tabular-nums ${l.cents === 0 ? 'text-text-secondary' : l.sign === 1 ? 'text-success-500' : 'text-text-primary'}`}>
                  {l.cents === 0 ? '—' : `${l.sign === -1 ? '−' : '+'}${formatMoney(l.cents)}`}
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row" className="py-2.5 pr-4 text-left font-semibold text-text-primary">Gross profit</th>
              <td className={`py-2.5 text-right font-semibold tabular-nums ${profit.grossProfitCents < 0 ? 'text-danger' : 'text-text-primary'}`}>{formatMoney(profit.grossProfitCents)}</td>
            </tr>
          </tbody>
        </table>
        {unpriced > 0 && data.financialsAvailable && <p className="mt-3 text-xs text-text-secondary">{unpriced} job{unpriced === 1 ? '' : 's'} on this agreement have no cost data yet and are not included.</p>}
      </Panel>

      {reprice && (
        <Panel title="Pricing recommendation">
          <p className="text-sm text-text-primary">
            At the current run-rate this agreement earns {formatPct(profit.marginPct, 1)}. A fee of <strong>{formatMoney(reprice.suggestedFeeCents)}</strong> per period (+{formatPct(reprice.increasePct, 1)}) would reach a {reprice.targetMarginPct}% margin.
          </p>
        </Panel>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {[
          { title: 'Where the cost goes — by service', rows: byService },
          { title: 'Where the cost goes — by property', rows: bySite },
        ].map((g) => (
          <Panel key={g.title} title={g.title}>
            {g.rows.length === 0 ? (
              <p className="text-sm text-text-secondary">No costed jobs yet.</p>
            ) : (
              <ul className="space-y-3">
                {g.rows.map((b) => {
                  const margin = b.revenue > 0 ? ((b.revenue - b.cost) / b.revenue) * 100 : null;
                  return (
                    <li key={b.key}>
                      <div className="mb-1 flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{b.label}</span>
                        <span className="text-text-secondary">{b.jobs} job{b.jobs === 1 ? '' : 's'}</span>
                        <span className="tabular-nums text-text-primary">{formatMoney(b.cost)}</span>
                        {margin !== null && <Pill className={margin < 0 ? 'bg-danger/10 text-danger' : 'bg-bg-tertiary text-text-secondary'}>{formatPct(margin)}</Pill>}
                      </div>
                      <ProgressBar pct={(b.cost / maxCost) * 100} tone="bg-accent" label={`${b.label} cost`} />
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        ))}
      </div>
    </>
  );
}
