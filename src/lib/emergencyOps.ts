import { supabase } from '@/lib/supabase';

export interface EmergencyStatus {
  emergency_ops_enabled: boolean;
  emergency_mode_active: boolean;
  emergency_mode_source: 'manual' | 'weather' | null;
  emergency_mode_headline: string | null;
  emergency_mode_activated_at: string | null;
}

export interface TriageItem {
  id: string;
  job_id: string | null;
  customer_name: string;
  phone: string | null;
  priority_tier: 'critical' | 'high' | 'standard';
  priority_score: number;
  reason: string | null;
  status: 'pending' | 'dispatched' | 'resolved' | 'dismissed';
  source: 'auto' | 'manual';
  created_at: string;
}

export interface BroadcastLogItem {
  id: string;
  message: string;
  audience: 'customers' | 'team' | 'on_call';
  recipients_targeted: number;
  recipients_sent: number;
  created_at: string;
}

export async function fetchEmergencyStatus(userId: string): Promise<EmergencyStatus | null> {
  const { data, error } = await supabase
    .from('business_profile')
    .select('emergency_ops_enabled, emergency_mode_active, emergency_mode_source, emergency_mode_headline, emergency_mode_activated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as EmergencyStatus | null) ?? null;
}

export async function toggleEmergencyOpsEnabled(userId: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from('business_profile').update({ emergency_ops_enabled: enabled }).eq('user_id', userId);
  if (error) throw error;
}

export async function activateEmergencyMode(headline: string): Promise<{ activated: boolean; triage_count?: number; on_call_notified?: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke('emergency-mode-activate', { body: { action: 'activate', headline } });
  if (error) return { activated: false, error: error.message };
  return data;
}

export async function deactivateEmergencyMode(): Promise<void> {
  const { error } = await supabase.functions.invoke('emergency-mode-activate', { body: { action: 'deactivate' } });
  if (error) throw error;
}

export async function fetchTriageQueue(): Promise<TriageItem[]> {
  const { data, error } = await supabase
    .from('emergency_triage_queue')
    .select('*')
    .eq('status', 'pending')
    .order('priority_score', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data as TriageItem[]) ?? [];
}

export async function updateTriageStatus(id: string, status: TriageItem['status']): Promise<void> {
  const { error } = await supabase
    .from('emergency_triage_queue')
    .update({ status, resolved_at: status === 'resolved' || status === 'dismissed' ? new Date().toISOString() : null })
    .eq('id', id);
  if (error) throw error;
}

export async function sendEmergencyBroadcast(message: string, audience: 'customers' | 'team' | 'on_call'): Promise<{ targeted: number; sent: number }> {
  const { data, error } = await supabase.functions.invoke('emergency-ops-broadcast', { body: { message, audience } });
  if (error) throw error;
  return data;
}

export async function fetchBroadcastHistory(limit = 10): Promise<BroadcastLogItem[]> {
  const { data, error } = await supabase
    .from('emergency_broadcasts')
    .select('id, message, audience, recipients_targeted, recipients_sent, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as BroadcastLogItem[]) ?? [];
}
