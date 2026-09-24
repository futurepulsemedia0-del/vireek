import { useEffect, useMemo, useState, useCallback } from 'react';
import { Microscope, RefreshCw, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import {
  fetchCallbackCases,
  analyzeCallback,
  computeRootCausePatterns,
  fetchPreventionWorkflows,
  savePreventionWorkflow,
  updateWorkflowStatus,
  ROOT_CAUSE_LABELS,
  type CallbackCase,
  type RootCausePattern,
  type PreventionWorkflow,
} from '@/lib/callbackRootCause';

const SEVERITY_COLORS: Record<string, string> = {
  low: 'text-text-secondary bg-bg-secondary',
  medium: 'text-warning-500 bg-warning-500/10',
  high: 'text-danger bg-danger/10',
};

export function CallbackRootCausePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [cases, setCases] = useState<CallbackCase[]>([]);
  const [workflows, setWorkflows] = useState<PreventionWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, w] = await Promise.all([fetchCallbackCases(), fetchPreventionWorkflows()]);
      setCases(c);
      setWorkflows(w);
    } catch {
      toast('Could not load callback data.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const patterns = useMemo(() => computeRootCausePatterns(cases), [cases]);
  const unanalyzed = cases.filter((c) => !c.analysis);
  const analyzed = cases.filter((c) => c.analysis);

  const handleAnalyze = async (jobId: string) => {
    setAnalyzingId(jobId);
    try {
      await analyzeCallback(jobId);
      toast('Root cause analyzed.', 'success');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Analysis failed.', 'error');
    } finally {
      setAnalyzingId(null);
    }
  };

  const handleCreateWorkflow = async (pattern: RootCausePattern) => {
    if (!user) return;
    try {
      await savePreventionWorkflow(pattern, user.id);
      toast('Prevention workflow created.', 'success');
      load();
    } catch {
      toast('Could not create workflow.', 'error');
    }
  };

  const handleWorkflowStatus = async (id: string, status: PreventionWorkflow['status']) => {
    try {
      await updateWorkflowStatus(id, status);
      setWorkflows((prev) => prev.map((w) => (w.id === id ? { ...w, status } : w)));
    } catch {
      toast('Could not update workflow.', 'error');
    }
  };

  const existingWorkflowKeys = useMemo(() => new Set(workflows.map((w) => w.pattern_key)), [workflows]);

  if (loading) {
    return (
      <DashboardLayout activeLabel="Callback Root-Cause">
        <p className="text-sm text-text-secondary">Loading...</p>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Callback Root-Cause">
      <div className="mb-8">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
          <Microscope size={22} /> Callback Root-Cause & Prevention
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          AI links every callback to the technician, diagnosis, part, equipment and job type behind it — then flags recurring
          patterns before they repeat again.
        </p>
      </div>

      {cases.length === 0 ? (
        <EmptyState icon={Microscope} title="No callbacks yet" description="Once a job is flagged as a callback (is_rework), it will appear here for analysis." />
      ) : (
        <div className="space-y-8">
          {patterns.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Recurring patterns</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {patterns.map((p) => (
                  <Card key={p.patternKey} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-text-primary">{p.title}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${SEVERITY_COLORS[p.severity]}`}>{p.severity}</span>
                    </div>
                    <p className="mt-1.5 text-xs text-text-secondary">{p.description}</p>
                    <p className="mt-2 text-xs text-text-primary">
                      <span className="font-medium">Recommended: </span>
                      {p.recommendedAction}
                    </p>
                    <button
                      type="button"
                      disabled={existingWorkflowKeys.has(p.patternKey)}
                      onClick={() => handleCreateWorkflow(p)}
                      className="focus-ring mt-3 w-full rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {existingWorkflowKeys.has(p.patternKey) ? 'Workflow created' : 'Create prevention workflow'}
                    </button>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {workflows.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Prevention workflows</h2>
              <div className="space-y-2">
                {workflows.map((w) => (
                  <Card key={w.id} className="flex items-center justify-between gap-4 p-4">
                    <div>
                      <p className="text-sm font-medium text-text-primary">{w.title}</p>
                      <p className="text-xs text-text-secondary">{w.description}</p>
                    </div>
                    <select
                      value={w.status}
                      onChange={(e) => handleWorkflowStatus(w.id, e.target.value as PreventionWorkflow['status'])}
                      className="rounded-lg border border-border bg-bg-primary px-2 py-1 text-xs"
                    >
                      <option value="open">Open</option>
                      <option value="in_progress">In progress</option>
                      <option value="resolved">Resolved</option>
                      <option value="dismissed">Dismissed</option>
                    </select>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {unanalyzed.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Awaiting analysis ({unanalyzed.length})</h2>
              <div className="space-y-2">
                {unanalyzed.map((c) => (
                  <Card key={c.callback_job_id} className="flex items-center justify-between gap-4 p-4">
                    <div>
                      <p className="text-sm font-medium text-text-primary">{c.customer_name}</p>
                      <p className="text-xs text-text-secondary">
                        {c.service_type ?? 'Unknown type'} · {c.technician_name ?? 'Unassigned'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleAnalyze(c.callback_job_id)}
                      disabled={analyzingId === c.callback_job_id}
                      className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {analyzingId === c.callback_job_id ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                      Analyze
                    </button>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {analyzed.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Analyzed callbacks ({analyzed.length})</h2>
              <div className="space-y-2">
                {analyzed.map((c) => (
                  <Card key={c.callback_job_id} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-text-primary">{c.customer_name}</p>
                        <p className="text-xs text-text-secondary">
                          {c.service_type ?? 'Unknown type'} · {c.technician_name ?? 'Unassigned'}
                        </p>
                      </div>
                      <span className="flex items-center gap-1 rounded-full bg-bg-secondary px-2 py-0.5 text-[11px] font-medium text-text-primary">
                        {c.analysis!.status === 'resolved' ? <CheckCircle2 size={12} className="text-success-500" /> : <XCircle size={12} className="text-warning-500" />}
                        {ROOT_CAUSE_LABELS[c.analysis!.root_cause_category]}
                      </span>
                    </div>
                    {c.analysis?.ai_summary && <p className="mt-2 text-xs text-text-secondary">{c.analysis.ai_summary}</p>}
                    {c.analysis?.recommended_prevention_action && (
                      <p className="mt-1.5 text-xs text-text-primary">
                        <span className="font-medium">Prevention: </span>
                        {c.analysis.recommended_prevention_action}
                      </p>
                    )}
                  </Card>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </DashboardLayout>
  );
}
