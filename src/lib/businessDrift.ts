import { supabase } from '@/lib/supabase';

export interface DriftMetric {
  metric: string;
  recent: number;
  baseline: number;
  pct_change: number;
  unit: string;
  flagged: boolean;
  sample_ok: boolean;
}

export interface DriftInsight {
  metric: string;
  severity: 'info' | 'warning' | 'critical';
  headline: string;
  message: string;
  recommended_action: string;
}

export interface BusinessDriftSnapshot {
  id: string;
  period_start: string;
  period_end: string;
  baseline_start: string;
  baseline_end: string;
  metrics: Record<string, DriftMetric>;
  flagged_count: number;
  drift_score: number;
  insights: DriftInsight[];
  created_at: string;
}

export const METRIC_LABELS: Record<string, string> = {
  discount_rate: 'Discounting',
  job_duration: 'Job duration',
  overtime_load: 'Overtime load',
  evidence_quality: 'Photo/note quality',
  callback_rate: 'Callback rate',
  low_margin_mix: 'Low-margin customer mix',
  dispatcher_overrides: 'Manual dispatch overrides',
};

export async function runBusinessDriftScan(): Promise<BusinessDriftSnapshot> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('business-drift-scan', {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) throw error;
  if (!data?.snapshot) throw new Error('No snapshot returned');
  return data.snapshot as BusinessDriftSnapshot;
}

export async function fetchBusinessDriftHistory(limit = 12): Promise<BusinessDriftSnapshot[]> {
  const { data, error } = await supabase
    .from('business_drift_snapshots')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as BusinessDriftSnapshot[];
}
