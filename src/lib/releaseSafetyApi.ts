// Supabase access for the staff Release Safety console. Every RPC re-checks is_vireek_staff server-side;
// the messages raised by those RPCs are authored for humans, so they are passed through.
import { supabase } from '@/lib/supabase';
import type { AiVersion, ChangeRequest, FlagImpact, KillSwitch, Rollout } from '@/lib/releaseSafety';

interface DbError { message?: string; code?: string }

const PASS_THROUGH = new Set(['42501', 'P0001', 'P0002', '22023', '23505']);

function fail(error: DbError, fallback: string): never {
  if (error.code && PASS_THROUGH.has(error.code) && error.message) throw new Error(error.message);
  throw new Error(fallback);
}

async function call<T>(fn: string, args: Record<string, unknown> | undefined, fallback: string): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) fail(error, fallback);
  return data as T;
}

const rows = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export async function listKillSwitches(): Promise<KillSwitch[]> {
  const data = await call<unknown>('staff_list_kill_switches', undefined, 'Could not load kill switches.');
  return rows<KillSwitch>(data).map((k) => ({ ...k, org_stops: Number(k.org_stops) }));
}

export async function setKillSwitch(key: string, tenantId: string | null, stopped: boolean, reason: string): Promise<void> {
  await call<unknown>('staff_set_kill_switch', { p_key: key, p_tenant_id: tenantId, p_stopped: stopped, p_reason: reason }, 'Could not change the kill switch.');
}

export async function requestKillSwitchResume(key: string, reason: string): Promise<void> {
  await call<unknown>('staff_request_kill_switch_resume', { p_key: key, p_reason: reason }, 'Could not request the resume.');
}

export async function recordKillSwitchDrill(key: string): Promise<void> {
  await call<unknown>('staff_record_kill_switch_drill', { p_key: key }, 'Could not record the drill.');
}

export async function listChangeRequests(): Promise<ChangeRequest[]> {
  return rows<ChangeRequest>(await call<unknown>('staff_list_change_requests', undefined, 'Could not load approvals.'));
}

export type DecisionKind = ChangeRequest['kind'];
const DECIDE_FN: Record<DecisionKind, string> = {
  kill_switch_resume: 'staff_decide_kill_switch_resume',
  flag_change: 'staff_decide_flag_change',
  app_policy: 'staff_decide_app_policy',
};

/** Returns 'approved' | 'rejected' | 'expired'. */
export async function decideRequest(kind: DecisionKind, id: string, approve: boolean): Promise<string> {
  return call<string>(DECIDE_FN[kind], { p_request_id: id, p_approve: approve }, 'Could not record the decision.');
}

export async function requestFlagChange(flagKey: string, enabled: boolean, rolloutPct: number, reason: string): Promise<void> {
  await call<unknown>('staff_request_flag_change', { p_flag_key: flagKey, p_enabled: enabled, p_rollout_pct: rolloutPct, p_reason: reason }, 'Could not create the change request.');
}

export async function previewFlagImpact(flagKey: string, enabled: boolean, rolloutPct: number): Promise<FlagImpact> {
  const data = await call<unknown>('staff_flag_impact', { p_flag_key: flagKey, p_enabled: enabled, p_rollout_pct: rolloutPct }, 'Could not preview the impact.');
  const r = rows<FlagImpact>(data)[0];
  if (!r) throw new Error('Could not preview the impact.');
  return { current_tenants: Number(r.current_tenants), next_tenants: Number(r.next_tenants), newly_exposed: Number(r.newly_exposed), total_tenants: Number(r.total_tenants) };
}

export async function listRollouts(): Promise<Rollout[]> {
  return rows<Rollout>(await call<unknown>('staff_list_rollouts', undefined, 'Could not load rollouts.'));
}

export async function advanceRollout(flagKey: string, nextPct: number): Promise<{ status: string }> {
  return call<{ status: string }>('staff_advance_rollout', { p_flag_key: flagKey, p_next_pct: nextPct }, 'Could not advance the rollout.');
}

export async function rollbackRollout(flagKey: string, reason: string): Promise<void> {
  await call<unknown>('staff_rollback_rollout', { p_flag_key: flagKey, p_reason: reason }, 'Could not roll back.');
}

export async function completeRollout(flagKey: string): Promise<void> {
  await call<unknown>('staff_complete_rollout', { p_flag_key: flagKey }, 'Could not complete the rollout.');
}

export async function listAiVersions(): Promise<AiVersion[]> {
  return rows<AiVersion>(await call<unknown>('staff_ai_list_versions', undefined, 'Could not load AI versions.'));
}

export async function createAiVersion(kind: 'prompt' | 'route', taskKey: string, payload: unknown, notes: string): Promise<number> {
  return call<number>('staff_ai_create_version', { p_kind: kind, p_task_key: taskKey, p_payload: payload, p_notes: notes || null }, 'Could not create the version.');
}

export async function startAiShadow(kind: string, taskKey: string, version: number, samplePct: number): Promise<void> {
  await call<unknown>('staff_ai_start_shadow', { p_kind: kind, p_task_key: taskKey, p_version: version, p_sample_pct: samplePct }, 'Could not start shadow mode.');
}

export async function promoteAiVersion(kind: string, taskKey: string, version: number): Promise<void> {
  await call<unknown>('staff_ai_promote', { p_kind: kind, p_task_key: taskKey, p_version: version }, 'Could not promote the version.');
}

export async function rollbackAiVersion(kind: string, taskKey: string, reason: string): Promise<void> {
  await call<unknown>('staff_ai_rollback', { p_kind: kind, p_task_key: taskKey, p_reason: reason }, 'Could not roll back.');
}
