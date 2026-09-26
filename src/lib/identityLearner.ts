import { supabase } from '@/lib/supabase';

export interface IdentityDimension {
  dimension_key: string;
  label: string;
  pole_negative_label: string;
  pole_positive_label: string;
  description: string;
  score: number; // -1..1
  sample_count: number;
  last_event_at: string | null;
}

export interface IdentityDecisionEvent {
  id: string;
  source: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_label: string | null;
  dimension_signals: Record<string, number>;
  confidence: number;
  note: string | null;
  occurred_at: string;
}

export interface IdentitySnapshot {
  id: string;
  snapshot_at: string;
  vector: Record<string, number>;
  event_count_since_last: number;
  trigger: 'scheduled' | 'manual' | 'drift_detected';
}

export type DriftSeverity = 'notable' | 'significant' | 'major';

export interface IdentityDriftEvent {
  id: string;
  dimension_key: string;
  baseline_score: number;
  current_score: number;
  magnitude: number;
  baseline_snapshot_at: string;
  severity: DriftSeverity;
  narrative: string;
  acknowledged: boolean;
  detected_at: string;
}

export const DECISION_TEMPLATES: {
  key: string;
  label: string;
  source: string;
  signals: Record<string, number>;
  confidence: number;
}[] = [
  { key: 'declined_risky_job', label: 'Declined a risky/uncertain job', source: 'job_decline', signals: { risk_vs_safety: -0.6 }, confidence: 0.8 },
  { key: 'accepted_risky_job', label: 'Accepted a risky/uncertain job', source: 'job_accept', signals: { risk_vs_safety: 0.6 }, confidence: 0.8 },
  { key: 'discount_over_policy', label: 'Approved a discount above normal policy', source: 'discount_decision', signals: { discount_generosity: 0.7, price_vs_relationship: -0.4 }, confidence: 0.8 },
  { key: 'held_firm_on_price', label: 'Held firm on price instead of discounting', source: 'discount_decision', signals: { discount_generosity: -0.6, price_vs_relationship: 0.3 }, confidence: 0.7 },
  { key: 'hired_ahead_of_demand', label: 'Hired/expanded ahead of confirmed demand', source: 'hiring_decision', signals: { growth_vs_stability: 0.6, risk_vs_safety: 0.3 }, confidence: 0.7 },
  { key: 'delayed_hiring', label: 'Delayed hiring to stay lean', source: 'hiring_decision', signals: { growth_vs_stability: -0.5 }, confidence: 0.6 },
  { key: 'rushed_job_for_speed', label: 'Prioritized turnaround speed over thoroughness', source: 'job_execution', signals: { speed_vs_quality: 0.6 }, confidence: 0.6 },
  { key: 'slowed_for_quality', label: 'Slowed down / redid work to protect quality', source: 'job_execution', signals: { speed_vs_quality: -0.6 }, confidence: 0.6 },
  { key: 'let_automation_decide', label: 'Let AI/automation decide without review', source: 'automation_decision', signals: { autonomy_vs_control: 0.6 }, confidence: 0.6 },
  { key: 'overrode_automation', label: 'Overrode an AI/automated recommendation', source: 'automation_decision', signals: { autonomy_vs_control: -0.6 }, confidence: 0.6 },
];

export async function fetchIdentityProfile(): Promise<IdentityDimension[]> {
  const { data, error } = await supabase.rpc('get_business_identity_profile');
  if (error) throw error;
  return (data as IdentityDimension[]) ?? [];
}

export async function fetchRecentDecisionEvents(limit = 20): Promise<IdentityDecisionEvent[]> {
  const { data, error } = await supabase
    .from('identity_decision_events')
    .select('id, source, entity_type, entity_id, entity_label, dimension_signals, confidence, note, occurred_at')
    .order('occurred_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as IdentityDecisionEvent[]) ?? [];
}

export async function fetchIdentitySnapshots(limit = 60): Promise<IdentitySnapshot[]> {
  const { data, error } = await supabase
    .from('business_identity_snapshots')
    .select('id, snapshot_at, vector, event_count_since_last, trigger')
    .order('snapshot_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data as IdentitySnapshot[]) ?? [];
}

export async function fetchDriftEvents(): Promise<IdentityDriftEvent[]> {
  const { data, error } = await supabase
    .from('business_identity_drift_events')
    .select('*')
    .order('detected_at', { ascending: false })
    .limit(25);
  if (error) throw error;
  return (data as IdentityDriftEvent[]) ?? [];
}

export async function acknowledgeDrift(id: string): Promise<void> {
  const { error } = await supabase.rpc('acknowledge_identity_drift', { p_drift_id: id });
  if (error) throw error;
}

export async function recomputeIdentitySnapshot(force = false): Promise<{ drift_detected_count: number }> {
  const { data, error } = await supabase.rpc('recompute_business_identity_snapshot', { p_force: force });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { drift_detected_count: row?.drift_detected_count ?? 0 };
}

export async function logIdentityDecision(
  source: string,
  dimensionSignals: Record<string, number>,
  confidence = 1,
  options?: { entityType?: string; entityId?: string; entityLabel?: string; context?: Record<string, unknown>; note?: string }
): Promise<string> {
  const { data, error } = await supabase.rpc('log_identity_decision', {
    p_source: source,
    p_dimension_signals: dimensionSignals,
    p_confidence: confidence,
    p_entity_type: options?.entityType ?? null,
    p_entity_id: options?.entityId ?? null,
    p_entity_label: options?.entityLabel ?? null,
    p_context: options?.context ?? {},
    p_note: options?.note ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function logFromTemplate(templateKey: string, note?: string): Promise<void> {
  const template = DECISION_TEMPLATES.find((t) => t.key === templateKey);
  if (!template) throw new Error('Unknown decision template');
  await logIdentityDecision(template.source, template.signals, template.confidence, { note });
}

export const SEVERITY_LABELS: Record<DriftSeverity, string> = {
  notable: 'Notable shift',
  significant: 'Significant shift',
  major: 'Major shift',
};
