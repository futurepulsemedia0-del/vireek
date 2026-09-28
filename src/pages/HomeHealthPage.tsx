import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Play, TriangleAlert as AlertTriangle } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';
import {
  GRADE_STYLES,
  PIPELINE_STEPS,
  dismissHomeHealthAction,
  fetchHomeHealthActions,
  fetchHomeHealthScores,
  runHomeHealthAgent,
  stageProgress,
  windowLabel,
  type HomeHealthAction,
  type HomeHealthScore,
} from '@/lib/homeHealth';

const CLOSED = ['verified', 'declined', 'dismissed', 'expired'];
const DISMISSABLE = ['detected', 'explained', 'awaiting_customer'];

function PipelineStepper({ stage }: { stage: HomeHealthAction['stage'] }) {
  const done = stageProgress(stage);
  if (done === -1) {
    return <span className="rounded-full bg-bg-primary px-2.5 py-0.5 text-xs font-medium capitalize text-text-secondary">{stage}</span>;
  }
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label={`Pipeline progress: ${done} of ${PIPELINE_STEPS.length} steps complete`}>
      {PIPELINE_STEPS.map((step, i) => {
        const complete = i < done;
        const current = i === done;
        return (
          <li
            key={step.key}
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              complete ? 'bg-success-500/10 text-success-500' : current ? 'bg-accent/10 text-accent' : 'bg-bg-primary text-text-secondary'
            }`}
          >
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

export function HomeHealthPage() {
  const { toast } = useToast();
  const [scores, setScores] = useState<HomeHealthScore[]>([]);
  const [actions, setActions] = useState<HomeHealthAction[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([fetchHomeHealthScores(), fetchHomeHealthActions()]);
      setScores(s);
      setActions(a);
      const ids = Array.from(new Set([...s.map((x) => x.customer_id), ...a.map((x) => x.customer_id)]));
      if (ids.length > 0) {
        const { data } = await supabase.from('customers').select('id, name').in('id', ids);
        setNames(Object.fromEntries((data ?? []).map((c) => [c.id as string, c.name as string])));
      }
    } catch {
      toast('Could not load Home Health data', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const handleRun = async () => {
    setRunning(true);
    try {
      const r = await runHomeHealthAgent();
      toast(`Agent run complete — ${r.scored} homes scored, ${r.detected} new predictions, ${r.quoted} quotes sent`, 'success');
      await load();
    } catch {
      toast('The agent run failed. Check the home-health-agent function logs.', 'error');
    } finally {
      setRunning(false);
    }
  };

  const handleDismiss = async (id: string) => {
    try {
      const ok = await dismissHomeHealthAction(id);
      if (!ok) { toast('This prediction can no longer be dismissed', 'error'); return; }
      setActions((prev) => prev.map((a) => (a.id === id ? { ...a, stage: 'dismissed', blocked_reason: null } : a)));
    } catch {
      toast('Could not dismiss this prediction', 'error');
    }
  };

  const summary = useMemo(() => {
    const avg = scores.length ? Math.round(scores.reduce((s, x) => s + x.score, 0) / scores.length) : null;
    const open = actions.filter((a) => !CLOSED.includes(a.stage));
    return {
      avg,
      atRisk: scores.filter((s) => s.score < 55).length,
      open: open.length,
      verified: actions.filter((a) => a.stage === 'verified').length,
      needsYou: open.filter((a) => a.blocked_reason).length,
    };
  }, [scores, actions]);

  const openActions = actions.filter((a) => !CLOSED.includes(a.stage));

  return (
    <DashboardLayout activeLabel="Home Health">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Activity size={24} /></span>
          <div>
            <h1 className="text-xl font-bold text-text-primary">Home Health &amp; Proactive Maintenance</h1>
            <p className="text-sm text-text-secondary">Detect → Explain → Quote → Schedule → Dispatch → Repair → Verify, run by AI.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleRun}
          disabled={running}
          className="focus-ring flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          <Play size={14} /> {running ? 'Running…' : 'Run agent now'}
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              { label: 'Average home score', value: summary.avg === null ? '—' : String(summary.avg) },
              { label: 'Homes below 55', value: String(summary.atRisk) },
              { label: 'Active predictions', value: String(summary.open) },
              { label: 'Verified repairs', value: String(summary.verified) },
            ].map((k) => (
              <div key={k.label} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <p className="text-2xl font-bold text-text-primary">{k.value}</p>
                <p className="text-xs text-text-secondary">{k.label}</p>
              </div>
            ))}
          </div>

          <h2 className="mb-3 text-sm font-semibold text-text-primary">
            Pipeline {summary.needsYou > 0 && <span className="ml-2 text-xs font-medium text-warning-500">{summary.needsYou} need your attention</span>}
          </h2>
          {openActions.length === 0 ? (
            <div className="mb-8 rounded-2xl border border-border bg-bg-secondary p-8 text-center">
              <p className="text-sm text-text-secondary">
                No active predictions. Add equipment (with install dates) to customers, then run the agent — or wait for the scheduled run.
              </p>
            </div>
          ) : (
            <div className="mb-8 space-y-3">
              {openActions.map((a) => (
                <div key={a.id} className="rounded-2xl border border-border bg-bg-secondary p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${a.urgency === 'high' ? 'bg-danger-500/10 text-danger-500' : 'bg-warning-500/10 text-warning-500'}`}>
                          {a.urgency.toUpperCase()}
                        </span>
                        <Link to={`/dashboard/customers/${a.customer_id}`} className="text-sm font-semibold text-text-primary hover:text-accent">
                          {names[a.customer_id] ?? 'Customer'}
                        </Link>
                        <span className="text-xs text-text-secondary">
                          {a.action_type === 'replacement_planning' ? 'Replacement planning' : 'Maintenance'} · window {windowLabel(a.window_min_months, a.window_max_months)} · {Math.round(a.confidence * 100)}% confidence
                        </span>
                      </div>
                      {a.explanation && <p className="mt-1.5 text-sm text-text-secondary">{a.explanation}</p>}
                      <div className="mt-3"><PipelineStepper stage={a.stage} /></div>
                      {a.blocked_reason && (
                        <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-warning-500">
                          <AlertTriangle size={12} /> {a.blocked_reason}
                        </p>
                      )}
                    </div>
                    {DISMISSABLE.includes(a.stage) && (
                      <button
                        type="button"
                        onClick={() => handleDismiss(a.id)}
                        className="focus-ring shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
                      >
                        Dismiss
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <h2 className="mb-3 text-sm font-semibold text-text-primary">Homes, lowest score first</h2>
          {scores.length === 0 ? (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
              <p className="text-sm text-text-secondary">No homes scored yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="text-xs text-text-secondary">
                  <tr>
                    <th className="px-4 py-3 font-medium">Customer</th>
                    <th className="px-4 py-3 font-medium">Score</th>
                    <th className="px-4 py-3 font-medium">Grade</th>
                    <th className="px-4 py-3 font-medium">At risk</th>
                    <th className="px-4 py-3 font-medium">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {scores.map((s) => (
                    <tr key={s.id} className="border-t border-border">
                      <td className="px-4 py-3">
                        <Link to={`/dashboard/customers/${s.customer_id}`} className="font-medium text-text-primary hover:text-accent">
                          {names[s.customer_id] ?? 'Customer'}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-text-primary">{s.score}</td>
                      <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${GRADE_STYLES[s.grade]}`}>{s.grade}</span></td>
                      <td className="px-4 py-3 text-text-secondary">{s.at_risk_count} of {s.equipment_count}</td>
                      <td className="px-4 py-3 text-text-secondary">{Math.round(s.confidence * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </DashboardLayout>
  );
}
