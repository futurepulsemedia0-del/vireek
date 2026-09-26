/**
 * Business Digital Twin — /dashboard/digital-twin
 *
 * "What happens if..." — before you act. Build a baseline snapshot of
 * the business, stack a few levers (hire, price, marketing, demand,
 * churn), and project weeks forward with optimistic/pessimistic bands.
 * Later, record what actually happened and the twin recalibrates itself
 * — see src/lib/digitalTwin.ts for the math and the learning loop.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Boxes, Check, Loader2, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  adjustmentsToMap,
  blankLever,
  computeProjection,
  defaultBaseline,
  deleteRun,
  deleteScenario,
  fetchLearnedAdjustments,
  fetchRuns,
  fetchScenarios,
  formatDollars,
  formatPct,
  LEVER_LABELS,
  LEVER_VALUE_HINTS,
  LeverType,
  ProjectionResult,
  recordActualOutcome,
  saveRun,
  saveScenario,
  TwinActualOutcome,
  TwinBaseline,
  TwinLearnedAdjustment,
  TwinLever,
  TwinRun,
  TwinScenario,
} from '@/lib/digitalTwin';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';
const HORIZON_OPTIONS = [4, 8, 12, 26];

// ============================================================
// CHART
// ============================================================

function TwinChart({ weekly }: { weekly: ProjectionResult['weekly'] }) {
  if (weekly.length < 2) return null;
  const w = 700, h = 220, padding = { top: 16, right: 16, bottom: 24, left: 60 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  const values = weekly.flatMap((wk) => [wk.cash_cumulative_optimistic, wk.cash_cumulative_pessimistic]);
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const xScale = (i: number) => padding.left + (i / (weekly.length - 1)) * plotW;
  const yScale = (v: number) => padding.top + plotH - ((v - min) / (max - min)) * plotH;
  const zeroY = yScale(0);

  const path = (key: 'cash_cumulative_expected' | 'cash_cumulative_optimistic' | 'cash_cumulative_pessimistic') =>
    weekly.map((wk, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(wk[key])}`).join(' ');

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: h }}>
      <line x1={padding.left} y1={zeroY} x2={w - padding.right} y2={zeroY} stroke="rgb(var(--border))" strokeDasharray="4 4" />
      <path d={path('cash_cumulative_optimistic')} fill="none" stroke="rgb(var(--success-500))" strokeOpacity={0.5} strokeWidth={2} strokeDasharray="5 4" />
      <path d={path('cash_cumulative_pessimistic')} fill="none" stroke="rgb(var(--danger))" strokeOpacity={0.5} strokeWidth={2} strokeDasharray="5 4" />
      <path d={path('cash_cumulative_expected')} fill="none" stroke="rgb(var(--accent))" strokeWidth={2.5} />
      {weekly.map((wk, i) => (
        <circle
          key={wk.week_index}
          cx={xScale(i)}
          cy={yScale(wk.cash_cumulative_expected)}
          r={wk.cash_cumulative_expected < 0 ? 4 : 3}
          fill={wk.cash_cumulative_expected < 0 ? 'rgb(var(--danger))' : 'rgb(var(--accent))'}
        />
      ))}
      <text x={padding.left} y={h - 4} fontSize="10" fill="rgb(var(--text-secondary))">Week 1</text>
      <text x={w - padding.right} y={h - 4} fontSize="10" textAnchor="end" fill="rgb(var(--text-secondary))">
        Week {weekly[weekly.length - 1].week_index}
      </text>
    </svg>
  );
}

// ============================================================
// PAGE
// ============================================================

export function BusinessDigitalTwinPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [scenarios, setScenarios] = useState<TwinScenario[]>([]);
  const [runs, setRuns] = useState<TwinRun[]>([]);
  const [adjustments, setAdjustments] = useState<TwinLearnedAdjustment[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);

  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null);
  const [name, setName] = useState('New scenario');
  const [description, setDescription] = useState('');
  const [horizonWeeks, setHorizonWeeks] = useState(12);
  const [baseline, setBaseline] = useState<TwinBaseline>(defaultBaseline());
  const [levers, setLevers] = useState<TwinLever[]>([]);
  const [preview, setPreview] = useState<ProjectionResult | null>(null);
  const [confirmDeleteScenario, setConfirmDeleteScenario] = useState<string | null>(null);
  const [outcomeRun, setOutcomeRun] = useState<TwinRun | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [s, r, a] = await Promise.all([fetchScenarios(), fetchRuns(), fetchLearnedAdjustments()]);
      setScenarios(s);
      setRuns(r);
      setAdjustments(a);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to load the digital twin', 'error');
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const adjustmentMap = useMemo(() => adjustmentsToMap(adjustments), [adjustments]);

  const loadScenario = (s: TwinScenario) => {
    setActiveScenarioId(s.id);
    setName(s.name);
    setDescription(s.description ?? '');
    setHorizonWeeks(s.horizon_weeks);
    setBaseline(s.baseline);
    setLevers(s.levers);
    setPreview(null);
  };

  const newScenario = () => {
    setActiveScenarioId(null);
    setName('New scenario');
    setDescription('');
    setHorizonWeeks(12);
    setBaseline(defaultBaseline());
    setLevers([]);
    setPreview(null);
  };

  const addLever = (type: LeverType) => setLevers((prev) => [...prev, blankLever(type)]);
  const removeLever = (id: string) => setLevers((prev) => prev.filter((l) => l.id !== id));
  const updateLever = (id: string, patch: Partial<TwinLever>) =>
    setLevers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const updateBaseline = (key: keyof TwinBaseline, value: string) => {
    const n = Number(value);
    setBaseline((prev) => ({ ...prev, [key]: Number.isFinite(n) ? n : 0 }));
  };

  const runPreview = () => {
    setPreview(computeProjection(baseline, levers, horizonWeeks, adjustmentMap));
  };

  const handleSaveAndRun = async () => {
    if (!name.trim()) return toast('Give this scenario a name', 'error');
    setSaving(true);
    try {
      const scenario = await saveScenario({
        id: activeScenarioId ?? undefined,
        name,
        description,
        horizon_weeks: horizonWeeks,
        baseline,
        levers,
      });
      setActiveScenarioId(scenario.id);
      setRunning(true);
      const result = computeProjection(baseline, levers, horizonWeeks, adjustmentMap);
      setPreview(result);
      await saveRun(scenario.id, horizonWeeks, baseline, levers, result);
      await load();
      toast('Simulation run and saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to run the simulation', 'error');
    } finally {
      setSaving(false);
      setRunning(false);
    }
  };

  const handleDeleteScenario = async () => {
    if (!confirmDeleteScenario) return;
    try {
      await deleteScenario(confirmDeleteScenario);
      if (activeScenarioId === confirmDeleteScenario) newScenario();
      await load();
      toast('Scenario deleted', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to delete scenario', 'error');
    } finally {
      setConfirmDeleteScenario(null);
    }
  };

  const scenarioRuns = activeScenarioId ? runs.filter((r) => r.scenario_id === activeScenarioId) : runs;

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-accent" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-accent/10 p-2.5"><Boxes className="h-6 w-6 text-accent" /></div>
            <div>
              <h1 className="text-xl font-semibold text-text-primary">Business Digital Twin</h1>
              <p className="text-sm text-text-secondary">
                Simulate the future before you act. Stack levers, see the range of outcomes, then close the
                loop later with what actually happened.
              </p>
            </div>
          </div>
          <button onClick={newScenario} className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm font-medium text-text-primary hover:bg-bg-secondary">
            <Plus className="h-4 w-4" /> New scenario
          </button>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
          {/* Saved scenarios */}
          <div className="space-y-2">
            <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">Scenarios</h2>
            {scenarios.length === 0 && (
              <p className="rounded-xl border border-dashed border-border p-3 text-xs text-text-secondary">
                No scenarios yet — build one on the right.
              </p>
            )}
            {scenarios.map((s) => (
              <div
                key={s.id}
                className={`group flex items-center justify-between rounded-xl border px-3 py-2 text-sm ${
                  activeScenarioId === s.id ? 'border-accent bg-accent/5' : 'border-border hover:bg-bg-secondary'
                }`}
              >
                <button onClick={() => loadScenario(s)} className="focus-ring flex-1 truncate text-left text-text-primary">
                  {s.name}
                  <span className="ml-2 text-xs text-text-secondary">{s.horizon_weeks}w</span>
                </button>
                <button
                  onClick={() => setConfirmDeleteScenario(s.id)}
                  className="focus-ring rounded-lg p-1 text-text-secondary opacity-0 hover:text-danger group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

            {adjustments.length > 0 && (
              <div className="mt-4 space-y-1.5 rounded-xl border border-border p-3">
                <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                  <Sparkles className="h-3.5 w-3.5" /> What the twin has learned
                </h3>
                {adjustments.map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-xs text-text-secondary">
                    <span>{LEVER_LABELS[a.lever_type]}</span>
                    <span className="font-mono text-text-primary">
                      ×{a.adjustment_factor.toFixed(2)} · {a.confidence}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Builder */}
          <div className="space-y-6">
            <div className="rounded-2xl border border-border bg-bg-secondary/40 p-4 space-y-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <input className={inputClass} placeholder="Scenario name" value={name} onChange={(e) => setName(e.target.value)} />
                <select className={inputClass} value={horizonWeeks} onChange={(e) => setHorizonWeeks(Number(e.target.value))}>
                  {HORIZON_OPTIONS.map((h) => (
                    <option key={h} value={h}>{h} weeks</option>
                  ))}
                </select>
              </div>
              <textarea
                className={inputClass}
                placeholder="What is this scenario testing? (optional)"
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />

              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Baseline (this week, as-is)</h3>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <LabeledInput label="Weekly revenue" value={baseline.weekly_revenue} onChange={(v) => updateBaseline('weekly_revenue', v)} />
                  <LabeledInput label="Jobs / week" value={baseline.weekly_jobs_completed} onChange={(v) => updateBaseline('weekly_jobs_completed', v)} />
                  <LabeledInput label="Technicians" value={baseline.technician_count} onChange={(v) => updateBaseline('technician_count', v)} />
                  <LabeledInput label="Capacity hrs/tech/wk" value={baseline.technician_weekly_capacity_hours} onChange={(v) => updateBaseline('technician_weekly_capacity_hours', v)} />
                  <LabeledInput label="Avg job hours" value={baseline.avg_job_hours} onChange={(v) => updateBaseline('avg_job_hours', v)} />
                  <LabeledInput label="Marketing $/week" value={baseline.weekly_marketing_spend} onChange={(v) => updateBaseline('weekly_marketing_spend', v)} />
                  <LabeledInput label="Cash on hand" value={baseline.cash_on_hand} onChange={(v) => updateBaseline('cash_on_hand', v)} />
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Levers</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {(Object.keys(LEVER_LABELS) as LeverType[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => addLever(t)}
                        className="focus-ring rounded-lg border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
                      >
                        + {LEVER_LABELS[t]}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  {levers.length === 0 && (
                    <p className="rounded-xl border border-dashed border-border p-3 text-xs text-text-secondary">
                      No levers — add one above, or run the baseline as-is.
                    </p>
                  )}
                  {levers.map((l) => (
                    <div key={l.id} className="flex items-center gap-2 rounded-xl border border-border p-2">
                      <span className="w-40 shrink-0 text-xs text-text-secondary">{LEVER_LABELS[l.type]}</span>
                      <input
                        type="number"
                        className={`${inputClass} w-28`}
                        value={l.value}
                        onChange={(e) => updateLever(l.id, { value: Number(e.target.value) })}
                        title={LEVER_VALUE_HINTS[l.type]}
                      />
                      <span className="hidden flex-1 truncate text-xs text-text-secondary/70 md:block">{LEVER_VALUE_HINTS[l.type]}</span>
                      <button onClick={() => removeLever(l.id)} className="focus-ring rounded-lg p-1 text-text-secondary hover:text-danger">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                <button onClick={runPreview} className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-secondary">
                  <RefreshCw className="h-4 w-4" /> Preview
                </button>
                <button
                  onClick={handleSaveAndRun}
                  disabled={saving}
                  className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-60"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Save & run simulation
                </button>
              </div>
            </div>

            {preview && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-border p-4 space-y-4">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <SummaryCard label="Revenue" value={formatDollars(preview.summary.revenue_total_expected)} />
                  <SummaryCard label="Jobs completed" value={preview.summary.jobs_total_expected.toFixed(0)} />
                  <SummaryCard label="Avg utilization" value={formatPct(preview.summary.utilization_avg_expected)} />
                  <SummaryCard
                    label="Cash impact"
                    value={formatDollars(preview.summary.cash_delta_expected)}
                    tone={preview.summary.cash_delta_expected >= 0 ? 'good' : 'bad'}
                  />
                </div>
                <TwinChart weekly={preview.weekly} />
                <p className="text-sm text-text-secondary">{preview.narrative}</p>
              </motion.div>
            )}

            {/* Run history */}
            {scenarioRuns.length > 0 && (
              <div className="space-y-2">
                <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">Run history</h3>
                {scenarioRuns.map((r) => (
                  <div key={r.id} className="flex items-center justify-between rounded-xl border border-border p-3 text-sm">
                    <div>
                      <p className="text-text-primary">
                        {new Date(r.created_at).toLocaleDateString()} · {r.horizon_weeks}w ·{' '}
                        {formatDollars(r.summary.cash_delta_expected)} projected
                      </p>
                      {r.accuracy_score != null ? (
                        <p className="text-xs text-success-500">Compared to reality: {formatPct(r.accuracy_score * 100)} accurate</p>
                      ) : (
                        <p className="text-xs text-text-secondary">Not yet compared to what actually happened</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {r.accuracy_score == null && (
                        <button onClick={() => setOutcomeRun(r)} className="focus-ring rounded-lg border border-border px-2.5 py-1 text-xs text-text-primary hover:bg-bg-secondary">
                          Record actual outcome
                        </button>
                      )}
                      <button
                        onClick={async () => {
                          await deleteRun(r.id);
                          load();
                        }}
                        className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-danger"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {outcomeRun && (
        <RecordOutcomeModal
          run={outcomeRun}
          onClose={() => setOutcomeRun(null)}
          onSaved={async () => {
            setOutcomeRun(null);
            await load();
            toast('Recorded — the twin has recalibrated', 'success');
          }}
        />
      )}

      <ConfirmDialog
        open={!!confirmDeleteScenario}
        title="Delete scenario?"
        description="This also removes its saved simulation runs."
        confirmLabel="Delete"
        onConfirm={handleDeleteScenario}
        onCancel={() => setConfirmDeleteScenario(null)}
      />
    </DashboardLayout>
  );
}

function LabeledInput({ label, value, onChange }: { label: string; value: number; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-text-secondary">{label}</span>
      <input type="number" className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  const color = tone === 'good' ? 'text-success-500' : tone === 'bad' ? 'text-danger' : 'text-text-primary';
  return (
    <div className="rounded-xl border border-border p-3">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`text-lg font-semibold ${color}`}>{value}</p>
    </div>
  );
}

function RecordOutcomeModal({ run, onClose, onSaved }: { run: TwinRun; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [actual, setActual] = useState<TwinActualOutcome>({
    actual_revenue_total: run.summary.revenue_total_expected,
    actual_jobs_total: run.summary.jobs_total_expected,
    actual_utilization_avg_pct: run.summary.utilization_avg_expected,
    actual_cash_delta: run.summary.cash_delta_expected,
    notes: '',
  });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await recordActualOutcome(run, actual);
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to record outcome', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} className="w-full max-w-md rounded-2xl bg-bg-primary p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-text-primary">What actually happened?</h3>
          <button onClick={onClose} className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary"><X className="h-4 w-4" /></button>
        </div>
        <p className="mb-4 text-xs text-text-secondary">
          This closes the loop — the twin compares this to what it projected and recalibrates itself for next time.
        </p>
        <div className="space-y-3">
          <LabeledInput label="Actual revenue over the period" value={actual.actual_revenue_total} onChange={(v) => setActual((p) => ({ ...p, actual_revenue_total: Number(v) || 0 }))} />
          <LabeledInput label="Actual jobs completed" value={actual.actual_jobs_total} onChange={(v) => setActual((p) => ({ ...p, actual_jobs_total: Number(v) || 0 }))} />
          <LabeledInput label="Actual avg utilization %" value={actual.actual_utilization_avg_pct} onChange={(v) => setActual((p) => ({ ...p, actual_utilization_avg_pct: Number(v) || 0 }))} />
          <LabeledInput label="Actual cash impact" value={actual.actual_cash_delta} onChange={(v) => setActual((p) => ({ ...p, actual_cash_delta: Number(v) || 0 }))} />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="focus-ring rounded-xl border border-border px-4 py-2 text-sm text-text-primary hover:bg-bg-secondary">Cancel</button>
          <button onClick={submit} disabled={saving} className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-60">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save
          </button>
        </div>
      </motion.div>
    </div>
  );
}
