import { supabase } from '@/lib/supabase';

export type RoadmapDimension =
  | 'org_capability'
  | 'capacity'
  | 'data_systems'
  | 'process'
  | 'technician_skill'
  | 'cash_buffer'
  | 'customer_mix';

export type MilestoneStatus = 'not_started' | 'in_progress' | 'done' | 'at_risk' | 'blocked';

export interface RoadmapGoal {
  id: string;
  title: string;
  target_metric: string | null;
  horizon_months: number;
  start_date: string;
  status: 'active' | 'archived' | 'completed';
  created_at: string;
}

export interface RoadmapMilestone {
  id: string;
  goal_id: string;
  dimension: RoadmapDimension;
  quarter: 1 | 2 | 3 | 4;
  title: string;
  description: string | null;
  success_metric: string | null;
  owner_team_member_id: string | null;
  owner_name: string | null;
  status: MilestoneStatus;
  target_date: string | null;
  completed_at: string | null;
  is_auto_generated: boolean;
  sort_order: number;
}

export interface DimensionScore {
  dimension: RoadmapDimension;
  total_count: number;
  done_count: number;
  at_risk_count: number;
  score: number;
}

export const DIMENSION_LABELS: Record<RoadmapDimension, string> = {
  org_capability: 'Organizational Capability',
  capacity: 'Capacity',
  data_systems: 'Data & Systems',
  process: 'Process Maturity',
  technician_skill: 'Technician Skill',
  cash_buffer: 'Cash Buffer',
  customer_mix: 'Customer Mix',
};

export const STATUS_LABELS: Record<MilestoneStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
  at_risk: 'At risk',
  blocked: 'Blocked',
};

export const STATUS_COLORS: Record<MilestoneStatus, string> = {
  not_started: 'bg-bg-tertiary text-text-secondary',
  in_progress: 'bg-cta/15 text-cta',
  done: 'bg-success-500/15 text-success-500',
  at_risk: 'bg-warning-500/15 text-warning-500',
  blocked: 'bg-error-500/15 text-error-500',
};

export async function fetchActiveGoal(): Promise<RoadmapGoal | null> {
  const { data, error } = await supabase
    .from('business_roadmap_goals')
    .select('*')
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw error;
  return (data as RoadmapGoal) ?? null;
}

export async function setActiveGoal(title: string, targetMetric?: string, horizonMonths = 12): Promise<string> {
  const { data, error } = await supabase.rpc('set_active_roadmap_goal', {
    p_title: title,
    p_target_metric: targetMetric ?? null,
    p_horizon_months: horizonMonths,
  });
  if (error) throw error;
  return data as string;
}

export async function fetchMilestones(goalId: string): Promise<RoadmapMilestone[]> {
  const { data, error } = await supabase
    .from('business_roadmap_milestones')
    .select('*')
    .eq('goal_id', goalId)
    .order('quarter', { ascending: true })
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data as RoadmapMilestone[]) ?? [];
}

export async function updateMilestoneStatus(id: string, status: MilestoneStatus): Promise<void> {
  const { error } = await supabase.rpc('update_roadmap_milestone_status', { p_id: id, p_status: status });
  if (error) throw error;
}

export async function updateMilestoneFields(
  id: string,
  fields: Partial<Pick<RoadmapMilestone, 'title' | 'description' | 'success_metric' | 'target_date' | 'owner_name' | 'owner_team_member_id'>>
): Promise<void> {
  const { error } = await supabase.from('business_roadmap_milestones').update(fields).eq('id', id);
  if (error) throw error;
}

export async function addCustomMilestone(
  goalId: string,
  userId: string,
  dimension: RoadmapDimension,
  quarter: 1 | 2 | 3 | 4,
  title: string
): Promise<void> {
  const { error } = await supabase.from('business_roadmap_milestones').insert({
    goal_id: goalId,
    user_id: userId,
    dimension,
    quarter,
    title,
    is_auto_generated: false,
    sort_order: 999,
  });
  if (error) throw error;
}

export async function deleteMilestone(id: string): Promise<void> {
  const { error } = await supabase.from('business_roadmap_milestones').delete().eq('id', id);
  if (error) throw error;
}

export async function fetchDimensionScores(userId: string): Promise<DimensionScore[]> {
  const { data, error } = await supabase.rpc('get_roadmap_dimension_scores', { p_user_id: userId });
  if (error) throw error;
  return (data as DimensionScore[]) ?? [];
}
