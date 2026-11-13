// Recreated: verify against original intent
// src/lib/agentActionsApi.ts
//
// Browser client for the Agent Action Framework. Reads go through RLS (own-account rows only, explicit column
// list: `exec_payload` and `undo` are not granted to the browser). Every write is a SECURITY DEFINER RPC or the
// `agent-actions` edge function; the database / server decides who may do what. Nothing here is trusted for auth.

import { supabase } from '@/lib/supabase';
import type {
  ActionRow,
  AuditRow,
  Autonomy,
  GrantRow,
  LimitKind,
  LimitRow,
  ModuleState,
  ToolMeta,
  ToolPolicyRow,
} from '@/lib/agentActions';

const REQUEST_COLUMNS =
  'id,user_id,agent_id,tool_slug,status,autonomy,reason,input_hash,preview,model,prompt_version,sources,decision_code,decision_detail,expires_at,executed_at,undo_until,error,created_at,updated_at';
const LIMIT_COLUMNS = 'id,kind,agent_id,tool_slug,window_sec,max_value,on_exceed,tw_days,tw_start_min,tw_end_min,tw_tz';
const REQUEST_LIMIT = 100;
const AUDIT_LIMIT = 200;

function fail(error: { code?: string; message?: string }, fallback: string): never {
  if (error.code === '42501') throw new Error('You do not have permission to do that.');
  throw new Error(fallback);
}

async function functionError(error: unknown): Promise<Error> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: { message?: string } | string; message?: string };
      const msg = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message;
      if (msg) return new Error(msg);
    } catch {
      /* body was not JSON */
    }
  }
  return new Error('Could not reach agent actions. Check your connection and try again.');
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('agent-actions', { body });
  if (error) throw await functionError(error);
  return data as T;
}

export async function fetchModuleState(): Promise<ModuleState> {
  const { data, error } = await supabase.rpc('get_my_agent_action_state');
  if (error) fail(error, 'Could not load agent action settings.');
  const s = (data ?? {}) as Partial<ModuleState>;
  return { enabled: s.enabled === true, paused: s.paused === true, canManage: s.canManage === true };
}

export async function fetchRequests(ownerId: string): Promise<ActionRow[]> {
  const { data, error } = await supabase
    .from('agent_action_requests')
    .select(REQUEST_COLUMNS)
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(REQUEST_LIMIT);
  if (error) fail(error, 'Could not load requests.');
  return (data ?? []) as unknown as ActionRow[];
}

export async function fetchAudit(ownerId: string): Promise<AuditRow[]> {
  const { data, error } = await supabase
    .from('agent_action_audit')
    .select('seq,request_id,event,actor,snapshot,created_at')
    .eq('user_id', ownerId)
    .order('seq', { ascending: false })
    .limit(AUDIT_LIMIT);
  if (error) fail(error, 'Could not load the audit log.');
  return (data ?? []) as unknown as AuditRow[];
}

export async function fetchPolicy(ownerId: string): Promise<{ grants: GrantRow[]; tools: ToolPolicyRow[]; limits: LimitRow[] }> {
  const [g, t, l] = await Promise.all([
    supabase.from('agent_scope_grants').select('agent_id,scope,autonomy').eq('user_id', ownerId).order('agent_id').order('scope'),
    supabase.from('agent_action_tool_policy').select('tool_slug,enabled,autonomy').eq('user_id', ownerId),
    supabase.from('agent_action_limits').select(LIMIT_COLUMNS).eq('user_id', ownerId).order('created_at', { ascending: false }),
  ]);
  if (g.error) fail(g.error, 'Could not load permissions.');
  if (t.error) fail(t.error, 'Could not load tool settings.');
  if (l.error) fail(l.error, 'Could not load limits.');
  return {
    grants: (g.data ?? []) as unknown as GrantRow[],
    tools: (t.data ?? []) as unknown as ToolPolicyRow[],
    limits: (l.data ?? []) as unknown as LimitRow[],
  };
}

export async function listTools(): Promise<ToolMeta[]> {
  const res = await call<{ tools?: ToolMeta[] }>({ action: 'tools' });
  return Array.isArray(res.tools) ? res.tools : [];
}

export interface ApproveOutcome {
  outcome: string;
  code?: string | null;
  reasons?: string[];
  status?: string | null;
  requestId?: string | null;
}

/** `expectedInputHash` is the hash the person saw; the server refuses if the stored input changed since. */
export const approveAction = (requestId: string, expectedInputHash: string) =>
  call<ApproveOutcome>({ action: 'approve', requestId, expectedInputHash });
export const rejectAction = (requestId: string, reason?: string) => call<{ outcome: string; requestId: string }>({ action: 'reject', requestId, reason });
export const undoAction = (requestId: string) => call<{ outcome: string; requestId: string }>({ action: 'undo', requestId });

export async function verifyAudit(ownerId: string): Promise<{ ok: boolean; checked: number; reason: string | null }> {
  const { data, error } = await supabase.rpc('verify_agent_action_audit', { p_user_id: ownerId });
  if (error) fail(error, 'Could not verify the audit chain.');
  const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; checked?: number | string; reason?: string | null } | undefined;
  return { ok: row?.ok === true, checked: Number(row?.checked ?? 0), reason: row?.reason ?? null };
}

async function rpcVoid(fn: string, args: Record<string, unknown>, fallback: string): Promise<void> {
  const { error } = await supabase.rpc(fn, args);
  if (error) fail(error, fallback);
}

export const setPaused = (paused: boolean, reason?: string) =>
  rpcVoid('agent_action_set_paused', { p_paused: paused, p_reason: reason ?? null }, 'Could not change the pause setting.');
export const setToolPolicy = (toolSlug: string, enabled: boolean, autonomy: Autonomy | null) =>
  rpcVoid('agent_action_set_tool_policy', { p_tool: toolSlug, p_enabled: enabled, p_autonomy: autonomy }, 'Could not save the tool policy.');
export const setGrant = (agentId: string, scope: string, autonomy: Autonomy) =>
  rpcVoid('agent_action_set_grant', { p_agent: agentId, p_scope: scope, p_autonomy: autonomy }, 'Could not save the grant.');
export const deleteGrant = (agentId: string, scope: string) =>
  rpcVoid('agent_action_delete_grant', { p_agent: agentId, p_scope: scope }, 'Could not remove the grant.');
export const deleteLimit = (id: string) => rpcVoid('agent_action_delete_limit', { p_id: id }, 'Could not remove the limit.');

export interface LimitInput {
  id?: string | null;
  kind: LimitKind;
  agentId: string;
  toolSlug: string;
  onExceed: 'block' | 'approval';
  windowSec: number | null;
  max: number | null;
  days: number[] | null;
  startMin: number | null;
  endMin: number | null;
  tz: string | null;
}

export async function upsertLimit(i: LimitInput): Promise<string> {
  const { data, error } = await supabase.rpc('agent_action_upsert_limit', {
    p_id: i.id ?? null,
    p_kind: i.kind,
    p_agent_id: i.agentId,
    p_tool_slug: i.toolSlug,
    p_window_sec: i.windowSec,
    p_max: i.max,
    p_on_exceed: i.onExceed,
    p_days: i.days,
    p_start_min: i.startMin,
    p_end_min: i.endMin,
    p_tz: i.tz,
  });
  if (error) {
    if (error.code === '22023') throw new Error('Unknown time zone.');
    if (error.code === '54000') throw new Error('Too many limits.');
    fail(error, 'Could not save the limit.');
  }
  return String(data);
}
