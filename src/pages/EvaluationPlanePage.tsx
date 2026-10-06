/**
 * Intelligence Evaluation Plane — /dashboard/evaluation-plane
 *
 * One place to answer "can we trust this model, where is it weak, and is it
 * getting worse?" for every probabilistic model (First-Time-Fix, Outcome
 * Assurance, Quote Truth): calibration, segment performance, drift, AI cost /
 * latency / safety, version comparison and an append-only promote / rollback
 * decision log. All math lives in src/lib/evaluationPlane.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Microscope, Loader2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  DEFAULT_EVAL_POLICY,
  DIM_LABELS,
  EVAL_MODELS,
  fetchAiOps,
  fetchEvalDecisions,
  fetchEvaluation,
  recordEvalDecision,
  saveEvalPolicy,
  type AiOpsSummary,
  type EvalDecision,
  type EvalDecisionKind,
  type EvalDim,
  type EvalMetrics,
  type EvalModelKey,
  type EvalPolicy,
  type EvalStatus,
  type Evaluation,
  type VersionVerdict,
} from '@/lib/evaluationPlane';

const STATUS_STYLES: Record<EvalStatus, string> = {
  good: 'bg-success-500/10 text-success-500',
  degrading: 'bg-warning-500/10 text-warning-500',
  poor: 'bg-danger/10 text-danger',
  insufficient: 'bg-bg-tertiary text-text-secondary',
};
const STATUS_LABELS: Record<EvalStatus, string> = { good: 'Good', degrading: 'Degrading', poor: 'Poor', insufficient: 'Not enough data' };

const VERDICT_TEXT: Record<VersionVerdict, string> = {
  single_version: 'Only one version has outcomes — nothing to compare yet.',
  insufficient: 'Not enough labeled outcomes to compare versions.',
  latest_better: 'Evidence supports promoting the latest version.',
  latest_worse: 'Evidence supports rolling back to the previous version.',
  no_difference: 'No meaningful difference between the latest two versions.',
};

const DECISIONS: Array<{ value: EvalDecisionKind; label: string }> = [
  { value: 'promote', label: 'Promote' },
  { value: 'rollback', label: 'Roll back' },
  { value: 'hold', label: 'Hold' },
  { value: 'acknowledge', label: 'Acknowledge' },
];

const pct = (v: number | null, digits = 1) => (v === null ? '—' : `${(v * 100).toFixed(digits)}%`);
const num3 = (v: number | null) => (v === null ? '—' : v.toFixed(3));

function StatusBadge({ status }: { status: EvalStatus }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>{STATUS_LABELS[status]}</span>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xl font-semibold text-text-primary">{value}</p>
      <p className="text-xs text-text-secondary">{label}</p>
      {hint && <p className="mt-1 text-[10px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function biasText(m: EvalMetrics): string {
  if (m.bias === null) return '—';
  if (Math.abs(m.bias) < 0.02) return 'Balanced';
  return m.bias > 0 ? `Over-confident (+${pct(m.bias)})` : `Under-confident (${pct(m.bias)})`;
}

const inputCls = 'focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary';

export function EvaluationPlanePage() {
  const { toast } = useToast();
  const [model, setModel] = useState<EvalModelKey>('first_time_fix');
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(true);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [aiOps, setAiOps] = useState<AiOpsSummary | null>(null);
  const [decisions, setDecisions] = useState<EvalDecision[]>([]);
  const [dimFilter, setDimFilter] = useState<EvalDim | 'all'>('all');
  const [policyDraft, setPolicyDraft] = useState<EvalPolicy>(DEFAULT_EVAL_POLICY);
  const [showPolicy, setShowPolicy] = useState(false);
  const [decision, setDecision] = useState<EvalDecisionKind>('acknowledge');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    const [ev, ops, log] = await Promise.allSettled([fetchEvaluation(model, days), fetchAiOps(days), fetchEvalDecisions(model)]);
    if (id !== reqId.current) return; // a newer request superseded this one
    if (ev.status === 'fulfilled') {
      setEvaluation(ev.value);
      setPolicyDraft(ev.value.policy);
    } else {
      setEvaluation(null);
      toast('Could not load the evaluation.', 'error');
    }
    setAiOps(ops.status === 'fulfilled' ? ops.value : null);
    setDecisions(log.status === 'fulfilled' ? log.value : []);
    setLoading(false);
  }, [model, days, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSavePolicy = async () => {
    const p = policyDraft;
    if (!(p.ece_warn < p.ece_fail && p.skill_fail < p.skill_warn && p.drift_warn < p.drift_fail)) {
      toast('Thresholds must be ordered: warn below fail (skill: fail below warn).', 'error');
      return;
    }
    setBusy(true);
    try {
      await saveEvalPolicy(model, p);
      toast('Thresholds saved.', 'success');
      setShowPolicy(false);
      await load();
    } catch {
      toast('Could not save thresholds.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDecision = async () => {
    if (!evaluation) return;
    if (reason.trim().length < 10) {
      toast('Write a reason of at least 10 characters.', 'error');
      return;
    }
    const cmp = evaluation.comparison;
    const version = (decision === 'rollback' ? cmp.previous : cmp.latest) ?? evaluation.versions[0]?.version ?? 'v1';
    setBusy(true);
    try {
      await recordEvalDecision(model, version, decision, reason.trim(), {
        window_days: days,
        overall: { n: evaluation.overall.current.n, brier: evaluation.overall.current.brier, ece: evaluation.overall.current.ece, skill: evaluation.overall.current.skill },
        verdict: cmp.verdict,
      });
      toast('Decision recorded.', 'success');
      setReason('');
      setDecisions(await fetchEvalDecisions(model));
    } catch {
      toast('Could not record the decision.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const o = evaluation?.overall;
  const dims = evaluation ? (Array.from(new Set(evaluation.segments.map((s) => s.dim))) as EvalDim[]) : [];
  const segments = evaluation ? evaluation.segments.filter((s) => dimFilter === 'all' || s.dim === dimFilter) : [];
  const evalPassRate = aiOps && aiOps.eval.cases > 0 ? aiOps.eval.passes / aiOps.eval.cases : null;

  const policyField = (key: keyof EvalPolicy, label: string, step: number) => (
    <label className="flex flex-col gap-1 text-xs text-text-secondary">
      {label}
      <input
        type="number"
        step={step}
        className={inputCls}
        value={policyDraft[key]}
        onChange={(e) => setPolicyDraft((d) => ({ ...d, [key]: Number(e.target.value) }))}
      />
    </label>
  );

  return (
    <DashboardLayout activeLabel="Evaluation Plane">
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-2">
          <Microscope className="text-cta" size={20} />
          <p className="text-sm font-semibold text-text-primary">Intelligence Evaluation Plane</p>
        </div>
        <p className="-mt-4 text-sm text-text-secondary">
          Prediction → actual outcome → error → calibration → segments → drift → cost → version decision. A prediction counts only if it was made before its outcome.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(EVAL_MODELS) as EvalModelKey[]).map((k) => (
            <button
              key={k}
              onClick={() => setModel(k)}
              className={`focus-ring rounded-xl px-3 py-1.5 text-xs font-medium ${model === k ? 'bg-cta text-white' : 'bg-bg-tertiary text-text-secondary'}`}
            >
              {EVAL_MODELS[k].label}
            </button>
          ))}
          <select className={`${inputCls} ml-auto py-1.5 text-xs`} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 180 days</option>
          </select>
        </div>

        {loading && !evaluation ? (
          <div className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 size={16} className="animate-spin" /> Loading…</div>
        ) : !evaluation || !o ? (
          <div className="rounded-2xl border border-border bg-bg-secondary p-5 text-sm text-text-secondary">
            The evaluation could not be loaded. Check that the migration is applied and that you have owner, admin or billing access.
          </div>
        ) : (
          <div className={`space-y-6 ${loading ? 'opacity-60' : ''}`}>
            {/* Overall */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={o.assessment.status} />
                <p className="text-xs text-text-secondary">Event being predicted: {EVAL_MODELS[model].event}</p>
              </div>
              {o.assessment.reasons.length > 0 && (
                <ul className="list-disc pl-5 text-xs text-text-secondary">{o.assessment.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              )}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="Labeled outcomes" value={String(o.current.n)} hint={`Min ${evaluation.policy.min_sample}`} />
                <Stat label="Brier (lower is better)" value={num3(o.current.brier)} hint={`Base rate ${num3(o.current.brierRef)}`} />
                <Stat label="Skill vs base rate" value={pct(o.current.skill)} />
                <Stat label="Calibration error (ECE)" value={pct(o.current.ece)} />
                <Stat label="Bias" value={biasText(o.current)} />
                <Stat label="Drift vs prior window" value={o.assessment.drift === null ? '—' : `${o.assessment.drift > 0 ? '+' : ''}${o.assessment.drift.toFixed(3)}`} hint="Brier change" />
              </div>
            </div>

            {/* Calibration */}
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <p className="mb-1 text-sm font-semibold text-text-primary">Calibration — when it says X%, how often is it right?</p>
              <p className="mb-4 text-xs text-text-secondary">Perfect calibration: the two bars match in every row.</p>
              {o.current.bins.length === 0 ? (
                <p className="text-sm text-text-secondary">No labeled outcomes in this window yet.</p>
              ) : (
                <div className="space-y-2">
                  {o.current.bins.map((b) => (
                    <div key={b.bin} className="grid grid-cols-[72px_1fr_64px] items-center gap-3 text-xs">
                      <span className="text-text-secondary">{b.label}</span>
                      <div className="space-y-1">
                        <div className="h-2 rounded-full bg-bg-tertiary"><div className="h-2 rounded-full bg-accent" style={{ width: `${b.predicted * 100}%` }} /></div>
                        <div className="h-2 rounded-full bg-bg-tertiary"><div className="h-2 rounded-full bg-cta" style={{ width: `${b.actual * 100}%` }} /></div>
                      </div>
                      <span className="text-right text-text-secondary">n={b.n}</span>
                    </div>
                  ))}
                  <p className="pt-1 text-[10px] text-text-secondary">Top bar: predicted · Bottom bar: actual</p>
                </div>
              )}
            </div>

            {/* Segments */}
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <p className="mr-auto text-sm font-semibold text-text-primary">Segment performance</p>
                {(['all', ...dims] as Array<EvalDim | 'all'>).map((d) => (
                  <button key={d} onClick={() => setDimFilter(d)} className={`focus-ring rounded-full px-2.5 py-1 text-xs ${dimFilter === d ? 'bg-cta text-white' : 'bg-bg-tertiary text-text-secondary'}`}>
                    {d === 'all' ? 'All' : DIM_LABELS[d]}
                  </button>
                ))}
              </div>
              {segments.length === 0 ? (
                <p className="text-sm text-text-secondary">No segment data for this model yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-text-secondary">
                      <tr><th className="py-2 pr-3">Segment</th><th className="pr-3">n</th><th className="pr-3">Brier</th><th className="pr-3">Skill</th><th className="pr-3">ECE</th><th className="pr-3">Drift</th><th>Status</th></tr>
                    </thead>
                    <tbody className="text-text-primary">
                      {segments.map((s) => (
                        <tr key={`${s.dim}-${s.seg}`} className="border-t border-border" title={s.assessment.reasons.join(' · ')}>
                          <td className="py-2 pr-3"><span className="text-text-secondary">{DIM_LABELS[s.dim]}: </span>{s.seg}</td>
                          <td className="pr-3">{s.current.n}</td>
                          <td className="pr-3">{num3(s.current.brier)}</td>
                          <td className="pr-3">{pct(s.current.skill)}</td>
                          <td className="pr-3">{pct(s.current.ece)}</td>
                          <td className="pr-3">{s.assessment.drift === null ? '—' : `${s.assessment.drift > 0 ? '+' : ''}${s.assessment.drift.toFixed(3)}`}</td>
                          <td><StatusBadge status={s.assessment.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Versions + decision */}
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <p className="mb-1 text-sm font-semibold text-text-primary">Model versions &amp; promotion gate</p>
              <p className="mb-3 text-xs text-text-secondary">{VERDICT_TEXT[evaluation.comparison.verdict]}</p>
              {evaluation.comparison.reasons.length > 0 && (
                <ul className="mb-3 list-disc pl-5 text-xs text-text-secondary">{evaluation.comparison.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              )}
              <div className="mb-4 flex flex-wrap gap-2">
                {evaluation.versions.map((v) => (
                  <div key={v.version} className="rounded-xl bg-bg-tertiary px-3 py-2 text-xs text-text-primary">
                    <span className="font-semibold">{v.version}</span> · n={v.current.n} · Brier {num3(v.current.brier)} · ECE {pct(v.current.ece)} <StatusBadge status={v.assessment.status} />
                  </div>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-[160px_1fr_auto]">
                <select className={inputCls} value={decision} onChange={(e) => setDecision(e.target.value as EvalDecisionKind)}>
                  {DECISIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
                <input className={inputCls} placeholder="Reason (required, 10+ characters)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
                <button disabled={busy} onClick={handleDecision} className="focus-ring flex items-center justify-center gap-1.5 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                  {busy && <Loader2 size={14} className="animate-spin" />} Record
                </button>
              </div>
              <p className="mt-2 text-[10px] text-text-secondary">Decisions are an append-only audit trail with the evidence frozen at that moment. They do not switch the running engine by themselves.</p>
              {decisions.length > 0 && (
                <div className="mt-4 space-y-2">
                  {decisions.map((d) => (
                    <div key={d.id} className="rounded-xl border border-border px-3 py-2 text-xs">
                      <span className="font-semibold text-text-primary">{d.decision}</span> <span className="text-text-secondary">{d.version} · {new Date(d.created_at).toLocaleString()}</span>
                      <p className="text-text-secondary">{d.reason}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* AI ops */}
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <p className="mb-1 text-sm font-semibold text-text-primary">AI cost, latency &amp; safety (last {days} days)</p>
              {!aiOps || (aiOps.tasks.length === 0 && aiOps.eval.runs === 0) ? (
                <p className="text-sm text-text-secondary">No AI usage or eval runs recorded in this window.</p>
              ) : (
                <>
                  <div className="my-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Stat label="Eval runs" value={String(aiOps.eval.runs)} />
                    <Stat label="Eval pass rate" value={pct(evalPassRate)} />
                    <Stat label="Hallucinations flagged" value={String(aiOps.eval.hallucinations)} />
                    <Stat label="Total AI spend" value={`$${aiOps.tasks.reduce((s, t) => s + t.total_cost_usd, 0).toFixed(2)}`} />
                  </div>
                  {aiOps.tasks.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="text-text-secondary">
                          <tr><th className="py-2 pr-3">Task</th><th className="pr-3">Calls</th><th className="pr-3">Success</th><th className="pr-3">Fallback</th><th className="pr-3">p50</th><th className="pr-3">p95</th><th className="pr-3">$/call</th><th>Total</th></tr>
                        </thead>
                        <tbody className="text-text-primary">
                          {aiOps.tasks.map((t) => (
                            <tr key={t.task} className="border-t border-border">
                              <td className="py-2 pr-3">{t.task}</td>
                              <td className="pr-3">{t.calls}</td>
                              <td className={`pr-3 ${t.ok_rate < 0.95 ? 'text-warning-500' : ''}`}>{pct(t.ok_rate)}</td>
                              <td className="pr-3">{pct(t.fallback_rate)}</td>
                              <td className="pr-3">{t.p50_ms} ms</td>
                              <td className="pr-3">{t.p95_ms} ms</td>
                              <td className="pr-3">${t.avg_cost_usd.toFixed(4)}</td>
                              <td>${t.total_cost_usd.toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Policy */}
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <button onClick={() => setShowPolicy((s) => !s)} className="focus-ring text-sm font-semibold text-text-primary">
                Thresholds for this model {showPolicy ? '▲' : '▼'}
              </button>
              {showPolicy && (
                <div className="mt-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {policyField('min_sample', 'Min labeled outcomes', 1)}
                    {policyField('ece_warn', 'ECE warn', 0.01)}
                    {policyField('ece_fail', 'ECE fail', 0.01)}
                    {policyField('skill_warn', 'Skill warn', 0.01)}
                    {policyField('skill_fail', 'Skill fail', 0.01)}
                    {policyField('drift_warn', 'Drift warn (Brier)', 0.01)}
                    {policyField('drift_fail', 'Drift fail (Brier)', 0.01)}
                  </div>
                  <button disabled={busy} onClick={handleSavePolicy} className="focus-ring flex items-center gap-1.5 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                    {busy && <Loader2 size={14} className="animate-spin" />} Save thresholds
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
