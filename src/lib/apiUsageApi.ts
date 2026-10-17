/**
 * API Usage monitoring — API layer. Everything is scoped by the account owner id (RLS and the RPC guard enforce it again).
 */

import { supabase } from '@/lib/supabase';
import {
  toBreach,
  toEvent,
  toPoint,
  toRules,
  toSummaryRow,
  type AlertEvent,
  type AlertRules,
  type Breach,
  type UsagePoint,
  type UsageSummaryRow,
} from '@/lib/apiUsage';

export interface UsageKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  revoked_at: string | null;
}

export async function fetchUsageKeys(ownerId: string): Promise<UsageKey[]> {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, key_prefix, created_at, revoked_at')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as UsageKey[];
}

export async function fetchUsageSummary(ownerId: string, hours: number): Promise<UsageSummaryRow[]> {
  const { data, error } = await supabase.rpc('get_api_usage_summary', { p_owner: ownerId, p_hours: hours });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(toSummaryRow);
}

export async function fetchUsageSeries(ownerId: string, hours: number, keyId: string | null): Promise<UsagePoint[]> {
  const { data, error } = await supabase.rpc('get_api_usage_timeseries', { p_owner: ownerId, p_hours: hours, p_key_id: keyId });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(toPoint);
}

export async function fetchBreaches(ownerId: string): Promise<Breach[]> {
  const { data, error } = await supabase.rpc('api_usage_breaches', { p_owner: ownerId });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(toBreach);
}

export async function fetchAlertEvents(ownerId: string, limit = 10): Promise<AlertEvent[]> {
  const { data, error } = await supabase
    .from('api_usage_alert_events')
    .select('id, key_id, kind, value, threshold, window_minutes, created_at')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(toEvent);
}

export async function fetchAlertRules(ownerId: string): Promise<AlertRules> {
  const { data, error } = await supabase.from('api_usage_alert_rules').select('*').eq('user_id', ownerId).maybeSingle();
  if (error) throw error;
  return toRules((data as Record<string, unknown> | null) ?? null);
}

export async function saveAlertRules(ownerId: string, rules: AlertRules): Promise<AlertRules> {
  const { data, error } = await supabase
    .from('api_usage_alert_rules')
    .upsert({ user_id: ownerId, ...rules }, { onConflict: 'user_id' })
    .select('*')
    .single();
  if (error) throw error;
  return toRules(data as Record<string, unknown>);
}
