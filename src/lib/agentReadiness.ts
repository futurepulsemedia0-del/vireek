import { supabase } from '@/lib/supabase';
import type { AlertRow, FixAction, History, PublicResult, ScanSummary } from '@/lib/agentReadinessCore';

// Thin data access for Agent Readiness: edge functions + RPCs. Types and pure helpers live in agentReadinessCore.
export * from '@/lib/agentReadinessCore';

async function errorCode(error: unknown): Promise<string> {
  try {
    const body = await (error as { context?: Response }).context?.json();
    if (body?.code) return String(body.code);
  } catch { /* fall through */ }
  return 'unknown';
}

export async function runScan(): Promise<{ ok: true; scanId: string } | { ok: false; code: string }> {
  const { data, error } = await supabase.functions.invoke('agent-readiness-scan', { body: {} });
  if (error) return { ok: false, code: await errorCode(error) };
  const d = data as { ok?: boolean; scan_id?: string; code?: string };
  return d?.ok && d.scan_id ? { ok: true, scanId: d.scan_id } : { ok: false, code: d?.code ?? 'unknown' };
}

export async function runPublicCheck(url: string, honeypot = ''): Promise<PublicResult | { ok: false; code: string }> {
  const { data, error } = await supabase.functions.invoke('agent-readiness-public', { body: { url, website_confirm: honeypot } });
  if (error) return { ok: false, code: await errorCode(error) };
  return data as PublicResult | { ok: false; code: string };
}

const SCAN_COLUMNS = 'id, created_at, source, score, coverage, subscores, checks, fixes, site';
export async function loadLatestScan(ownerId: string): Promise<ScanSummary | null> {
  const { data, error } = await supabase.from('agent_readiness_scans').select(SCAN_COLUMNS)
    .eq('user_id', ownerId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ScanSummary | null) ?? null;
}
export async function loadActions(ownerId: string, scanId: string): Promise<FixAction[]> {
  const { data, error } = await supabase.from('agent_readiness_fix_actions').select('id, scan_id, fix_key, status, changes')
    .eq('user_id', ownerId).eq('scan_id', scanId).order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as FixAction[];
}
export async function loadAlerts(ownerId: string): Promise<AlertRow[]> {
  const { data, error } = await supabase.from('agent_readiness_alerts').select('id, kind, detail, created_at, acknowledged_at')
    .eq('user_id', ownerId).is('acknowledged_at', null).order('created_at', { ascending: false }).limit(10);
  if (error) throw new Error(error.message);
  return (data ?? []) as AlertRow[];
}
export async function loadMonitoring(ownerId: string): Promise<boolean> {
  const { data, error } = await supabase.from('agent_readiness_settings').select('weekly_scan').eq('user_id', ownerId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { weekly_scan: boolean } | null)?.weekly_scan ?? true;
}
export async function loadHistory(): Promise<History> {
  const { data, error } = await supabase.rpc('agent_readiness_history');
  if (error || !data) throw new Error(error?.message ?? 'history_unavailable');
  return data as History;
}

type Rpc<T> = Promise<{ ok: true } & T | { ok: false; code: string }>;
async function rpc<T extends object>(fn: string, args: Record<string, unknown>): Rpc<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, code: error.message.includes('forbidden') ? 'forbidden' : error.message.includes('not_found') ? 'not_found' : 'unknown' };
  return data as { ok: true } & T;
}
export const applyDescriptions = (scanId: string, itemIds: string[]) =>
  rpc<{ applied: number; skipped: number; action_id: string | null }>('agent_readiness_apply_descriptions', { p_scan_id: scanId, p_item_ids: itemIds });
export const skipFix = (scanId: string, fixKey: string) => rpc<object>('agent_readiness_skip_fix', { p_scan_id: scanId, p_fix_key: fixKey });
export const undoAction = (actionId: string) => rpc<{ restored: number; conflicts: number }>('agent_readiness_undo_action', { p_action_id: actionId });
export const setMonitoring = (enabled: boolean) => rpc<{ weekly_scan: boolean }>('agent_readiness_set_monitoring', { p_enabled: enabled });
export const ackAlert = (id: string) => rpc<object>('agent_readiness_ack_alert', { p_id: id });
