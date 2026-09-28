import { supabase } from '@/lib/supabase';

/**
 * Home Health Score + Autonomous Home Maintenance Agent — client data layer.
 * All scoring/prediction happens server-side in the home-health-agent edge
 * function; this file only reads what it stored and triggers a run.
 */

export type HomeHealthStage =
  | 'detected' | 'explained' | 'awaiting_customer' | 'scheduled' | 'dispatched'
  | 'repaired' | 'verified' | 'declined' | 'dismissed' | 'expired';

export interface HomeHealthDriver {
  key: 'age' | 'service' | 'repairs' | 'data';
  label: string;
  impact: 'positive' | 'negative' | 'neutral';
  detail: string;
}

export interface HomeHealthEquipment {
  equipment_id: string;
  customer_id: string;
  label: string;
  friendly_type: string;
  health: number;
  risk: 'low' | 'medium' | 'high';
  action_type: 'maintenance' | 'replacement_planning' | null;
  window_min_months: number | null;
  window_max_months: number | null;
  confidence: number;
  age_years: number | null;
  lifespan_years: number;
  lifespan_used_pct: number | null;
  drivers: HomeHealthDriver[];
}

export interface HomeHealthScore {
  id: string;
  customer_id: string;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  confidence: number;
  equipment_count: number;
  at_risk_count: number;
  breakdown: HomeHealthEquipment[];
  computed_at: string;
}

export interface HomeHealthAction {
  id: string;
  customer_id: string;
  equipment_id: string;
  action_type: 'maintenance' | 'replacement_planning';
  stage: HomeHealthStage;
  urgency: 'medium' | 'high';
  health_score: number;
  window_min_months: number | null;
  window_max_months: number | null;
  confidence: number;
  explanation: string | null;
  quote_id: string | null;
  job_id: string | null;
  blocked_reason: string | null;
  detected_at: string;
  updated_at: string;
}

export interface HomeHealthRunResult {
  accounts: number;
  scored: number;
  detected: number;
  quoted: number;
  awaiting_approval: number;
  accepted: number;
  scheduled: number;
  dispatched: number;
  repaired: number;
  verified: number;
  declined: number;
  expired: number;
  blocked: number;
}

/** The seven visible pipeline steps, in order. */
export const PIPELINE_STEPS: { key: string; label: string; stages: HomeHealthStage[] }[] = [
  { key: 'detect', label: 'Detect', stages: ['detected'] },
  { key: 'explain', label: 'Explain', stages: ['explained'] },
  { key: 'quote', label: 'Quote', stages: ['awaiting_customer'] },
  { key: 'schedule', label: 'Schedule', stages: ['scheduled'] },
  { key: 'dispatch', label: 'Dispatch', stages: ['dispatched'] },
  { key: 'repair', label: 'Repair', stages: ['repaired'] },
  { key: 'verify', label: 'Verify', stages: ['verified'] },
];

/** Number of pipeline steps completed (0-7); -1 for terminal-negative stages. */
export function stageProgress(stage: HomeHealthStage): number {
  switch (stage) {
    case 'detected': return 1;
    case 'explained': return 2;
    case 'awaiting_customer': return 3;
    case 'scheduled': return 4;
    case 'dispatched': return 5;
    case 'repaired': return 6;
    case 'verified': return 7;
    default: return -1;
  }
}

export const GRADE_STYLES: Record<HomeHealthScore['grade'], string> = {
  A: 'bg-success-500/10 text-success-500',
  B: 'bg-success-500/10 text-success-500',
  C: 'bg-warning-500/10 text-warning-500',
  D: 'bg-warning-500/10 text-warning-500',
  F: 'bg-danger-500/10 text-danger-500',
};

export function windowLabel(min: number | null, max: number | null): string {
  if (min === null || max === null) return 'Timing unknown';
  return min === max ? `~${min} mo` : `${min}–${max} mo`;
}

export async function fetchHomeHealthScores(): Promise<HomeHealthScore[]> {
  const { data, error } = await supabase
    .from('home_health_scores')
    .select('*')
    .order('score', { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data as HomeHealthScore[]) ?? [];
}

export async function fetchHomeHealthScoreForCustomer(customerId: string): Promise<HomeHealthScore | null> {
  const { data, error } = await supabase
    .from('home_health_scores')
    .select('*')
    .eq('customer_id', customerId)
    .maybeSingle();
  if (error) throw error;
  return (data as HomeHealthScore | null) ?? null;
}

export async function fetchHomeHealthActions(customerId?: string): Promise<HomeHealthAction[]> {
  let q = supabase.from('home_health_actions').select('*').order('updated_at', { ascending: false }).limit(300);
  if (customerId) q = q.eq('customer_id', customerId);
  const { data, error } = await q;
  if (error) throw error;
  return (data as HomeHealthAction[]) ?? [];
}

export async function dismissHomeHealthAction(actionId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('dismiss_home_health_action', { p_action_id: actionId });
  if (error) throw error;
  return Boolean(data);
}

export async function runHomeHealthAgent(): Promise<HomeHealthRunResult> {
  const { data, error } = await supabase.functions.invoke('home-health-agent', { method: 'POST' });
  if (error) throw error;
  return data as HomeHealthRunResult;
}
