import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { BarChart3 } from 'lucide-react';
import { fmtMoney, trendFor, type DriverKey, type DriverResult, type ExitMetrics, type SnapshotLite } from '@/lib/exitReadiness';
import { EstimateBanner, ScoreBar, StatusPill, TrendBadge } from './shared';

interface Props {
  drivers: DriverResult[];
  metrics: ExitMetrics;
  previous: SnapshotLite | null;
  snapshots: SnapshotLite[];
}

function History({ snapshots }: { snapshots: SnapshotLite[] }) {
  const pts = snapshots.filter((s) => s.readinessScore !== null).slice(-12);
  if (pts.length < 2) {
    return <p className="text-xs text-text-secondary">Snapshots are saved automatically each month. Trends appear after your second month.</p>;
  }
  const w = 320;
  const h = 70;
  const xs = (i: number) => (i / (pts.length - 1)) * (w - 16) + 8;
  const ys = (v: number) => h - 8 - (v / 100) * (h - 16);
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(p.readinessScore as number).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-md" role="img" aria-label={`Sell-readiness score history: ${pts.map((p) => `${p.periodMonth.slice(0, 7)} ${p.readinessScore}`).join(', ')}`}>
      <path d={path} fill="none" stroke="currentColor" strokeWidth={2} className="text-accent" />
      {pts.map((p, i) => <circle key={p.periodMonth} cx={xs(i)} cy={ys(p.readinessScore as number)} r={3} className="fill-accent" />)}
    </svg>
  );
}

export function DriversPanel({ drivers, metrics, previous, snapshots }: Props) {
  const monthly = metrics.financials.monthly;
  const maxRev = Math.max(1, ...monthly.map((m) => m.revenueCents));
  return (
    <div className="space-y-6">
      <EstimateBanner compact />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {drivers.map((d) => (
          <Card key={d.key} className="!p-5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-text-primary">{d.label}</h3>
                <p className="text-[11px] text-text-secondary">Weight {d.weight}%</p>
              </div>
              <StatusPill status={d.status} />
            </div>
            <p className="mt-2 text-sm text-text-primary">{d.display}</p>
            <div className="mt-2"><ScoreBar score={d.score} /></div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-xs text-text-secondary">{d.score === null ? 'Not scored' : `${Math.round(d.score)} / 100`}</span>
              <TrendBadge trend={trendFor(d.score, previous?.driverScores[d.key as DriverKey])} />
            </div>
            <p className="mt-2 text-xs text-text-secondary">{d.detail}</p>
          </Card>
        ))}
      </div>

      <Card>
        <h2 className="mb-3 text-lg font-semibold text-text-primary">Sell-readiness history</h2>
        <History snapshots={snapshots} />
      </Card>

      <Card>
        <h2 className="mb-3 text-lg font-semibold text-text-primary">Gross margin by service</h2>
        {metrics.margin.byService.length === 0 ? (
          <EmptyState icon={BarChart3} title="No costed jobs yet" description="Add cost entries to completed jobs and per-service margins will appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Gross margin by service, trailing 12 months</caption>
              <thead className="text-xs text-text-secondary">
                <tr><th scope="col" className="py-2 pr-4">Service</th><th scope="col" className="py-2 pr-4">Jobs</th><th scope="col" className="py-2 pr-4">Revenue</th><th scope="col" className="py-2">Margin</th></tr>
              </thead>
              <tbody>
                {metrics.margin.byService.map((s) => (
                  <tr key={s.service} className="border-t border-border/60">
                    <td className="py-2 pr-4 text-text-primary">{s.service}</td>
                    <td className="py-2 pr-4 text-text-secondary">{s.jobs}</td>
                    <td className="py-2 pr-4 text-text-secondary">{fmtMoney(s.revenueCents)}</td>
                    <td className={`py-2 font-medium ${(s.marginPct ?? 0) < 25 ? 'text-danger' : 'text-text-primary'}`}>{s.marginPct === null ? '—' : `${s.marginPct}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-lg font-semibold text-text-primary">Revenue by month (ledger)</h2>
        {monthly.length === 0 ? (
          <EmptyState icon={BarChart3} title="No ledger entries yet" description="Post invoices and payments in Accounting to build your trailing-12-month history." />
        ) : (
          <ul className="space-y-1.5">
            {monthly.map((m) => (
              <li key={m.month} className="flex items-center gap-3 text-xs">
                <span className="w-16 shrink-0 text-text-secondary">{m.month}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg-tertiary"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, (m.revenueCents / maxRev) * 100)}%` }} /></div>
                <span className="w-16 shrink-0 text-right text-text-primary">{fmtMoney(m.revenueCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
