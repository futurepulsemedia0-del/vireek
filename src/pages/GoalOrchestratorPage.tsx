import { useCallback, useEffect, useState } from 'react';
import { Target, Sparkles, ChevronDown, ChevronRight, Loader2, Archive } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useRealtimeSubscription } from '@/lib/realtime';
import {
  ACTION_STATUS_COLORS,
  ACTION_TYPE_LABELS,
  ActionStatus,
  GoalAction,
  GoalStrategy,
  StrategicGoal,
  archiveGoal,
  createAndDecomposeGoal,
  fetchGoals,
  fetchStrategiesWithActions,
  updateActionStatus,
} from '@/lib/goalOrchestrator';

function GoalCard({ goal, onArchived }: { goal: StrategicGoal; onArchived: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<{ strategy: GoalStrategy; actions: GoalAction[] }[] | null>(null);

  const load = useCallback(async () => {
    setRows(await fetchStrategiesWithActions(goal.id));
  }, [goal.id]);

  useEffect(() => {
    if (expanded && !rows) load();
  }, [expanded, rows, load]);

  useRealtimeSubscription({
    channelName: `goal-actions-${goal.id}`,
    table: 'goal_actions',
    event: 'UPDATE',
    enabled: expanded,
    onChange: load,
  });

  const handleStatusChange = async (actionId: string, status: ActionStatus) => {
    setRows((prev) => prev?.map((r) => ({ ...r, actions: r.actions.map((a) => (a.id === actionId ? { ...a, status } : a)) })) ?? null);
    await updateActionStatus(actionId, status);
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary">
      <button type="button" onClick={() => setExpanded((v) => !v)} className="focus-ring flex w-full items-center gap-3 px-5 py-4 text-left">
        {expanded ? <ChevronDown size={16} className="shrink-0 text-text-secondary" /> : <ChevronRight size={16} className="shrink-0 text-text-secondary" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text-primary">{goal.vision}</p>
          <p className="text-xs text-text-secondary">
            {goal.target_metric ? `${goal.target_metric} · ` : ''}
            {goal.horizon_days}-day horizon
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-bg-tertiary">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${goal.progress_pct}%` }} />
          </div>
          <span className="w-10 text-right text-xs font-medium text-text-secondary">{goal.progress_pct}%</span>
        </div>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-border px-5 py-4">
          {!rows ? (
            <p className="flex items-center gap-2 text-sm text-text-secondary">
              <Loader2 size={14} className="animate-spin" /> Loading strategies…
            </p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-text-secondary">No strategies yet.</p>
          ) : (
            rows.map(({ strategy, actions }) => (
              <div key={strategy.id}>
                <p className="text-sm font-medium text-text-primary">{strategy.title}</p>
                {strategy.rationale && <p className="mt-0.5 text-xs text-text-secondary">{strategy.rationale}</p>}
                <div className="mt-2 space-y-1.5">
                  {actions.map((action) => (
                    <div key={action.id} className="flex items-center gap-2 rounded-lg border border-border/60 bg-bg-primary px-3 py-2">
                      <select
                        value={action.status}
                        onChange={(e) => handleStatusChange(action.id, e.target.value as ActionStatus)}
                        className={`focus-ring shrink-0 rounded-md border-0 px-2 py-0.5 text-[11px] font-medium ${ACTION_STATUS_COLORS[action.status]}`}
                      >
                        <option value="open">Open</option>
                        <option value="in_progress">In progress</option>
                        <option value="done">Done</option>
                        <option value="blocked">Blocked</option>
                      </select>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-text-primary">{action.title}</p>
                        <p className="truncate text-xs text-text-secondary">
                          {ACTION_TYPE_LABELS[action.action_type]}
                          {action.owner_name ? ` · ${action.owner_name}` : ''}
                          {action.due_at ? ` · due ${new Date(action.due_at).toLocaleDateString()}` : ''}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
          <button
            type="button"
            onClick={async () => {
              await archiveGoal(goal.id);
              onArchived();
            }}
            className="focus-ring flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary"
          >
            <Archive size={13} /> Archive goal
          </button>
        </div>
      )}
    </div>
  );
}

export function GoalOrchestratorPage() {
  const [goals, setGoals] = useState<StrategicGoal[] | null>(null);
  const [vision, setVision] = useState('');
  const [targetMetric, setTargetMetric] = useState('');
  const [horizonDays, setHorizonDays] = useState(90);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setGoals(await fetchGoals('active'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vision.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await createAndDecomposeGoal({ vision: vision.trim(), target_metric: targetMetric.trim() || undefined, horizon_days: horizonDays });
      setVision('');
      setTargetMetric('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not decompose this goal.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DashboardLayout activeLabel="Goals">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex items-center gap-2">
          <Target size={18} className="text-accent" />
          <h1 className="text-lg font-semibold text-text-primary">Goal Decomposition Orchestrator</h1>
        </div>

        <form onSubmit={handleSubmit} className="mb-8 space-y-3 rounded-2xl border border-border bg-bg-secondary p-5">
          <label className="block text-sm font-medium text-text-primary">
            What's the goal?
            <textarea
              value={vision}
              onChange={(e) => setVision(e.target.value)}
              placeholder="e.g. Grow monthly recurring revenue 20% over the next quarter"
              rows={2}
              className="focus-ring mt-1.5 w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary"
            />
          </label>
          <div className="flex gap-3">
            <label className="flex-1 text-xs font-medium text-text-secondary">
              Target metric (optional)
              <input
                value={targetMetric}
                onChange={(e) => setTargetMetric(e.target.value)}
                placeholder="e.g. MRR"
                className="focus-ring mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
              />
            </label>
            <label className="w-32 text-xs font-medium text-text-secondary">
              Horizon (days)
              <input
                type="number"
                min={7}
                max={730}
                value={horizonDays}
                onChange={(e) => setHorizonDays(Number(e.target.value))}
                className="focus-ring mt-1 w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
              />
            </label>
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={!vision.trim() || submitting}
            className="focus-ring flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {submitting ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {submitting ? 'Decomposing…' : 'Decompose into strategies & actions'}
          </button>
        </form>

        <div className="space-y-3">
          {goals === null ? (
            <p className="text-sm text-text-secondary">Loading…</p>
          ) : goals.length === 0 ? (
            <p className="text-sm text-text-secondary">No active goals yet — state one above.</p>
          ) : (
            goals.map((goal) => <GoalCard key={goal.id} goal={goal} onArchived={load} />)
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
