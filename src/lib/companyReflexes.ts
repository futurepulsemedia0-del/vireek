import { supabase } from '@/lib/supabase';

export type ReflexTriggerEvent = 'eta_delay' | 'manual';
export type ConditionOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'is_true' | 'is_false';
export type ReflexActionType = 'notify_customer_sms' | 'alert_human_call' | 'offer_credit' | 'request_redispatch' | 'custom_note';
export type QueueStatus = 'pending' | 'sent' | 'acknowledged' | 'dismissed';

export interface Reflex {
  id: string;
  name: string;
  description: string | null;
  trigger_event: ReflexTriggerEvent;
  is_active: boolean;
  created_at: string;
}

export interface ReflexStepInput {
  condition_field: string | null;
  condition_operator: ConditionOperator;
  condition_value: string | null;
  action_type: ReflexActionType;
  action_params?: Record<string, unknown>;
}

export interface ReflexStep extends ReflexStepInput {
  id: string;
  reflex_id: string;
  step_order: number;
}

export interface ReflexExecution {
  id: string;
  reflex_id: string;
  trigger_event: string;
  context: Record<string, unknown>;
  entity_type: string | null;
  entity_id: string | null;
  entity_label: string | null;
  steps_fired: Array<{ step_id: string; action_type: ReflexActionType; condition_field: string | null; condition_operator: ConditionOperator; condition_value: string | null }>;
  triggered_at: string;
  feedback: 'good' | 'bad' | null;
  feedback_note: string | null;
}

export interface QueueItem {
  id: string;
  execution_id: string;
  reflex_id: string;
  action_type: ReflexActionType;
  action_params: Record<string, unknown>;
  entity_type: string | null;
  entity_id: string | null;
  entity_label: string | null;
  status: QueueStatus;
  created_at: string;
}

export interface ReflexStats {
  reflex_id: string;
  name: string;
  is_active: boolean;
  fire_count: number;
  good_count: number;
  bad_count: number;
  pending_actions: number;
  last_fired_at: string | null;
}

export const TRIGGER_EVENT_LABELS: Record<ReflexTriggerEvent, string> = {
  eta_delay: 'ETA delay on a job',
  manual: 'Triggered manually / by another system',
};

export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  eq: 'equals',
  neq: 'does not equal',
  is_true: 'is true',
  is_false: 'is false',
};

export const ACTION_LABELS: Record<ReflexActionType, string> = {
  notify_customer_sms: 'Notify the customer (SMS)',
  alert_human_call: 'Flag for a human phone call',
  offer_credit: 'Offer a credit',
  request_redispatch: 'Request re-dispatch',
  custom_note: 'Log a custom note',
};

export const ETA_DELAY_FIELDS = ['delay_minutes', 'is_vip', 'technician_stuck'];

export async function fetchReflexes(): Promise<Reflex[]> {
  const { data, error } = await supabase.from('company_reflexes').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return (data as Reflex[]) ?? [];
}

export async function fetchReflexSteps(reflexId: string): Promise<ReflexStep[]> {
  const { data, error } = await supabase.from('reflex_steps').select('*').eq('reflex_id', reflexId).order('step_order', { ascending: true });
  if (error) throw error;
  return (data as ReflexStep[]) ?? [];
}

export async function createReflex(name: string, triggerEvent: ReflexTriggerEvent, description: string, steps: ReflexStepInput[]): Promise<string> {
  const { data, error } = await supabase.rpc('create_reflex', {
    p_name: name,
    p_trigger_event: triggerEvent,
    p_description: description || null,
    p_steps: steps,
  });
  if (error) throw error;
  return data as string;
}

export async function setReflexActive(id: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_reflex_active', { p_id: id, p_is_active: isActive });
  if (error) throw error;
}

export async function fetchReflexStats(userId: string): Promise<ReflexStats[]> {
  const { data, error } = await supabase.rpc('get_reflex_stats', { p_user_id: userId });
  if (error) throw error;
  return (data as ReflexStats[]) ?? [];
}

export async function fetchRecentExecutions(limit = 30): Promise<ReflexExecution[]> {
  const { data, error } = await supabase.from('reflex_executions').select('*').order('triggered_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data as ReflexExecution[]) ?? [];
}

export async function giveFeedback(executionId: string, feedback: 'good' | 'bad', note?: string): Promise<void> {
  const { error } = await supabase.rpc('give_reflex_feedback', { p_execution_id: executionId, p_feedback: feedback, p_note: note ?? null });
  if (error) throw error;
}

export async function fetchPendingActions(): Promise<QueueItem[]> {
  const { data, error } = await supabase.from('reflex_action_queue').select('*').eq('status', 'pending').order('created_at', { ascending: false });
  if (error) throw error;
  return (data as QueueItem[]) ?? [];
}

export async function resolveAction(id: string, status: 'sent' | 'acknowledged' | 'dismissed'): Promise<void> {
  const { error } = await supabase.rpc('resolve_reflex_action', { p_id: id, p_status: status });
  if (error) throw error;
}
