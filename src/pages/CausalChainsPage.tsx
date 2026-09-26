/**
 * Causal Disruption Chain Engine — /dashboard/causal-chains
 * Finds which operational disruption (dispatch delay, missed calls,
 * reschedules) most strongly predicts changes in Conversion, Cancellation
 * and Revenue — using Pearson correlation on this account's own weekly
 * history, same-week and 1-week-lagged (to surface leading indicators).
 */

import { useCallback, useEffect, useState } from 'react';
import { Workflow, Loader2, RefreshCw, ArrowRight, Clock } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { computeCausalChainAnalysis, fetchCausalChainAnalysis, type CausalChainResult, type CausalWeekPoint } from '@/lib/causalChains';

const METRIC_LABELS: Record<string, string> = {
  dispatch_delay: 'Dispatch delay',
  missed_call_rate: 'Missed call rate',
  reschedule_rate: 'Reschedule rate',
  conversion_rate: 'Conversion rate',
  cancellation_rate: 'Cancellation rate',
  revenue: 'Revenue',
};

const CONFIDENCE_STYLES: Record<'low' | 'medium' | 'high', string> = {
  high: 'bg-success-500/15 text-success-500',
  medium: 'bg-warning-500/15 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};

function formatMetricPoint(metric: string, value: number | null): string {
  if (value === null || value === undefined) return '—';
  if (metric === 'dispatch_delay') return `${value.toFixed(1)}h`;
  if (metric === 'revenue') return `$${Math.round(value).toLocaleString()}`;
  return `${(value * 100).toFixed(1)}%`;
}

function strongerCorr(edge: { same_week_corr: number | null; next_week_corr: number | null }) {
  const same = edge.same_week_corr ?? 0;
  const next = edge.next_week_corr ?? 0;
  return Math.abs(next) >= Math.abs(same) ? { value: next, lagged: true } : { value: same, lagged: false };
}

function EdgeBar({ from, to, edge }: { from: string; to: string; edge: { same_week_corr: number | null; next_week_corr: number | null } }) {
  const { value, lagged } = strongerCorr(edge);
  const pct = Math.min(Math.abs(value) * 100, 100);
  const positive = value >= 0;
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1 font-medium text-text-primary">
          {METRIC_LABELS[from] ?? from} <ArrowRight size={11} className="text-text-secondary" /> {METRIC_LABELS[to] ?? to}
        </span>
        <span className="flex items-center gap-1 text-text-secondary">
          {lagged && <Clock size={10} />} {lagged ? '1 week later' : 'same week'} · {value.toFixed(2)}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
        <div className={`h-full rounded-full ${positive ? 'bg-danger-500' : 'bg-success-500'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function MiniTrend({ weekly, metric }: { weekly: CausalWeekPoint[]; metric: keyof CausalWeekPoint }) {
  const points = weekly.map((w) => (w[metric] as number | null) ?? 0);
  const maxVal = Math.max(...points, 0.0001);
  const chartW = 300;
  const chartH = 60;
  const xStep = points.length > 1 ? chartW / (points.length - 1) : 0;
  const yScale = (v: number) => chartH - (v / maxVal) * (chartH - 6) - 3;
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'} ${i * xStep} ${yScale(v)}`).join(' ');
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase text-text-secondary">{METRIC_LABELS[metric as string] ?? metric}</p>
      <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full" style={{ height: chartH }}>
        <path d={path} fill="none" stroke="rgb(37 99 235)" strokeWidth="2" />
      </svg>
    </div>
  );
}

export function CausalChainsPage() {
  const { toast } = useToast();
  const [result, setResult] = useState<CausalChainResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [computing, setComputing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setResult(await fetchCausalChainAnalysis());
    } catch {
      toast('Could not load the causal chain analysis.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const recalc = async () => {
    setComputing(true);
    try {
      setResult(await computeCausalChainAnalysis());
      toast('Causal chain analysis updated.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not compute the analysis.', 'error');
    } finally {
      setComputing(false);
    }
  };

  if (loading) {
    return <DashboardLayout activeLabel="Causal Disruption Chains"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout activeLabel="Causal Disruption Chains">
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Workflow className="text-cta" size={20} />
            <p className="text-sm font-semibold text-text-primary">Causal Disruption Chain Engine</p>
          </div>
          <button disabled={computing} onClick={recalc}
            className="focus-ring flex items-center gap-1.5 rounded-lg bg-cta/15 px-3 py-1.5 text-xs font-medium text-cta disabled:opacity-50">
            {computing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} {result ? 'Recalculate' : 'Analyze'}
          </button>
        </div>
        <p className="text-xs text-text-secondary">
          Correlates operational disruptions with Conversion, Cancellation and Revenue on this account's own
          weekly history — same-week and 1-week-lagged, to surface which one is a leading indicator.
        </p>

        {!result && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center text-sm text-text-secondary">
            No analysis yet. Click Analyze to scan your operational and business history.
          </div>
        )}

        {result && (
          <>
            {result.top_driver && (
              <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-text-primary">Strongest discovered chain</p>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${CONFIDENCE_STYLES[result.confidence]}`}>{result.confidence} confidence</span>
                </div>
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-text-primary">
                  {METRIC_LABELS[result.top_driver.from_metric]} <ArrowRight size={13} className="text-text-secondary" />
                  {METRIC_LABELS[result.top_driver.to_metric]}
                  <span className="text-xs text-text-secondary">
                    ({result.top_driver.leading ? '1 week lag' : 'same week'}, r = {strongerCorr(result.top_driver).value.toFixed(2)})
                  </span>
                </p>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <MiniTrend weekly={result.weekly} metric={result.top_driver.from_metric as keyof CausalWeekPoint} />
                  <MiniTrend weekly={result.weekly} metric={result.top_driver.to_metric as keyof CausalWeekPoint} />
                </div>
              </div>
            )}

            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <p className="mb-3 text-sm font-semibold text-text-primary">Operational → business correlations</p>
              <div className="space-y-2">
                {result.edges.filter((e) => ['dispatch_delay', 'missed_call_rate', 'reschedule_rate'].includes(e.from_metric)).map((e, i) => (
                  <EdgeBar key={i} from={e.from_metric} to={e.to_metric} edge={e} />
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <p className="mb-3 text-sm font-semibold text-text-primary">Downstream business chain</p>
              <div className="space-y-2">
                {result.business_chain.map((e, i) => (
                  <EdgeBar key={i} from={e.from_metric} to={e.to_metric} edge={e} />
                ))}
              </div>
            </div>

            <p className="text-[10px] text-text-secondary">
              Based on {result.weeks_analyzed} weeks of history ({result.weeks_with_dispatch_data} with dispatch data).
              Metric values: {['dispatch_delay', 'missed_call_rate', 'reschedule_rate', 'conversion_rate', 'cancellation_rate', 'revenue']
                .map((m) => `${METRIC_LABELS[m]} ${formatMetricPoint(m, result.weekly[result.weekly.length - 1]?.[m as keyof CausalWeekPoint] as number)}`)
                .join(' · ')}
            </p>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
