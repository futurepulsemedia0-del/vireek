import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import {
  DIMENSIONS,
  DIMENSION_LABELS,
  METRICS,
  METRIC_IDS,
  formatMetric,
  queryMetrics,
  refreshMetricHistory,
  type Dimension,
  type MetricId,
  type MetricsPayload,
} from '@/lib/dataPlatform';
import { ErrorBanner, SELECT, Skeleton } from './ui';

const RANGES = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 365, label: 'Last 12 months' },
];

function TrendChart({ points, format, label }: { points: { bucket: string; value: number | null }[]; format: (v: number | null) => string; label: string }) {
  const W = 640;
  const H = 180;
  const P = { l: 8, r: 8, t: 12, b: 22 };
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (vals.length < 2) return <p className="py-10 text-center text-sm text-text-secondary">Not enough data in this period to draw a trend.</p>;
  const min = Math.min(0, ...vals);
  const max = Math.max(...vals) || 1;
  const x = (i: number) => P.l + (i / Math.max(points.length - 1, 1)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - (v - min) / (max - min || 1)) * (H - P.t - P.b);
  let d = '';
  let pen = false;
  points.forEach((p, i) => {
    if (p.value === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)} `;
    pen = true;
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label} trend, ${points.length} points, from ${format(vals[0])} to ${format(vals[vals.length - 1])}`} className="h-44 w-full">
      <line x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} stroke="rgb(var(--border))" strokeWidth="1" />
      <path d={d} fill="none" stroke="rgb(var(--accent-primary))" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (p.value === null ? null : <circle key={p.bucket} cx={x(i)} cy={y(p.value)} r={points.length > 60 ? 0 : 3} fill="rgb(var(--accent-primary))"><title>{`${p.bucket}: ${format(p.value)}`}</title></circle>))}
      <text x={P.l} y={H - 4} fontSize="10" fill="rgb(var(--text-secondary))">{points[0].bucket}</text>
      <text x={W - P.r} y={H - 4} fontSize="10" textAnchor="end" fill="rgb(var(--text-secondary))">{points[points.length - 1].bucket}</text>
    </svg>
  );
}

