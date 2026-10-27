/**
 * Call masking - data access. Every query is scoped by account_owner_id and protected by RLS / RPC checks
 * (see 20271210000000_call_masking_proxy_numbers.sql).
 */
import { supabase } from '@/lib/supabase';
import {
  maskingErrorMessage,
  type MySession,
  type ProxyCallEvent,
  type ProxyNumber,
  type ProxyNumberStats,
  type ProxySession,
  type TechnicianOption,
} from '@/lib/callMasking';

const NUMBER_COLS = 'id, e164, label, status, created_at';
const SESSION_COLS =
  'id, proxy_number_id, job_id, technician_id, customer_name, technician_name, customer_e164, technician_e164, status, expires_at, closed_at, close_reason, created_at';

interface PgError { code?: string; message: string }
const fail = (e: PgError) => new Error(maskingErrorMessage(e));

export async function fetchProxyNumbers(ownerId: string): Promise<ProxyNumber[]> {
  const { data, error } = await supabase.from('proxy_numbers').select(NUMBER_COLS).eq('account_owner_id', ownerId).order('created_at');
  if (error) throw fail(error);
  return (data as unknown as ProxyNumber[]) ?? [];
}

export async function fetchProxyNumberStats(ownerId: string): Promise<Record<string, ProxyNumberStats>> {
  const { data, error } = await supabase
    .from('proxy_number_stats').select('number_id, active_sessions, total_sessions, calls_30d').eq('account_owner_id', ownerId);
  if (error) throw fail(error);
  const map: Record<string, ProxyNumberStats> = {};
  for (const r of (data as unknown as ProxyNumberStats[]) ?? []) map[r.number_id] = r;
  return map;
}

export async function addProxyNumber(ownerId: string, e164: string, label?: string): Promise<ProxyNumber> {
  const { data, error } = await supabase
    .from('proxy_numbers').insert({ account_owner_id: ownerId, e164, label: label ?? null }).select(NUMBER_COLS).single();
  if (error) throw fail(error);
  return data as unknown as ProxyNumber;
}

export async function setProxyNumberStatus(id: string, status: 'active' | 'paused' | 'retired'): Promise<void> {
  const { error } = await supabase.from('proxy_numbers').update({ status }).eq('id', id);
  if (error) throw fail(error);
}

export async function fetchSessions(ownerId: string): Promise<ProxySession[]> {
  const { data, error } = await supabase
    .from('proxy_sessions').select(SESSION_COLS).eq('account_owner_id', ownerId).order('created_at', { ascending: false }).limit(200);
  if (error) throw fail(error);
  return (data as unknown as ProxySession[]) ?? [];
}

export async function fetchRecentEvents(ownerId: string): Promise<ProxyCallEvent[]> {
  const { data, error } = await supabase
    .from('proxy_call_events').select('id, session_id, direction, status, duration_seconds, created_at')
    .eq('account_owner_id', ownerId).order('created_at', { ascending: false }).limit(50);
  if (error) throw fail(error);
  return (data as unknown as ProxyCallEvent[]) ?? [];
}

export async function fetchTechnicians(ownerId: string): Promise<TechnicianOption[]> {
  const { data, error } = await supabase
    .from('team_members').select('id, member_name, member_email, member_phone').eq('account_owner_id', ownerId).order('member_name');
  if (error) throw fail(error);
  return (data as unknown as TechnicianOption[]) ?? [];
}

export async function setTechnicianPhone(technicianId: string, phone: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('proxy_set_technician_phone', { p_technician_id: technicianId, p_phone: phone });
  if (error) throw fail(error);
  return (data as string | null) ?? null;
}

export async function allocateSession(args: {
  technicianId: string; customerName: string; customerPhone: string; ttlHours: number; jobId?: string | null; customerId?: string | null;
}): Promise<ProxySession> {
  const { data, error } = await supabase.rpc('proxy_allocate_session', {
    p_job_id: args.jobId ?? null,
    p_technician_id: args.technicianId,
    p_customer_phone: args.customerPhone,
    p_customer_name: args.customerName,
    p_customer_id: args.customerId ?? null,
    p_ttl_hours: args.ttlHours,
  });
  if (error) throw fail(error);
  return data as unknown as ProxySession;
}

export async function closeSession(id: string): Promise<void> {
  const { error } = await supabase.rpc('proxy_close_session', { p_session_id: id, p_reason: 'manual' });
  if (error) throw fail(error);
}

export async function extendSession(id: string, hours: number): Promise<void> {
  const { error } = await supabase.rpc('proxy_extend_session', { p_session_id: id, p_extra_hours: hours });
  if (error) throw fail(error);
}

export async function fetchMySessions(): Promise<MySession[]> {
  const { data, error } = await supabase.rpc('proxy_my_sessions');
  if (error) throw fail(error);
  return (data as unknown as MySession[]) ?? [];
}

/** Rings the caller's own phone, then connects the customer (who sees the proxy number). */
export async function startBridgeCall(sessionId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('proxy-call-bridge', { body: { session_id: sessionId } });
  if (error) {
    let code = 'twilio_failed';
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) code = ((await ctx.json()) as { error?: string }).error ?? code;
    } catch { /* keep default */ }
    throw new Error(maskingErrorMessage({ message: code }));
  }
  if ((data as { error?: string } | null)?.error) throw new Error(maskingErrorMessage({ message: (data as { error: string }).error }));
}
