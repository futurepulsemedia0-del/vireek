import { supabase } from '@/lib/supabase';

export type OpportunityCostType = 'technician_low_margin_time' | 'quote_stalled_followup' | 'idle_capacity';
export type OpportunityCostStatus = 'open' | 'acknowledged' | 'dismissed';

export interface OpportunityCostEntry {
  id: string;
  entry_type: OpportunityCostType;
  source_table: string;
  source_id: string;
  occurred_on: string;
  estimated_cost_cents: number;
  detail: Record<string, unknown>;
  headline: string;
  ai_narrative: string | null;
  ai_recommended_action: string | null;
  priority_score: number | null;
  status: OpportunityCostStatus;
  created_at: string;
}

export interface OpportunityCostSummaryRow {
  entry_type: OpportunityCostType;
  entry_count: number;
  total_cost_cents: number;
}

export const ENTRY_TYPE_LABELS: Record<OpportunityCostType, string> = {
  technician_low_margin_time: 'Technician time on low-margin jobs',
  quote_stalled_followup: 'Quotes stalled without follow-up',
  idle_capacity: 'Idle capacity',
};

export async function fetchOpportunityCostEntries(status?: OpportunityCostStatus): Promise<OpportunityCostEntry[]> {
  let query = supabase.from('opportunity_cost_entries').select('*').order('priority_score', { ascending: false, nullsFirst: false }).order('estimated_cost_cents', { ascending: false }).limit(50);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as OpportunityCostEntry[];
}

export async function fetchOpportunityCostSummary(): Promise<OpportunityCostSummaryRow[]> {
  const { data, error } = await supabase.from('opportunity_cost_summary').select('*');
  if (error) throw error;
  return (data ?? []) as OpportunityCostSummaryRow[];
}

export async function runOpportunityCostScan(): Promise<{ inserted: number; ranked: number }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('opportunity-cost-scan', {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) throw error;
  return { inserted: data?.inserted ?? 0, ranked: data?.ranked ?? 0 };
}

export async function updateOpportunityCostStatus(id: string, status: OpportunityCostStatus): Promise<void> {
  const { error } = await supabase.from('opportunity_cost_entries').update({ status }).eq('id', id);
  if (error) throw error;
}