export function MetricsTab() {
  const { toast } = useToast();
  const { currency } = useCurrency();
  const [days, setDays] = useState(30);
  const [compare, setCompare] = useState(true);
  const [groupBy, setGroupBy] = useState<Dimension | ''>('');
  const [selected, setSelected] = useState<MetricId>('revenue');
  const [data, setData] = useState<MetricsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<MetricId | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const to = new Date();
      const from = new Date(to.getTime() - days * 86_400_000);
      const supports = groupBy && METRICS[selected].dimensions.includes(groupBy);
      const res = await queryMetrics({ metrics: METRIC_IDS, from: from.toISOString(), to: to.toISOString(), granularity: days <= 31 ? 'day' : days <= 120 ? 'week' : 'month', compare });
      if (supports) {
        const grouped = await queryMetrics({ metrics: [selected], from: from.toISOString(), to: to.toISOString(), groupBy: groupBy as Dimension });
        res.results = res.results.map((r) => (r.id === selected ? { ...r, groups: grouped.results[0]?.groups } : r));
      }
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load metrics.');
    } finally {
      setLoading(false);
    }
  }, [days, compare, groupBy, selected]);

  useEffect(() => {
    void load();
  }, [load]);

  const fmt = useCallback((id: MetricId, v: number | null) => formatMetric(METRICS[id].unit, v, currency), [currency]);
  const current = useMemo(() => data?.results.find((r) => r.id === selected) ?? null, [data, selected]);
  const groupable = DIMENSIONS.filter((d) => METRICS[selected].dimensions.includes(d));

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await refreshMetricHistory();
      toast(r.skipped ? 'Metric history was refreshed a moment ago.' : 'Metric history refreshed for the last 90 days.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not refresh metric history.', 'error');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-text-secondary">Period</span>
          <select className={SELECT} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGES.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2.5 text-sm text-text-primary">
          <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent-primary))]" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
          Compare with previous period
        </label>
        <div className="ml-auto">
          <Button variant="secondary" size="sm" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            Refresh history
          </Button>
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={load} />}

      {loading && !data ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : data ? (
        <>
          {data.truncated && <ErrorBanner message="Your account has more records than can be analysed at once, so numbers cover the most recent ones. Choose a shorter period for complete figures." />}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy={loading}>
            {data.results.map((r) => {
              const delta = r.delta?.value ?? null;
              const good = delta === null ? null : (delta > 0) === (r.better === 'up');
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelected(r.id)}
                  aria-pressed={selected === r.id}
                  className={`focus-ring rounded-2xl border p-4 text-left transition-colors ${selected === r.id ? 'border-accent bg-accent/5' : 'border-border/80 bg-bg-secondary hover:border-accent/40'}`}
                >
                  <span className="text-xs font-medium text-text-secondary">{r.label}</span>
                  <span className="mt-1 block text-xl font-bold text-text-primary sm:text-2xl">{fmt(r.id, r.total.value)}</span>
                  <span className={`mt-1 block text-xs font-medium ${delta === null || delta === 0 ? 'text-text-secondary' : good ? 'text-success-500' : 'text-danger'}`}>
                    {delta === null ? (compare ? 'No comparison' : `${r.total.n.toLocaleString()} records`) : `${delta > 0 ? '+' : ''}${delta}${r.delta?.kind === 'pts' ? ' pts' : '%'} vs previous`}
                  </span>
                </button>
              );
            })}
          </div>

          {current && (
            <Card className="!p-5 sm:!p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-text-primary">{current.label}</h3>
                  <p className="mt-0.5 text-sm text-text-secondary">{METRICS[current.id].description}</p>
                </div>
                {groupable.length > 0 && (
                  <label className="block">
                    <span className="sr-only">Break down by</span>
                    <select className={SELECT} value={groupBy} onChange={(e) => setGroupBy(e.target.value as Dimension | '')}>
                      <option value="">No breakdown</option>
                      {groupable.map((d) => (
                        <option key={d} value={d}>
                          By {DIMENSION_LABELS[d].toLowerCase()}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {current.notes.map((n) => (
                <p key={n} className="mt-3 rounded-lg bg-warning-500/10 px-3 py-2 text-xs text-warning-500">
                  {n}
                </p>
              ))}
              <div className="mt-4">
                <TrendChart points={(current.series ?? []).map((s) => ({ bucket: s.bucket, value: s.cell.value }))} format={(v) => fmt(current.id, v)} label={current.label} />
              </div>
              {current.groups && current.groups.length > 0 && (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[320px] text-sm">
                    <caption className="sr-only">{`${current.label} by ${groupBy}`}</caption>
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
                        <th className="py-2 pr-3 font-semibold">{groupBy ? DIMENSION_LABELS[groupBy as Dimension] : ''}</th>
                        <th className="py-2 pr-3 text-right font-semibold">{current.label}</th>
                        <th className="py-2 text-right font-semibold">Records</th>
                      </tr>
                    </thead>
                    <tbody>
                      {current.groups.map((g) => (
                        <tr key={g.key} className="border-b border-border/50">
                          <td className="py-2 pr-3 text-text-primary">{g.key}</td>
                          <td className="py-2 pr-3 text-right font-medium text-text-primary">{fmt(current.id, g.cell.value)}</td>
                          <td className="py-2 text-right text-text-secondary">{g.cell.n.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          <Card className="!p-5 sm:!p-6">
            <h3 className="text-base font-semibold text-text-primary">How each number is defined</h3>
            <p className="mt-1 text-sm text-text-secondary">These exact rules power every dashboard, report, export and the finance copilot.</p>
            <ul className="mt-3 divide-y divide-border/60">
              {METRIC_IDS.map((id) => (
                <li key={id}>
                  <button type="button" onClick={() => setOpen(open === id ? null : id)} aria-expanded={open === id} className="focus-ring flex w-full items-center justify-between gap-3 rounded-lg py-3 text-left">
                    <span className="text-sm font-medium text-text-primary">
                      {METRICS[id].label} <span className="ml-1 text-xs font-normal text-text-secondary">v{METRICS[id].version}</span>
                    </span>
                    <ChevronDown size={16} className={`shrink-0 text-text-secondary transition-transform ${open === id ? 'rotate-180' : ''}`} />
                  </button>
                  {open === id && <p className="pb-3 text-sm leading-relaxed text-text-secondary">{METRICS[id].definition}</p>}
                </li>
              ))}
            </ul>
          </Card>
        </>
      ) : (
        !error && <EmptyState icon={BarChart3} title="No metrics yet" description="Complete a job or send a quote and your numbers will appear here." />
      )}
    </div>
  );
}
