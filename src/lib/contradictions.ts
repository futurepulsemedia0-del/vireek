import { supabase } from '@/lib/supabase';

export type ContradictionType =
  | 'growth_vs_capacity'
  | 'discount_not_the_reason'
  | 'marketing_vs_followup'
  | 'branch_revenue_vs_margin_churn'
  | 'technician_revenue_vs_quality';

export interface Contradiction {
  id: string;
  contradiction_type: ContradictionType;
  severity: 'low' | 'medium' | 'high';
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  status: 'open' | 'acknowledged' | 'dismissed' | 'resolved';
  detected_at: string;
}

export const TYPE_LABELS: Record<ContradictionType, string> = {
  growth_vs_capacity: 'Growth vs. Capacity',
  discount_not_the_reason: 'Discounting vs. Loss Reason',
  marketing_vs_followup: 'Marketing vs. Follow-up',
  branch_revenue_vs_margin_churn: 'Branch Revenue vs. Margin & Churn',
  technician_revenue_vs_quality: 'Technician Revenue vs. Quality',
};

export async function runDetection(userId: string): Promise<number> {
  const { data, error } = await supabase.rpc('run_contradiction_detection', { p_user_id: userId });
  if (error) throw error;
  return data ?? 0;
}

export async function fetchContradictions(status: Contradiction['status'] = 'open'): Promise<Contradiction[]> {
  const { data, error } = await supabase
    .from('business_contradictions')
    .select('*')
    .eq('status', status)
    .order('severity', { ascending: false })
    .order('detected_at', { ascending: false });
  if (error) throw error;
  return (data as Contradiction[]) ?? [];
}

export async function updateContradictionStatus(id: string, status: 'acknowledged' | 'dismissed'): Promise<void> {
  const { error } = await supabase.from('business_contradictions').update({ status }).eq('id', id);
  if (error) throw error;
}
