/** AI agent callers - data access. Reads are RLS-scoped (get_account_owner_id()); writes go through RPCs. */
import { supabase } from '@/lib/supabase';
import {
  normalizeAgentCallerSettings,
  settingsToPayload,
  type AgentCallerSettings,
  type AgentCallRow,
  type AgentHold,
  type AgentQuotableItem,
  type FunnelEvent,
} from '@/lib/agentCallers';

const DAYS_30 = 30 * 86_400_000;
const since = () => new Date(Date.now() - DAYS_30).toISOString();

export async function fetchSettings(ownerId: string): Promise<AgentCallerSettings> {
  const { data, error } = await supabase.from('agent_caller_settings').select('*').eq('user_id', ownerId).maybeSingle();
  if (error) throw new Error(error.message);
  return normalizeAgentCallerSettings(data as Record<string, unknown> | null);
}

export async function saveSettings(s: AgentCallerSettings): Promise<AgentCallerSettings> {
  const { data, error } = await supabase.rpc('update_agent_caller_settings', { p: settingsToPayload(s) });
  if (error) throw new Error(error.message);
  return normalizeAgentCallerSettings(data as Record<string, unknown> | null);
}

export async function fetchHolds(ownerId: string): Promise<AgentHold[]> {
  const { data, error } = await supabase
    .from('agent_holds')
    .select('id, code, status, mode, service, zip, window_start, expires_at, platform_claimed, call_id')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data as unknown as AgentHold[]) ?? [];
}

export async function decideHold(holdId: string, approve: boolean): Promise<string> {
  const { data, error } = await supabase.rpc('agent_hold_decide', { p_hold_id: holdId, p_approve: approve });
  if (error) throw new Error(error.message);
  return ((data as { status?: string } | null)?.status) ?? 'unknown';
}

/** Calls of the last 30 days (all kinds, so the human win rate uses the same window). */
export async function fetchCalls30d(ownerId: string): Promise<AgentCallRow[]> {
  const { data, error } = await supabase
    .from('calls')
    .select('id, call_datetime, caller_kind, caller_kind_confidence, agent_platform_claimed, status, booking_outcome')
    .eq('user_id', ownerId)
    .gte('call_datetime', since())
    .order('call_datetime', { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);
  return (data as unknown as AgentCallRow[]) ?? [];
}

/** Funnel events joined to calls through the session's call_id. */
export async function fetchFunnelEvents(ownerId: string): Promise<FunnelEvent[]> {
  const { data: sessions, error: sErr } = await supabase
    .from('agent_caller_sessions').select('id, call_id').eq('user_id', ownerId).gte('created_at', since()).not('call_id', 'is', null).limit(2000);
  if (sErr) throw new Error(sErr.message);
  const sessionRows = (sessions ?? []) as unknown as { id: string; call_id: string }[];
  const byId = new Map<string, string>(sessionRows.map((s) => [s.id, s.call_id]));
  if (byId.size === 0) return [];
  const { data, error } = await supabase
    .from('agent_caller_events').select('session_id, event_type').eq('user_id', ownerId).gte('created_at', since()).limit(10000);
  if (error) throw new Error(error.message);
  const out: FunnelEvent[] = [];
  for (const e of (data ?? []) as unknown as { session_id: string; event_type: FunnelEvent['type'] }[]) {
    const callId = byId.get(e.session_id);
    if (callId) out.push({ callId, type: e.event_type });
  }
  return out;
}

export async function fetchQuotableItems(ownerId: string): Promise<AgentQuotableItem[]> {
  const { data, error } = await supabase
    .from('price_book_items').select('id, service_name, category, agent_quotable').eq('user_id', ownerId).eq('active', true).order('service_name');
  if (error) throw new Error(error.message);
  return (data as unknown as AgentQuotableItem[]) ?? [];
}

export async function setItemQuotable(itemId: string, quotable: boolean): Promise<void> {
  const { error } = await supabase.from('price_book_items').update({ agent_quotable: quotable }).eq('id', itemId);
  if (error) throw new Error(error.message);
}
