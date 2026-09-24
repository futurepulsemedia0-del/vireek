import { supabase } from '@/lib/supabase';

export type DecisionType = 'technician_dispatch' | 'quote_financing' | 'job_reschedule';

export interface Counterfactual {
  id: string;
  decision_type: DecisionType;
  source_id: string;
  question: string;
  actual_outcome: Record<string, unknown>;
  counterfactual_outcome: Record<string, unknown>;
  estimated_impact: Record<string, unknown>;
  confidence: 'low' | 'medium' | 'high';
  sample_size: number;
  created_at: string;
}

export interface PendingAssignment {
  id: string;
  job_id: string;
  technician_id: string;
  service_type: string | null;
  assigned_at: string;
}

export interface PendingScheduleChange {
  id: string;
  job_id: string;
  previous_scheduled_datetime: string;
  new_scheduled_datetime: string;
  changed_at: string;
}

export interface PendingQuote {
  id: string;
  customer_name: string;
  updated_at: string;
}

export async function fetchCounterfactuals(): Promise<Counterfactual[]> {
  const { data, error } = await supabase.from('business_counterfactuals').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return (data as Counterfactual[]) ?? [];
}

export async function fetchUnanalyzedAssignments(): Promise<PendingAssignment[]> {
  const { data: analyzed } = await supabase.from('business_counterfactuals').select('source_id').eq('decision_type', 'technician_dispatch');
  const analyzedIds = (analyzed ?? []).map((r) => r.source_id);
  let query = supabase.from('job_technician_assignments').select('id, job_id, technician_id, service_type, assigned_at').order('assigned_at', { ascending: false }).limit(20);
  if (analyzedIds.length > 0) query = query.not('id', 'in', `(${analyzedIds.join(',')})`);
  const { data, error } = await query;
  if (error) throw error;
  return (data as PendingAssignment[]) ?? [];
}

export async function fetchUnanalyzedScheduleChanges(): Promise<PendingScheduleChange[]> {
  const { data: analyzed } = await supabase.from('business_counterfactuals').select('source_id').eq('decision_type', 'job_reschedule');
  const analyzedIds = (analyzed ?? []).map((r) => r.source_id);
  let query = supabase.from('job_schedule_changes').select('id, job_id, previous_scheduled_datetime, new_scheduled_datetime, changed_at').order('changed_at', { ascending: false }).limit(20);
  if (analyzedIds.length > 0) query = query.not('id', 'in', `(${analyzedIds.join(',')})`);
  const { data, error } = await query;
  if (error) throw error;
  return (data as PendingScheduleChange[]) ?? [];
}

export async function fetchUnanalyzedDeclinedQuotes(): Promise<PendingQuote[]> {
  const { data: analyzed } = await supabase.from('business_counterfactuals').select('source_id').eq('decision_type', 'quote_financing');
  const analyzedIds = (analyzed ?? []).map((r) => r.source_id);
  let query = supabase.from('quotes').select('id, customer_name, updated_at').eq('status', 'declined').eq('financing_offered', false).order('updated_at', { ascending: false }).limit(20);
  if (analyzedIds.length > 0) query = query.not('id', 'in', `(${analyzedIds.join(',')})`);
  const { data, error } = await query;
  if (error) throw error;
  return (data as PendingQuote[]) ?? [];
}

export async function analyzeTechnicianDispatch(assignmentId: string): Promise<void> {
  const { error } = await supabase.rpc('generate_technician_dispatch_counterfactual', { p_assignment_id: assignmentId });
  if (error) throw error;
}

export async function analyzeQuoteFinancing(quoteId: string): Promise<void> {
  const { error } = await supabase.rpc('generate_quote_financing_counterfactual', { p_quote_id: quoteId });
  if (error) throw error;
}

export async function analyzeReschedule(scheduleChangeId: string): Promise<void> {
  const { error } = await supabase.rpc('generate_reschedule_counterfactual', { p_schedule_change_id: scheduleChangeId });
  if (error) throw error;
}
