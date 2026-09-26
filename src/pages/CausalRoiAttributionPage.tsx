/**
 * Causal ROI Attribution — /dashboard/causal-roi
 * Measures the CAUSAL effect of AI actions (Next Best Actions taken,
 * Workflow Engine runs completed) on Revenue, Retention and Cost — using a
 * matched-control estimator, not a raw correlation. Shows both numbers
 * side by side so the gap between them is visible.
 */

import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Loader2, Sparkles, TrendingUp, TrendingDown, Shield, DollarSign } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  computeCausalRoiAttribution,
  fetchCausalRoiByActionType,
  fetchCausalRoiSummary,
  fetchPendingAiActionEvents,
  type CausalRoiByActionTypeRow,
  type CausalRoiSummaryRow,
  type KpiCategory,
  type PendingAiActionEvent,
} from '@/lib/causalRoiAttribution';

const KPI_META: Record<KpiCategory, { label: string; icon: typeof DollarSign; good: 'up' | 'down' }> = {
  revenue: { label: 'Revenue', icon: DollarSign, good: 'up' },
  retention: { label: 'Retention', icon: Shield, good: 'up' },
  cost: { label: 'Cost', icon: TrendingDown, good: 'down' },
};

function formatValue(value: number, unit: 'dollars' | 'percentage_points'): string {
  if (unit === 'percentage_points') return `${value > 0 ? '+' : ''}${value.toFixed(1)} pts`;
  return `${value > 0 ? '+' : ''}$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function isGood(value: number, good: 'up' | 'down'): boolean {
  return good === 'up' ? value > 0 : value < 0;
}

export function CausalRoiAttributionPage() {
  const { toast } = useToast();
  const [summary, setSummary] = useState<CausalRoiSummaryRow[]>([]);
  const [byActionType, setByActionType] = useState<CausalRoiByActionTypeRow[]>([]);
  const [pending, setPending] = useState<PendingAiActionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, b, p] = await Promise.all([
        fetchCausalRoiSummary(),
        fetchCausalRoiByActionType(),
        fetchPendingAiActionEvents(20),
      ]);
      setSummary(s);
      setByActionType(b);
      setPending(p);
    } catch {
      toast('Could not load Causal ROI Attribution.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const analyze = async (event: PendingAiActionEvent) => {
    setAnalyzingId(event.id);
    try {
      await computeCausalRoiAttribution(event.id);
      toast('Causal attribution computed.', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Analysis failed.', 'error');
    } finally {
      setAnalyzingId(null);
    }
  };

  if (loading) {
    return (
      <DashboardLayout activeLabel="Causal ROI Attribution">
        <div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Causal ROI Attribution">
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-2">
          <FlaskConical className="text-cta" size={20} />
          <p className="text-sm font-semibold text-text-primary">Causal ROI Attribution</p>
        </div>
        <p className="-mt-4 max-w-2xl text-xs text-text-secondary">
          For every AI action taken, we build a matched control group of similar jobs where no AI action fired, and
          compare outcomes. That causal estimate sits next to the naive correlation number so you can see how much
          the naive number would have misled you.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {(['revenue', 'retention', 'cost'] as KpiCategory[]).map((cat) => {
            const meta = KPI_META[cat];
            const Icon = meta.icon;
            const row = summary.find((s) => s.kpi_category === cat);
            return (
              <div key={cat} className="rounded-2xl border border-border bg-bg-secondary p-5">
                <div className="mb-3 flex items-center gap-2">
                  <Icon size={16} className="text-text-secondary" />
                  <p className="text-sm font-semibold text-text-primary">{meta.label}</p>
                </div>
                {!row ? (
                  <p className="text-xs text-text-secondary">No AI actions analyzed yet.</p>
                ) : (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span className={`text-xl font-bold ${isGood(row.causal_total, meta.good) ? 'text-success-500' : 'text-danger-500'}`}>
                        {formatValue(row.causal_total, row.unit)}
                      </span>
                      <span className="text-[10px] uppercase text-text-secondary">causal</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1 text-xs text-text-secondary">
                      {row.causal_total >= row.correlation_total ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                      <span>correlation-only said {formatValue(row.correlation_total, row.unit)}</span>
                    </div>
                    <p className="mt-3 text-[11px] text-text-secondary">
                      {row.analyzed_count} action{row.analyzed_count === 1 ? '' : 's'} analyzed · {row.high_confidence_count} high confidence
                    </p>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {pending.length > 0 && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="mb-3 text-sm font-semibold text-text-primary">AI actions ready to attribute</p>
            <div className="space-y-2">
              {pending.map((event) => (
                <div key={event.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <div>
                    <span className="font-medium text-text-primary">{event.action_type}</span>
                    <span className="ml-2 text-xs text-text-secondary">
                      {event.source === 'next_best_action' ? 'Next Best Action taken' : 'Workflow completed'} · {new Date(event.occurred_at).toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    disabled={analyzingId === event.id}
                    onClick={() => analyze(event)}
                    className="focus-ring flex items-center gap-1 rounded-lg bg-cta/15 px-3 py-1.5 text-xs font-medium text-cta disabled:opacity-50"
                  >
                    {analyzingId === event.id ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} Attribute
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <p className="mb-3 text-sm font-semibold text-text-primary">Which AI actions actually move the needle</p>
          {byActionType.length === 0 ? (
            <p className="text-sm text-text-secondary">Analyze at least one action above to see a breakdown.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-text-secondary">
                    <th className="pb-2 pr-4 font-medium">Action</th>
                    <th className="pb-2 pr-4 font-medium">KPI</th>
                    <th className="pb-2 pr-4 font-medium">Causal effect</th>
                    <th className="pb-2 pr-4 font-medium">Correlation-only</th>
                    <th className="pb-2 font-medium">Sample</th>
                  </tr>
                </thead>
                <tbody>
                  {byActionType.map((row) => (
                    <tr key={`${row.action_type}-${row.kpi_category}`} className="border-b border-border/50">
                      <td className="py-2 pr-4 text-text-primary">{row.action_type}</td>
                      <td className="py-2 pr-4 text-text-secondary">{KPI_META[row.kpi_category].label}</td>
                      <td className={`py-2 pr-4 font-semibold ${isGood(row.avg_causal_estimate, KPI_META[row.kpi_category].good) ? 'text-success-500' : 'text-danger-500'}`}>
                        {formatValue(row.avg_causal_estimate, row.unit)}
                      </td>
                      <td className="py-2 pr-4 text-text-secondary">{formatValue(row.avg_correlation_estimate, row.unit)}</td>
                      <td className="py-2 text-text-secondary">{row.analyzed_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
