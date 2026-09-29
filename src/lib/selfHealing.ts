import { supabase } from '@/lib/supabase';

/**
 * Self-Healing Operations — dashboard client library.
 *
 * Rows are written only by the self-healing-orchestrator Edge
 * Function's service-role client (see
 * supabase/functions/self-healing-orchestrator). This module is
 * read-only: it renders the Detect -> Predict -> Decide -> Act ->
 * Verify loop the agent already ran.
 */

export type IncidentStage = 'detecting' | 'acting' | 'awaiting_verification' | 'resolved';
export type IncidentType = 'technician_delayed' | 'eta_missed';
export type RiskTier = 'low' | 'medium' | 'high' | 'critical';
export type IncidentOutcome = 'recovered' | 'partial' | 'failed';

export type ActionType =
  | 'notify_customer'
  | 'reassign_technician'
  | 'reoptimize_route'
  | 'reschedule_downstream'
  | 'reserve_parts'
  | 'activate_contractor_network'
  | 'offer_customer_options';

export type ActionStatus = 'pending' | 'success' | 'skipped' | 'failed';

export interface SelfHealingIncident {
  id: string;
  user_id: string;
  signal_id: string;
  job_id: string | null;
  incident_type: IncidentType;
  stage: IncidentStage;
  risk_score: number | null;
  risk_tier: RiskTier | null;
  predicted_impact: Record<string, unknown>;
  decision: { chosen_actions?: ActionType[]; reasoning?: string } & Record<string, unknown>;
  outcome: IncidentOutcome | null;
  outcome_note: string | null;
  verified_at: string | null;
  detected_at: string;
  acted_at: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface SelfHealingAction {
  id: string;
  incident_id: string;
  user_id: string;
  action_type: ActionType;
  status: ActionStatus;
  detail: Record<string, unknown>;
  executed_at: string;
  created_at: string;
}

export const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  technician_delayed: 'Technician Delay',
  eta_missed: 'Missed ETA',
};

export const RISK_TIER_LABELS: Record<RiskTier, string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
  critical: 'Critical risk',
};

export const RISK_TIER_COLORS: Record<RiskTier, string> = {
  low: 'bg-success-500/10 text-success-500',
  medium: 'bg-warning-500/10 text-warning-500',
  high: 'bg-danger/10 text-danger',
  critical: 'bg-danger/20 text-danger',
};

export const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  notify_customer: 'Notified customer',
  reassign_technician: 'Reassigned technician',
  reoptimize_route: 'Re-optimized route',
  reschedule_downstream: 'Rescheduled later jobs',
  reserve_parts: 'Reserved parts',
  activate_contractor_network: 'Activated contractor network',
  offer_customer_options: 'Offered self-serve options',
};

export const STAGE_LABELS: Record<IncidentStage, string> = {
  detecting: 'Detecting',
  acting: 'Acting',
  awaiting_verification: 'Verifying',
  resolved: 'Resolved',
};

export const OUTCOME_LABELS: Record<IncidentOutcome, string> = {
  recovered: 'Recovered',
  partial: 'Partially recovered',
  failed: 'Not recovered',
};

export const OUTCOME_COLORS: Record<IncidentOutcome, string> = {
  recovered: 'bg-success-500/10 text-success-500',
  partial: 'bg-warning-500/10 text-warning-500',
  failed: 'bg-danger/10 text-danger',
};

export async function fetchSelfHealingIncidents(): Promise<SelfHealingIncident[]> {
  const { data, error } = await supabase
    .from('self_healing_incidents')
    .select('*')
    .order('detected_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data as SelfHealingIncident[]) ?? [];
}

export async function fetchSelfHealingActions(incidentIds: string[]): Promise<SelfHealingAction[]> {
  if (incidentIds.length === 0) return [];
  const { data, error } = await supabase
    .from('self_healing_actions')
    .select('*')
    .in('incident_id', incidentIds)
    .order('executed_at', { ascending: true });
  if (error) throw error;
  return (data as SelfHealingAction[]) ?? [];
}

export function isActiveIncident(incident: SelfHealingIncident): boolean {
  return incident.stage !== 'resolved';
}

export function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
