/**
 * Counterfactual Reality Engine — /dashboard/reality-engine
 * Logs real business decisions and compares the ACTUAL path of a chosen
 * metric after the decision to a COUNTERFACTUAL path: what this account's
 * own pre-decision trend (fit via linear regression on its own weekly
 * history) would have predicted had the decision not been made.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Route, Loader2, Plus, RefreshCw, Trash2, TrendingDown, TrendingUp, X } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  computeRealityPath,
  createRealityDecision,
  deleteRealityDecision,
  fetchRealityDecisions,
  type RealityDecision,
  type RealityDecisionCategory,
  type RealityMetric,
  type RealityPathResult,
} from '@/lib/counterfactualReality';

const CATEGORY_LABELS: Record<RealityDecisionCategory, string> = {
  pricing: 'Pricing change',
  marketing: 'Marketing / ad spend',
  staffing: 'Staffing / hiring',
  service_area: 'Service area',
  process: 'Process change',
  other: 'Other',
};

const METRIC_LABELS: Record<RealityMetric, string> = {
  revenue: 'Weekly revenue',
  leads: 'Weekly leads',
  bookings: 'Weekly bookings',
  jobs_completed: 'Weekly jobs completed',
  avg_ticket: 'Average ticket size',
};

const CONFIDENCE_STYLES: Record<'low' | 'medium' | 'high', string> = {
  high: 'bg-success-500/15 text-success-500',
  medium: 'bg-warning-500/15 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};

function formatMetricValue(metric: RealityMetric, value: number): string {
  if (metric === 'revenue' || metric === 'avg_ticket') return `$${Math.round(value).toLocaleString()}`;
  return Math.round(value).toLocaleString();
}

function formatWeekLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function RealityPathChart({ result }: { result: RealityPathResult }) {
  const weekly = result.weekly;
  const chartW = 640;
  const chartH = 200;
  const padding = { top: 12, right: 12, bottom: 24, left: 40 };
  const plotW = chartW - padding.left - padding.right;
  const plotH = chartH - padding.top - padding.bottom;

  const allValues = weekly.flatMap((w) => [w.actual, w.counterfactual]);
  const maxVal = Math.max(...allValues, 1);
  const xStep = weekly.length > 1 ? plotW / (weekly.length - 1) : 0;
  const yScale = (v: number) => padding.top + plotH - (v / maxVal) * plotH;
  const xScale = (i: number) => padding.left + i * xStep;

  const actualPath = weekly.map((w, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(w.actual)}`).join(' ');
  const cfPath = weekly.map((w, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(w.counterfactual)}`).join(' ');
  const decisionIdx = weekly.findIndex((w) => w.week_start >= result.decision_week);
  const yTicks = [0, Math.round(maxVal * 0.5), Math.round(maxVal)];

  return (
    <div>
      <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full" style={{ height: chartH }}>
        {yTicks.map((tick) => (
          <g key={tick}>
            <line x1={padding.left} y1={yScale(tick)} x2={chartW - padding.right} y2={yScale(tick)}
              stroke="rgb(var(--border-default))" strokeWidth="1" strokeDasharray="2 4" />
            <text x={padding.left - 6} y={yScale(tick) + 3} textAnchor="end" fontSize="10" fill="rgb(var(--text-secondary))">
              {formatMetricValue(result.metric, tick)}
            </text>
          </g>
        ))}
        {decisionIdx >= 0 && (
          <line x1={xScale(decisionIdx)} y1={padding.top} x2={xScale(decisionIdx)} y2={padding.top + plotH}
            stroke="rgb(217 119 6)" strokeWidth="1.5" strokeDasharray="3 3" />
        )}
        <path d={cfPath} fill="none" stroke="rgb(var(--text-secondary))" strokeWidth="2" strokeDasharray="5 4" />
        <path d={actualPath} fill="none" stroke="rgb(37 99 235)" strokeWidth="2.5" />
        {weekly.map((w, i) => (
          <circle key={i} cx={xScale(i)} cy={yScale(w.actual)} r="2.5" fill="rgb(37 99 235)" />
        ))}
        {weekly.length > 0 && (
          <>
            <text x={xScale(0)} y={chartH - 6} textAnchor="start" fontSize="10" fill="rgb(var(--text-secondary))">
              {formatWeekLabel(weekly[0].week_start)}
            </text>
            <text x={xScale(weekly.length - 1)} y={chartH - 6} textAnchor="end" fontSize="10" fill="rgb(var(--text-secondary))">
              {formatWeekLabel(weekly[weekly.length - 1].week_start)}
            </text>
          </>
        )}
      </svg>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-text-secondary">
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded bg-cta" /> Actual path</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded border-t-2 border-dashed border-text-secondary" /> Counterfactual (pre-decision trend)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-0.5 bg-warning-500" /> Decision point</span>
      </div>
    </div>
  );
}

function DecisionForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<RealityDecisionCategory>('pricing');
  const [decisionDate, setDecisionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [metric, setMetric] = useState<RealityMetric>('revenue');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!title.trim()) { toast('Give the decision a short title.', 'error'); return; }
    setSaving(true);
    try {
      await createRealityDecision({ title: title.trim(), category, decision_date: decisionDate, metric, description: description.trim() || undefined });
      toast('Decision logged.', 'success');
      onCreated();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not log this decision.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-text-primary">Log a decision</p>
        <button onClick={onClose} className="focus-ring rounded-lg p-1 text-text-secondary hover:bg-bg-tertiary"><X size={16} /></button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-text-secondary sm:col-span-2">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Raised HVAC service call-out fee 15%"
            className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
        </label>
        <label className="text-xs text-text-secondary">
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value as RealityDecisionCategory)}
            className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
            {Object.entries(CATEGORY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="text-xs text-text-secondary">
          Date it took effect
          <input type="date" value={decisionDate} onChange={(e) => setDecisionDate(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
        </label>
        <label className="text-xs text-text-secondary sm:col-span-2">
          Metric to track
          <select value={metric} onChange={(e) => setMetric(e.target.value as RealityMetric)}
            className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
            {Object.entries(METRIC_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="text-xs text-text-secondary sm:col-span-2">
          Notes (optional)
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
            className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />
        </label>
      </div>
      <button disabled={saving} onClick={submit}
        className="focus-ring mt-4 flex items-center gap-1.5 rounded-lg bg-cta px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Log decision
      </button>
    </div>
  );
}

export function CounterfactualRealityEnginePage() {
  const { toast } = useToast();
  const [decisions, setDecisions] = useState<RealityDecision[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchRealityDecisions();
      setDecisions(rows);
      setSelectedId((prev) => prev ?? rows[0]?.id ?? null);
    } catch {
      toast('Could not load logged decisions.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => decisions.find((d) => d.id === selectedId) ?? null, [decisions, selectedId]);

  const recalc = async (id: string) => {
    setComputing(true);
    try {
      const result = await computeRealityPath(id);
      setDecisions((prev) => prev.map((d) => (d.id === id ? { ...d, last_result: result, last_computed_at: new Date().toISOString() } : d)));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not compute this path.', 'error');
    } finally {
      setComputing(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteRealityDecision(id);
      toast('Decision removed.', 'success');
      if (selectedId === id) setSelectedId(null);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove this decision.', 'error');
    }
  };

  if (loading) {
    return <DashboardLayout activeLabel="Counterfactual Reality Engine"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  const result = selected?.last_result ?? null;

  return (
    <DashboardLayout activeLabel="Counterfactual Reality Engine">
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Route className="text-cta" size={20} />
            <p className="text-sm font-semibold text-text-primary">Counterfactual Reality Engine</p>
          </div>
          <button onClick={() => setShowForm((v) => !v)}
            className="focus-ring flex items-center gap-1.5 rounded-lg bg-cta/15 px-3 py-1.5 text-xs font-medium text-cta">
            <Plus size={14} /> Log a decision
          </button>
        </div>
        <p className="text-xs text-text-secondary">
          Log a real decision and see its actual path against the counterfactual — what this account's own
          pre-decision trend would have predicted had nothing changed. Every line is computed from this
          business's own weekly history, never a generic industry rule.
        </p>

        {showForm && <DecisionForm onClose={() => setShowForm(false)} onCreated={load} />}

        {decisions.length === 0 && !showForm && (
          <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center text-sm text-text-secondary">
            No decisions logged yet. Log a pricing change, a marketing shift, a hire — anything with a date —
            to start comparing its real path against the counterfactual.
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <div className="space-y-2">
            {decisions.map((d) => (
              <button key={d.id} onClick={() => setSelectedId(d.id)}
                className={`focus-ring block w-full rounded-xl border p-3 text-left text-sm ${selectedId === d.id ? 'border-cta bg-cta/10' : 'border-border bg-bg-secondary'}`}>
                <p className="font-medium text-text-primary">{d.title}</p>
                <p className="mt-0.5 text-xs text-text-secondary">{CATEGORY_LABELS[d.category]} · {new Date(d.decision_date).toLocaleDateString()}</p>
              </button>
            ))}
          </div>

          {selected && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">{selected.title}</p>
                  <p className="text-xs text-text-secondary">{METRIC_LABELS[selected.metric]} · effective {new Date(selected.decision_date).toLocaleDateString()}</p>
                  {selected.description && <p className="mt-1 text-xs text-text-secondary">{selected.description}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <button disabled={computing} onClick={() => recalc(selected.id)}
                    className="focus-ring flex items-center gap-1 rounded-lg bg-cta/15 px-3 py-1.5 text-xs font-medium text-cta disabled:opacity-50">
                    {computing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} {result ? 'Recalculate' : 'Calculate'}
                  </button>
                  <button onClick={() => remove(selected.id)} className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {!result && <p className="mt-4 text-sm text-text-secondary">Not calculated yet — click Calculate to build the comparison.</p>}

              {result && (
                <div className="mt-4 space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-xl border border-border bg-bg-primary p-3">
                      <p className="text-[10px] uppercase text-text-secondary">Actual (since decision)</p>
                      <p className="mt-1 text-sm font-semibold text-text-primary">{formatMetricValue(result.metric, result.cumulative_actual)}</p>
                    </div>
                    <div className="rounded-xl border border-border bg-bg-primary p-3">
                      <p className="text-[10px] uppercase text-text-secondary">Counterfactual path</p>
                      <p className="mt-1 text-sm font-semibold text-text-primary">{formatMetricValue(result.metric, result.cumulative_counterfactual)}</p>
                    </div>
                    <div className="rounded-xl border border-border bg-bg-primary p-3">
                      <p className="flex items-center gap-1 text-[10px] uppercase text-text-secondary">
                        {result.cumulative_impact >= 0 ? <TrendingUp size={11} className="text-success-500" /> : <TrendingDown size={11} className="text-danger-500" />} Impact
                      </p>
                      <p className={`mt-1 text-sm font-semibold ${result.cumulative_impact >= 0 ? 'text-success-500' : 'text-danger-500'}`}>
                        {result.cumulative_impact >= 0 ? '+' : ''}{formatMetricValue(result.metric, result.cumulative_impact)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${CONFIDENCE_STYLES[result.confidence]}`}>{result.confidence} confidence</span>
                    <span className="text-[10px] text-text-secondary">based on {result.pre_weeks_used} weeks of pre-decision history</span>
                  </div>
                  <RealityPathChart result={result} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
