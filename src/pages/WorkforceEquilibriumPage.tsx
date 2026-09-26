import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Scale, ArrowLeft, RefreshCw, CircleCheck, X, UserPlus, GraduationCap, Megaphone } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, WorkforceEquilibriumRun, WorkforceEquilibriumActionLog } from '@/lib/supabase';

const STATUS_COPY = {
  shortage: { label: 'Shortage', classes: 'bg-danger/10 text-danger' },
  balanced: { label: 'Balanced', classes: 'bg-emerald-500/10 text-emerald-600' },
  surplus: { label: 'Surplus', classes: 'bg-amber-500/10 text-amber-600' },
} as const;

const ACTION_ICON = {
  cross_train: GraduationCap,
  hire: UserPlus,
  reallocate_marketing: Megaphone,
} as const;

export function WorkforceEquilibriumPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [run, setRun] = useState<WorkforceEquilibriumRun | null>(null);
  const [statuses, setStatuses] = useState<Record<number, WorkforceEquilibriumActionLog['status']>>({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data: latestRun } = await supabase
      .from('workforce_equilibrium_runs')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setRun((latestRun as WorkforceEquilibriumRun | null) ?? null);

    if (latestRun) {
      const { data: logRows } = await supabase
        .from('workforce_equilibrium_action_log')
        .select('*')
        .eq('run_id', latestRun.id);
      const map: Record<number, WorkforceEquilibriumActionLog['status']> = {};
      for (const row of (logRows ?? []) as WorkforceEquilibriumActionLog[]) map[row.action_index] = row.status;
      setStatuses(map);
    } else {
      setStatuses({});
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { load(); }, [load]);

  const handleGenerateRun = async () => {
    setRunning(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const { data, error } = await supabase.functions.invoke('workforce-equilibrium-engine', {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: { horizon_weeks: 4 },
      });
      if (error) throw error;
      setRun(data?.run ?? null);
      setStatuses({});
      toast('Workforce equilibrium updated.', 'success');
    } catch {
      toast('Could not run the analysis. Make sure your team has skills and daily capacity set.', 'error');
    } finally {
      setRunning(false);
    }
  };

  const handleSetStatus = async (actionIndex: number, status: WorkforceEquilibriumActionLog['status']) => {
    if (!user || !run) return;
    setStatuses((prev) => ({ ...prev, [actionIndex]: status }));
    const { error } = await supabase.from('workforce_equilibrium_action_log').upsert(
      { user_id: user.id, run_id: run.id, action_index: actionIndex, status, updated_at: new Date().toISOString() },
      { onConflict: 'run_id,action_index' },
    );
    if (error) toast('Could not save that update.', 'error');
  };

  return (
    <DashboardLayout activeLabel="Workforce Equilibrium">
      <button type="button" onClick={() => navigate('/dashboard')} className="focus-ring mb-5 flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
        <ArrowLeft size={16} /> Back to dashboard
      </button>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Scale size={24} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Workforce Equilibrium Engine</h1>
            <p className="text-sm text-text-secondary">Per-skill technician supply vs. job demand, {run?.horizon_weeks ?? 4} weeks out.</p>
          </div>
        </div>
        <button onClick={handleGenerateRun} disabled={running} className="focus-ring flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60">
          <RefreshCw size={16} className={running ? 'animate-spin' : ''} /> {run ? 'Re-run Analysis' : 'Run Analysis'}
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : !run ? (
        <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">
          No analysis yet. Click "Run Analysis" — it reads your team's skills/capacity and job history, so add technicians with skills set first if you haven't.
        </p>
      ) : (
        <div className="space-y-6">
          {run.ai_summary && (
            <div className="rounded-2xl border border-border bg-bg-secondary p-5">
              <p className="text-sm leading-relaxed text-text-primary">{run.ai_summary}</p>
            </div>
          )}

          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-bg-secondary text-left text-xs uppercase text-text-secondary">
                <tr>
                  <th className="p-3">Skill</th>
                  <th className="p-3">Demand/wk</th>
                  <th className="p-3">Supply/wk</th>
                  <th className="p-3">Gap</th>
                  <th className="p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {run.skill_gaps.map((g) => (
                  <tr key={g.skill} className="border-t border-border">
                    <td className="p-3 font-medium text-text-primary">{g.skill}</td>
                    <td className="p-3">{g.weekly_demand}</td>
                    <td className="p-3">{g.weekly_supply}</td>
                    <td className={`p-3 font-semibold ${g.gap < 0 ? 'text-danger' : 'text-text-primary'}`}>{g.gap > 0 ? '+' : ''}{g.gap}</td>
                    <td className="p-3">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_COPY[g.status].classes}`}>{STATUS_COPY[g.status].label}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-text-primary">Ranked actions</h2>
            {run.actions.map((action, i) => {
              const status = statuses[i] ?? 'pending';
              if (status === 'dismissed') return null;
              const Icon = ACTION_ICON[action.action_type];
              return (
                <div key={i} className={`flex items-start gap-3 rounded-xl border border-border p-4 ${status === 'done' ? 'opacity-50' : ''}`}>
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <Icon size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className={`text-sm font-semibold text-text-primary ${status === 'done' ? 'line-through' : ''}`}>{action.title}</p>
                      <span className="text-sm font-semibold text-accent">{action.impact_jobs_per_week} job{action.impact_jobs_per_week === 1 ? '' : 's'}/wk</span>
                    </div>
                    <p className="mt-1 text-sm text-text-secondary">{action.detail}</p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <button
                      onClick={() => handleSetStatus(i, status === 'done' ? 'pending' : 'done')}
                      className={`focus-ring rounded-lg border border-border p-2 hover:bg-bg-secondary ${status === 'done' ? 'bg-emerald-500/10 text-emerald-600' : 'text-text-secondary'}`}
                      title="Mark done"
                    >
                      <CircleCheck size={16} />
                    </button>
                    <button
                      onClick={() => handleSetStatus(i, 'dismissed')}
                      className="focus-ring rounded-lg border border-border p-2 text-text-secondary hover:bg-bg-secondary"
                      title="Dismiss"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
