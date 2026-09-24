import { supabase } from '@/lib/supabase';

/**
 * Service Recovery & Complaint Prevention — dashboard client library.
 *
 * Rows are written only by the service-recovery-agent Edge Function's
 * service-role client (see supabase/functions/service-recovery-agent).
 * This module reads them and handles what a human does here: resolving,
 * escalating, or dismissing a signal.
 */

export type SignalType = 'eta_missed' | 'technician_delayed' | 'negative_sentiment' | 'customer_dispute';
export type SignalStatus = 'open' | 'playbook_enrolled' | 'escalated' | 'resolved' | 'ignored';

export interface ServiceRecoverySignal {
  id: string;
  user_id: string;
  signal_type: SignalType;
  source_table: 'jobs' | 'calls';
  source_id: string;
  job_id: string | null;
  call_id: string | null;
  lead_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  severity_score: number;
  detail: string | null;
  status: SignalStatus;
  detected_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

export const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  eta_missed: 'Missed ETA',
  technician_delayed: 'Technician Delay',
  negative_sentiment: 'Negative Sentiment',
  customer_dispute: 'Customer Dispute',
};

export async function fetchServiceRecoverySignals(): Promise<ServiceRecoverySignal[]> {
  const { data, error } = await supabase
    .from('service_recovery_signals')
    .select('*')
    .order('severity_score', { ascending: false })
    .order('detected_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data as ServiceRecoverySignal[]) ?? [];
}

export async function resolveSignal(id: string, note: string): Promise<void> {
  const { error } = await supabase
    .from('service_recovery_signals')
    .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolution_note: note || null })
    .eq('id', id);
  if (error) throw error;
}

export async function escalateSignal(id: string, note: string): Promise<void> {
  const { error } = await supabase
    .from('service_recovery_signals')
    .update({ status: 'escalated', resolution_note: note || null })
    .eq('id', id);
  if (error) throw error;
}

export async function ignoreSignal(id: string): Promise<void> {
  const { error } = await supabase
    .from('service_recovery_signals')
    .update({ status: 'ignored', resolved_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

/** Client-side only — never persisted. */
export function isHighSeverity(s: ServiceRecoverySignal): boolean {
  return s.status === 'open' && s.severity_score >= 75;
}
