import { supabase } from '@/lib/supabase';

export interface Commitment {
  id: string;
  source_type: 'call' | 'sms' | 'quote' | 'job_note' | 'manual';
  owner_type: string;
  owner_team_member_id: string | null;
  owner_name: string | null;
  customer_name: string | null;
  job_id: string | null;
  commitment_text: string;
  deadline_text: string | null;
  deadline_at: string | null;
  status: 'open' | 'kept' | 'broken' | 'unclear';
  confidence: 'low' | 'medium' | 'high';
  detected_at: string;
}

export interface TrustScore {
  owner_team_member_id: string | null;
  owner_name: string;
  total_resolved: number;
  kept_count: number;
  broken_count: number;
  trust_pct: number | null;
  open_overdue: number;
}

export async function fetchCommitments(status?: Commitment['status']): Promise<Commitment[]> {
  let query = supabase.from('commitments').select('*').order('deadline_at', { ascending: true, nullsFirst: false }).limit(100);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return (data as Commitment[]) ?? [];
}

export async function fetchOverdueCommitments(): Promise<Commitment[]> {
  const { data, error } = await supabase
    .from('commitments')
    .select('*')
    .eq('status', 'open')
    .not('deadline_at', 'is', null)
    .lt('deadline_at', new Date().toISOString())
    .order('deadline_at', { ascending: true });
  if (error) throw error;
  return (data as Commitment[]) ?? [];
}

export async function resolveCommitment(id: string, status: 'kept' | 'broken' | 'unclear', note?: string): Promise<void> {
  const { error } = await supabase.rpc('resolve_commitment', { p_id: id, p_status: status, p_note: note ?? null });
  if (error) throw error;
}

export async function createManualCommitment(text: string, ownerTeamMemberId: string, customerName: string, jobId?: string, deadlineAt?: string): Promise<void> {
  const { error } = await supabase.rpc('create_manual_commitment', {
    p_commitment_text: text, p_owner_team_member_id: ownerTeamMemberId, p_customer_name: customerName,
    p_job_id: jobId ?? null, p_deadline_at: deadlineAt ?? null,
  });
  if (error) throw error;
}

export async function fetchTrustScores(userId: string): Promise<TrustScore[]> {
  const { data, error } = await supabase.rpc('get_commitment_trust_scores', { p_user_id: userId });
  if (error) throw error;
  return data ?? [];
}
