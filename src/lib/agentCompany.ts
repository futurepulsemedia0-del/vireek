import { supabase } from '@/lib/supabase';
import type { AgentActionCatalogEntry, AgentActionLogEntry, AgentActionCategory } from '@/lib/agentGovernance';

/**
 * Multi-Agent Company — dashboard client library.
 *
 * Two things live here:
 *  1. The roster — every agent already registered in agent_action_catalog
 *     (src/lib/agentGovernance.ts), grouped by agent_source into one
 *     "team member" card with its recent activity from agent_action_log.
 *     No new table for this — it's a view over data that already exists.
 *  2. The shared task board — agent_tasks (see
 *     supabase/migrations/20261203000000_agent_company_tasks.sql), the
 *     handoff mechanism agents use to coordinate work with each other.
 */

export type AgentTaskStatus = 'open' | 'claimed' | 'completed' | 'failed' | 'cancelled';
export type AgentTaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface AgentTask {
  id: string;
  user_id: string;
  created_by_agent: string;
  target_agent_source: string;
  task_type: string;
  priority: AgentTaskPriority;
  payload: Record<string, unknown>;
  target_table: string | null;
  target_id: string | null;
  reasoning: string | null;
  status: AgentTaskStatus;
  claimed_by_agent: string | null;
  claimed_at: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// Friendly names for known agent_source slugs — falls back to a
// title-cased version of the slug for any agent registered later that
// isn't listed here yet, so nothing breaks when a new one is added.
export const AGENT_SOURCE_LABELS: Record<string, string> = {
  'workflow-engine-executor': 'Workflow Engine',
  'outbound-dialer': 'Outbound Dialer',
  'followup-agent-dispatcher': 'Follow-up Dispatcher',
  'financing-create-offer': 'Financing Desk',
  'marketing-campaign-dispatcher': 'Marketing Campaigns',
  'membership-lifecycle-agent': 'Membership Lifecycle',
  'business-decision-engine': 'Business Decision Engine',
};

export function agentSourceLabel(source: string): string {
  return (
    AGENT_SOURCE_LABELS[source] ??
    source
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  );
}

export interface AgentRosterEntry {
  agent_source: string;
  label: string;
  categories: AgentActionCategory[];
  actions: AgentActionCatalogEntry[];
  activityLast30d: number;
  pendingApprovals: number;
  openTasksAssigned: number;
}

/**
 * Builds the roster from agent_action_catalog (who exists, what they're
 * allowed to do) plus a bounded recent slice of agent_action_log (how
 * busy they've actually been) and open agent_tasks (what's waiting on
 * them). The log slice is a recent snapshot, not a full-history
 * aggregate — matches the same lightweight-dashboard-stat approach used
 * elsewhere (e.g. fetchAgentActionLog's own default limit).
 */
export async function fetchAgentRoster(): Promise<AgentRosterEntry[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [catalogRes, logRes, tasksRes] = await Promise.all([
    supabase.from('agent_action_catalog').select('*'),
    supabase.from('agent_action_log').select('agent_source').gte('created_at', since).limit(1000),
    supabase.from('agent_tasks').select('target_agent_source, status').eq('status', 'open'),
  ]);
  if (catalogRes.error) throw catalogRes.error;
  if (logRes.error) throw logRes.error;
  if (tasksRes.error) throw tasksRes.error;

  const catalog = (catalogRes.data as AgentActionCatalogEntry[]) ?? [];
  const recentLog = (logRes.data as Pick<AgentActionLogEntry, 'agent_source'>[]) ?? [];
  const openTasks = (tasksRes.data as Pick<AgentTask, 'target_agent_source' | 'status'>[]) ?? [];

  const bySource = new Map<string, AgentActionCatalogEntry[]>();
  for (const entry of catalog) {
    const list = bySource.get(entry.agent_source) ?? [];
    list.push(entry);
    bySource.set(entry.agent_source, list);
  }

  return Array.from(bySource.entries()).map(([agent_source, actions]) => ({
    agent_source,
    label: agentSourceLabel(agent_source),
    categories: Array.from(new Set(actions.map((a) => a.category))),
    actions,
    activityLast30d: recentLog.filter((l) => l.agent_source === agent_source).length,
    pendingApprovals: 0, // filled in by the page from fetchAgentActionLog({status:'pending_approval'}) — avoids a second full table scan here
    openTasksAssigned: openTasks.filter((t) => t.target_agent_source === agent_source).length,
  }));
}

export async function fetchAgentTasks(options?: { status?: AgentTaskStatus; limit?: number }): Promise<AgentTask[]> {
  const { status, limit = 50 } = options ?? {};
  let query = supabase.from('agent_tasks').select('*').order('created_at', { ascending: false }).limit(limit);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return (data as AgentTask[]) ?? [];
}

export async function createAgentTask(params: {
  createdByAgent: string;
  targetAgentSource: string;
  taskType: string;
  priority?: AgentTaskPriority;
  payload?: Record<string, unknown>;
  reasoning?: string;
}): Promise<AgentTask> {
  const { data, error } = await supabase.rpc('create_agent_task', {
    p_created_by_agent: params.createdByAgent,
    p_target_agent_source: params.targetAgentSource,
    p_task_type: params.taskType,
    p_priority: params.priority ?? 'normal',
    p_payload: params.payload ?? {},
    p_reasoning: params.reasoning ?? null,
  });
  if (error) throw error;
  return data as AgentTask;
}

export async function cancelAgentTask(taskId: string): Promise<AgentTask> {
  const { data, error } = await supabase.rpc('cancel_agent_task', { p_task_id: taskId });
  if (error) throw error;
  return data as AgentTask;
}
