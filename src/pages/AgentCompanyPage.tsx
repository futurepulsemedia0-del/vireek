/**
 * Multi-Agent Company — /dashboard/agent-company
 *
 * The organization chart for every autonomous agent already running in
 * this codebase (roster, built from agent_action_catalog + recent
 * agent_action_log activity — src/lib/agentGovernance.ts), plus the
 * shared task board (agent_tasks — src/lib/agentCompany.ts) agents use
 * to hand work and context to each other instead of acting in
 * isolation.
 */

import { useCallback, useEffect, useState } from 'react';
import { Users2, Bot, Loader2, Plus, X, ListTodo, Activity } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { fetchAgentActionLog } from '@/lib/agentGovernance';
import {
  fetchAgentRoster,
  fetchAgentTasks,
  createAgentTask,
  cancelAgentTask,
  agentSourceLabel,
  type AgentRosterEntry,
  type AgentTask,
  type AgentTaskPriority,
} from '@/lib/agentCompany';

const PRIORITY_STYLES: Record<AgentTaskPriority, string> = {
  low: 'bg-bg-tertiary text-text-secondary',
  normal: 'bg-accent/10 text-accent',
  high: 'bg-warning-500/10 text-warning-500',
  urgent: 'bg-danger/10 text-danger',
};

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-accent/10 text-accent',
  claimed: 'bg-warning-500/10 text-warning-500',
  completed: 'bg-success-500/10 text-success-500',
  failed: 'bg-danger/10 text-danger',
  cancelled: 'bg-bg-tertiary text-text-secondary',
};

export function AgentCompanyPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [roster, setRoster] = useState<AgentRosterEntry[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [targetAgent, setTargetAgent] = useState('');
  const [taskType, setTaskType] = useState('');
  const [priority, setPriority] = useState<AgentTaskPriority>('normal');
  const [reasoning, setReasoning] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rosterData, taskData, pendingLog] = await Promise.all([
        fetchAgentRoster(),
        fetchAgentTasks({ limit: 30 }),
        fetchAgentActionLog({ status: 'pending_approval', limit: 200 }),
      ]);
      const pendingBySource = new Map<string, number>();
      for (const entry of pendingLog) pendingBySource.set(entry.agent_source, (pendingBySource.get(entry.agent_source) ?? 0) + 1);
      setRoster(rosterData.map((r) => ({ ...r, pendingApprovals: pendingBySource.get(r.agent_source) ?? 0 })));
      setTasks(taskData);
      setTargetAgent((prev) => prev || rosterData[0]?.agent_source || '');
    } catch {
      toast('Could not load the agent company.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const handleCreateTask = async () => {
    if (!targetAgent || !taskType.trim()) {
      toast('Pick an agent and describe the task.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await createAgentTask({
        createdByAgent: 'dashboard',
        targetAgentSource: targetAgent,
        taskType: taskType.trim(),
        priority,
        reasoning: reasoning.trim() || undefined,
      });
      toast('Task posted to the board.', 'success');
      setTaskType(''); setReasoning(''); setShowForm(false);
      void load();
    } catch {
      toast('Could not create this task.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: string) => {
    try {
      await cancelAgentTask(id);
      toast('Task cancelled.', 'success');
      void load();
    } catch {
      toast('Could not cancel this task.', 'error');
    }
  };

  if (loading) {
    return <DashboardLayout activeLabel="Multi-Agent Company"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout activeLabel="Multi-Agent Company">
      <div className="space-y-6 p-6">
        <div className="flex items-center gap-2">
          <Users2 className="text-cta" size={20} />
          <p className="text-sm font-semibold text-text-primary">Multi-Agent Company</p>
        </div>
        <p className="-mt-4 text-sm text-text-secondary">
          Every autonomous agent already running here, and the shared board they use to hand work to each other.
        </p>

        {/* Roster */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {roster.map((r) => (
            <div key={r.agent_source} className="rounded-2xl border border-border bg-bg-secondary p-5">
              <div className="mb-2 flex items-center gap-2">
                <Bot size={16} className="text-cta" />
                <p className="text-sm font-semibold text-text-primary">{r.label}</p>
              </div>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {r.categories.map((c) => (
                  <span key={c} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">{c}</span>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-lg font-semibold text-text-primary">{r.activityLast30d}</p>
                  <p className="text-[10px] text-text-secondary">actions / 30d</p>
                </div>
                <div>
                  <p className={`text-lg font-semibold ${r.pendingApprovals > 0 ? 'text-warning-500' : 'text-text-primary'}`}>{r.pendingApprovals}</p>
                  <p className="text-[10px] text-text-secondary">await approval</p>
                </div>
                <div>
                  <p className={`text-lg font-semibold ${r.openTasksAssigned > 0 ? 'text-accent' : 'text-text-primary'}`}>{r.openTasksAssigned}</p>
                  <p className="text-[10px] text-text-secondary">open tasks</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Shared task board */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2"><ListTodo size={16} className="text-cta" /><p className="text-sm font-semibold text-text-primary">Shared task board</p></div>
            <button onClick={() => setShowForm((s) => !s)} className="focus-ring flex items-center gap-1.5 rounded-xl bg-cta px-3 py-1.5 text-xs font-medium text-white">
              {showForm ? <X size={12} /> : <Plus size={12} />} {showForm ? 'Cancel' : 'Hand off a task'}
            </button>
          </div>

          {showForm && (
            <div className="mb-4 grid gap-2 rounded-xl border border-border bg-bg-primary p-4 sm:grid-cols-2">
              <select className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary" value={targetAgent} onChange={(e) => setTargetAgent(e.target.value)}>
                {roster.map((r) => <option key={r.agent_source} value={r.agent_source}>{r.label}</option>)}
              </select>
              <select className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary" value={priority} onChange={(e) => setPriority(e.target.value as AgentTaskPriority)}>
                <option value="low">Low priority</option>
                <option value="normal">Normal priority</option>
                <option value="high">High priority</option>
                <option value="urgent">Urgent</option>
              </select>
              <input className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary sm:col-span-2" placeholder="Task type (e.g. review_pricing_conflict)" value={taskType} onChange={(e) => setTaskType(e.target.value)} />
              <textarea className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary sm:col-span-2" rows={2} placeholder="Why (optional)" value={reasoning} onChange={(e) => setReasoning(e.target.value)} />
              <button disabled={submitting} onClick={handleCreateTask} className="focus-ring flex w-fit items-center gap-1.5 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-50 sm:col-span-2">
                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Post task
              </button>
            </div>
          )}

          {tasks.length === 0 ? (
            <p className="text-sm text-text-secondary">Nothing on the board yet.</p>
          ) : (
            <div className="space-y-2">
              {tasks.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-text-primary">
                      {t.task_type} <span className="text-xs font-normal text-text-secondary">→ {agentSourceLabel(t.target_agent_source)}</span>
                    </p>
                    <p className="truncate text-xs text-text-secondary">
                      from {agentSourceLabel(t.created_by_agent)} · <Activity size={10} className="inline" /> {new Date(t.created_at).toLocaleString()}
                      {t.reasoning ? ` · ${t.reasoning}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${PRIORITY_STYLES[t.priority]}`}>{t.priority}</span>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[t.status]}`}>{t.status}</span>
                    {(t.status === 'open' || t.status === 'claimed') && (
                      <button onClick={() => handleCancel(t.id)} className="focus-ring rounded-lg bg-bg-tertiary px-2.5 py-1.5 text-xs font-medium text-text-secondary">Cancel</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
