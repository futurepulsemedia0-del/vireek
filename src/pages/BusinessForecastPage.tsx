import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  RefreshCw,
  LineChart,
  DollarSign,
  PiggyBank,
  Gauge,
  TrendingUp,
  TriangleAlert as AlertTriangle,
  ChevronDown,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkeletonStatGrid } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { fetchForecastInput } from '@/lib/businessForecastApi';
import {
  FORECAST_HORIZONS,
  buildBusinessForecast,
  type BusinessForecast,
  type CapacityStatus,
  type ConfidenceLevel,
  type ForecastConfidence,
  type ForecastHorizon,
} from '@/lib/businessForecast';

function money(n: number) {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

const CONFIDENCE_STYLES: Record<ConfidenceLevel, string> = {
  high: 'bg-success/10 text-success',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-danger/10 text-danger',
};

const CAPACITY_STATUS: Record<CapacityStatus, { label: string; tone: string }> = {
  no_capacity_data: { label: 'No technicians configured', tone: 'text-text-secondary' },
  underused: { label: 'Under-used', tone: 'text-text-secondary' },
  healthy: { label: 'Healthy', tone: 'text-success' },
  tight: { label: 'Tight', tone: 'text-warning-500' },
  over: { label: 'Over capacity', tone: 'text-danger' },
};

function ConfidenceBadge({ confidence }: { confidence: ForecastConfidence }) {
  return (
    <div className="space-y-2">
      <span className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${CONFIDENCE_STYLES[confidence.level]}`}>
        {confidence.label}
      </span>
      <details className="group text-xs text-text-secondary">
        <summary className="focus-ring flex cursor-pointer list-none items-center gap-1 hover:text-text-primary">
          Why this confidence ({confidence.score}/100)
          <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          {confidence.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function RangeLine({ low, high, format }: { low: number; high: number; format: (n: number) => string }) {
  return (
    <p className="text-xs text-text-secondary">
      Likely range {format(low)} – {format(high)} <span className="opacity-70">(80%)</span>
    </p>
  );
}

function StatRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className={`font-medium ${tone ?? 'text-text-primary'}`}>{value}</span>
    </div>
  );
}

function ForecastCard({
  icon,
  title,
  headline,
  children,
}: {
  icon: ReactNode;
  title: string;
  headline: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-5" aria-label={`${title} forecast`} title={headline}>
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">{icon}</span>
        <h2 className="text-base font-semibold text-text-primary">{title} forecast</h2>
      </div>
      {children}
    </section>
  );
}

export function BusinessForecastPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [horizon, setHorizon] = useState<ForecastHorizon>(30);
  const [forecast, setForecast] = useState<BusinessForecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const input = await fetchForecastInput(user.id);
      setForecast(buildBusinessForecast(input));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load forecast data.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const rev = forecast?.revenue[horizon];
  const gp = forecast?.grossProfit[horizon];
  const cap = forecast?.capacity[horizon];
  const cash = forecast?.cash[horizon];

  const alerts = useMemo(() => {
    if (!forecast) return [] as { key: string; text: string }[];
    const out: { key: string; text: string }[] = [];
    for (const h of FORECAST_HORIZONS) {
      const c = forecast.cash[h];
      if (c.risk === 'critical') {
        out.push({ key: `cash-${h}`, text: `Cash is projected to drop to ${money(c.minBalance)} on ${c.minBalanceDate} (within ${h} days).` });
        break;
      }
    }
    for (const h of FORECAST_HORIZONS) {
      const k = forecast.capacity[h];
      if (k.status === 'over') {
        out.push({ key: `cap-${h}`, text: `Demand exceeds technician capacity over the next ${h} days by about ${k.gapJobs} jobs (${money(k.revenueAtRisk)} at risk).` });
        break;
      }
    }
    return out;
  }, [forecast]);

  return (
    <DashboardLayout activeLabel="Business Forecast">
      <button type="button" onClick={() => navigate('/dashboard')} className="focus-ring mb-5 flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft size={16} /> Back to dashboard
      </button>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <LineChart size={24} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Business Forecast</h1>
            <p className="text-sm text-text-secondary">Revenue, gross profit, capacity and cash — built from your real jobs, payments, memberships and quotes.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Forecast horizon" className="flex rounded-lg border border-border p-0.5">
            {FORECAST_HORIZONS.map((h) => (
              <button
                key={h}
                role="tab"
                type="button"
                aria-selected={horizon === h}
                onClick={() => setHorizon(h)}
                className={`focus-ring rounded-md px-3 py-1.5 text-sm font-semibold ${horizon === h ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {h} days
              </button>
            ))}
          </div>
          <button type="button" onClick={load} disabled={loading} className="focus-ring flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-primary hover:bg-bg-secondary disabled:opacity-60">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {loading && !forecast ? (
        <SkeletonStatGrid count={4} />
      ) : error ? (
        <EmptyState
          icon={AlertTriangle}
          title="Could not build the forecast"
          description={error}
          action={{ label: 'Try again', onClick: load }}
        />
      ) : forecast && rev && gp && cap && cash ? (
        <div className="space-y-6">
          {alerts.map((a) => (
            <div key={a.key} className="flex items-start gap-3 rounded-2xl border border-l-4 border-l-danger bg-danger/10 p-4">
              <AlertTriangle className="mt-0.5 shrink-0 text-danger" size={20} />
              <p className="text-sm text-text-primary">{a.text}</p>
            </div>
          ))}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <ForecastCard icon={<DollarSign size={20} />} title="Revenue" headline={rev.confidence.headline}>
              <div>
                <p className="text-3xl font-bold text-text-primary">{money(rev.base)}</p>
                <RangeLine low={rev.low} high={rev.high} format={money} />
              </div>
              <div className="space-y-1.5">
                <StatRow label="Booked jobs" value={money(rev.booked)} />
                <StatRow label="Recurring memberships" value={money(rev.recurring)} />
                <StatRow label="Open quotes (win-rate weighted)" value={money(rev.pipeline)} />
                <StatRow label="Expected new work" value={money(rev.runRateFill)} />
              </div>
              <ConfidenceBadge confidence={rev.confidence} />
            </ForecastCard>

            <ForecastCard icon={<TrendingUp size={20} />} title="Gross profit" headline={gp.confidence.headline}>
              <div>
                <p className={`text-3xl font-bold ${gp.base < 0 ? 'text-danger' : 'text-text-primary'}`}>{money(gp.base)}</p>
                <RangeLine low={gp.low} high={gp.high} format={money} />
              </div>
              <div className="space-y-1.5">
                <StatRow label="Gross margin" value={`${gp.marginPct.toFixed(1)}%`} />
                <StatRow label="Margin source" value={gp.marginSource === 'actual' ? 'Measured from costed jobs' : 'Default cost ratio'} tone={gp.marginSource === 'actual' ? undefined : 'text-warning-500'} />
              </div>
              <ConfidenceBadge confidence={gp.confidence} />
            </ForecastCard>

            <ForecastCard icon={<Gauge size={20} />} title="Capacity" headline={cap.confidence.headline}>
              <div>
                <p className={`text-3xl font-bold ${CAPACITY_STATUS[cap.status].tone}`}>
                  {cap.status === 'no_capacity_data' ? '—' : `${cap.utilizationPct}%`}
                </p>
                <p className="text-xs text-text-secondary">
                  {CAPACITY_STATUS[cap.status].label} · demand {cap.demandLow}–{cap.demandHigh} jobs vs {cap.capacityJobs} slots
                </p>
              </div>
              <div className="space-y-1.5">
                <StatRow label="Expected jobs" value={String(cap.demandBase)} />
                <StatRow label="Available slots" value={String(cap.capacityJobs)} />
                <StatRow label="Days booked beyond capacity" value={String(cap.overbookedDays)} tone={cap.overbookedDays > 0 ? 'text-danger' : undefined} />
                {cap.peakDay && <StatRow label="Busiest booked day" value={`${cap.peakDay.date} · ${cap.peakDay.booked}/${cap.peakDay.capacity}`} />}
                {cap.gapJobs > 0 && <StatRow label="Technicians needed" value={`${cap.techniciansNeeded} (${money(cap.revenueAtRisk)} at risk)`} tone="text-danger" />}
              </div>
              <ConfidenceBadge confidence={cap.confidence} />
            </ForecastCard>

            <ForecastCard icon={<PiggyBank size={20} />} title="Cash" headline={cash.confidence.headline}>
              <div>
                <p className={`text-3xl font-bold ${cash.endingBase < 0 ? 'text-danger' : 'text-text-primary'}`}>{money(cash.endingBase)}</p>
                <RangeLine low={cash.endingLow} high={cash.endingHigh} format={money} />
              </div>
              <div className="space-y-1.5">
                <StatRow label="Opening balance" value={money(cash.startingBalance)} />
                <StatRow label="Expected cash in" value={money(cash.inflows)} />
                <StatRow label="Expected cash out" value={money(cash.outflows)} />
                <StatRow
                  label="Lowest point"
                  value={`${money(cash.minBalance)} · ${cash.minBalanceDate}`}
                  tone={cash.risk === 'critical' ? 'text-danger' : cash.risk === 'watch' ? 'text-warning-500' : undefined}
                />
              </div>
              <ConfidenceBadge confidence={cash.confidence} />
              <button type="button" onClick={() => navigate('/dashboard/cash-flow')} className="focus-ring text-xs font-semibold text-accent hover:underline">
                Edit opening balance & fixed expenses →
              </button>
            </ForecastCard>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">All forecasts at a glance</caption>
              <thead className="bg-bg-secondary text-left text-xs uppercase text-text-secondary">
                <tr>
                  <th scope="col" className="p-3">Forecast</th>
                  {FORECAST_HORIZONS.map((h) => (
                    <th key={h} scope="col" className="p-3">{h} days</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {([
                  ['Revenue', (h: ForecastHorizon) => forecast.revenue[h].base, (h: ForecastHorizon) => forecast.revenue[h].confidence],
                  ['Gross profit', (h: ForecastHorizon) => forecast.grossProfit[h].base, (h: ForecastHorizon) => forecast.grossProfit[h].confidence],
                  ['Cash (ending)', (h: ForecastHorizon) => forecast.cash[h].endingBase, (h: ForecastHorizon) => forecast.cash[h].confidence],
                ] as const).map(([label, value, confidence]) => (
                  <tr key={label} className="border-t border-border">
                    <th scope="row" className="p-3 text-left font-medium text-text-primary">{label}</th>
                    {FORECAST_HORIZONS.map((h) => (
                      <td key={h} className="p-3">
                        <div className="font-semibold text-text-primary">{money(value(h))}</div>
                        <div className={`text-xs ${CONFIDENCE_STYLES[confidence(h).level].split(' ')[1]}`}>{confidence(h).label}</div>
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-t border-border">
                  <th scope="row" className="p-3 text-left font-medium text-text-primary">Capacity (utilization)</th>
                  {FORECAST_HORIZONS.map((h) => (
                    <td key={h} className="p-3">
                      <div className="font-semibold text-text-primary">{forecast.capacity[h].status === 'no_capacity_data' ? '—' : `${forecast.capacity[h].utilizationPct}%`}</div>
                      <div className={`text-xs ${CONFIDENCE_STYLES[forecast.capacity[h].confidence.level].split(' ')[1]}`}>{forecast.capacity[h].confidence.label}</div>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          <p className="text-xs text-text-secondary">
            Based on {forecast.meta.completedJobs90} completed jobs in the last 12 weeks (avg ticket {money(forecast.meta.avgTicket)}, {forecast.meta.completionRatePct}% of booked jobs complete,
            customers pay in ~{forecast.meta.daysToPay} days). Ranges are 80% intervals from your own week-to-week variation — they widen the further out we look.
          </p>
        </div>
      ) : null}
    </DashboardLayout>
  );
}
