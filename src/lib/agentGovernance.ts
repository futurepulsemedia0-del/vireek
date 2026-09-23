import { supabase } from '@/lib/supabase';

/**
 * AI Agent Governance — dashboard client library.
 *
 * Every autonomous agent in this codebase (workflow SMS/call steps, the
 * outbound dialer, the follow-up dispatcher, the business decision
 * engine, ...) proposes its actions through the evaluate_agent_action()
 * RPC (see supabase/functions/_shared/governance/agentGovernance.ts and
 * supabase/migrations/20261121000000_ai_agent_governance.sql). This
 * module is the read/write surface the dashboard uses on top of the
 * same tables: policy per action type, spending limits, the pending
 * approval queue, and the audit trail.
 */

export type AgentActionCategory = 'messaging' | 'calling' | 'financial' | 'marketing' | 'other';

export interface AgentActionCatalogEntry {
  slug: string;
  agent_source: string;
  label: string;
  category: AgentActionCategory;
  is_reversible: boolean;
  has_cost: boolean;
  default_requires_approval: boolean;
}

export interface AgentPermission {
  user_id: string;
  action_slug: string;
  enabled: boolean;
  requires_approval: boolean | null;
  auto_approve_max_cents: number | null;
  updated_at: string;
}

export type AgentSpendPeriod = 'daily' | 'weekly' | 'monthly';

export interface AgentSpendingLimit {
  id: string;
  user_id: string;
  action_slug: string | null;
  period: AgentSpendPeriod;
  limit_cents: number;
  updated_at: string;
}

export type AgentActionStatus =
  | 'auto_approved'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'failed'
  | 'rolled_back';

export interface AgentActionLogEntry {
  id: string;
  user_id: string;
  action_slug: string;
  agent_source: string;
  target_table: string | null;
  target_id: string | null;
  amount_cents: number | null;
  reasoning: string | null;
  payload: Record<string, unknown>;
  rollback_patch: Record<string, unknown> | null;
  status: AgentActionStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  executed_at: string | null;
  error: string | null;
  rolled_back_at: string | null;
  created_at: string;
}

export const AGENT_ACTION_STATUS_LABELS: Record<AgentActionStatus, string> = {
  auto_approved: 'Auto-approved',
  pending_approval: 'Needs approval',
  approved: 'Approved',
  rejected: 'Rejected',
  executed: 'Executed',
  failed: 'Failed',
  rolled_back: 'Rolled back',
};

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

// ---- Reads ----

export async function fetchAgentCatalog(): Promise<AgentActionCatalogEntry[]> {
  const { data, error } = await supabase.from('agent_action_catalog').select('*').order('category');
  if (error) throw error;
  return (data as AgentActionCatalogEntry[]) ?? [];
}

export async function fetchAgentPermissions(): Promise<AgentPermission[]> {
  const { data, error } = await supabase.from('agent_permissions').select('*');
  if (error) throw error;
  return (data as AgentPermission[]) ?? [];
}

export async function fetchAgentSpendingLimits(): Promise<AgentSpendingLimit[]> {
  const { data, error } = await supabase.from('agent_spending_limits').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return (data as AgentSpendingLimit[]) ?? [];
}

export async function fetchAgentActionLog(options?: {
  status?: AgentActionStatus;
  limit?: number;
  before?: string;
}): Promise<AgentActionLogEntry[]> {
  const { status, limit = 50, before } = options ?? {};
  let query = supabase.from('agent_action_log').select('*').order('created_at', { ascending: false }).limit(limit);
  if (status) query = query.eq('status', status);
  if (before) query = query.lt('created_at', before);
  const { data, error } = await query;
  if (error) throw error;
  return (data as AgentActionLogEntry[]) ?? [];
}

export async function fetchPendingApprovalCount(): Promise<number> {
  const { count, error } = await supabase
    .from('agent_action_log')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending_approval');
  if (error) throw error;
  return count ?? 0;
}

/** Sum of everything spent (auto-approved + approved + executed) since the start of the given period, across all actions. */
export async function fetchSpendThisPeriod(period: AgentSpendPeriod): Promise<number> {
  const now = new Date();
  const start =
    period === 'daily'
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
      : period === 'weekly'
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay())
        : new Date(now.getFullYear(), now.getMonth(), 1);

  const { data, error } = await supabase
    .from('agent_action_log')
    .select('amount_cents')
    .in('status', ['auto_approved', 'approved', 'executed'])
    .gte('created_at', start.toISOString())
    .not('amount_cents', 'is', null);
  if (error) throw error;
  return (data ?? []).reduce((sum, row) => sum + (row.amount_cents ?? 0), 0);
}

// ---- Writes (all via SECURITY DEFINER RPCs — see the migration) ----

export async function upsertAgentPermission(params: {
  actionSlug: string;
  enabled?: boolean;
  /** Pass null to clear the override and fall back to the catalog default. */
  requiresApproval?: boolean | null;
  /** Pass null to clear the auto-approve ceiling. */
  autoApproveMaxCents?: number | null;
}): Promise<AgentPermission> {
  const { data, error } = await supabase.rpc('upsert_agent_permission', {
    p_action_slug: params.actionSlug,
    p_enabled: params.enabled ?? null,
    p_requires_approval: params.requiresApproval ?? null,
    p_clear_requires_approval: params.requiresApproval === null,
    p_auto_approve_max_cents: params.autoApproveMaxCents ?? null,
    p_clear_auto_approve_max: params.autoApproveMaxCents === null,
  });
  if (error) throw error;
  return data as AgentPermission;
}

export async function upsertAgentSpendingLimit(params: {
  /** Omit or null for a global cap across every cost-bearing action. */
  actionSlug?: string | null;
  period: AgentSpendPeriod;
  limitCents: number;
}): Promise<AgentSpendingLimit> {
  const { data, error } = await supabase.rpc('upsert_agent_spending_limit', {
    p_action_slug: params.actionSlug ?? null,
    p_period: params.period,
    p_limit_cents: params.limitCents,
  });
  if (error) throw error;
  return data as AgentSpendingLimit;
}

export async function deleteAgentSpendingLimit(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_agent_spending_limit', { p_id: id });
  if (error) throw error;
}

export async function decideAgentAction(logId: string, approve: boolean, reason?: string): Promise<AgentActionLogEntry> {
  const { data, error } = await supabase.rpc('decide_agent_action', {
    p_log_id: logId,
    p_approve: approve,
    p_reason: reason ?? null,
  });
  if (error) throw error;
  return data as AgentActionLogEntry;
}

export async function rollbackAgentAction(logId: string): Promise<AgentActionLogEntry> {
  const { data, error } = await supabase.rpc('rollback_agent_action', { p_log_id: logId });
  if (error) throw error;
  return data as AgentActionLogEntry;
}
