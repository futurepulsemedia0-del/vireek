/**
 * Customer-success tasks — data access. Thin wrappers over the staff-only RPCs in
 * supabase/migrations/20290304000000_staff_cs_tasks.sql. Authorization and the feature flag are enforced by the database.
 */

import { supabase } from '@/lib/supabase';
import { parseCsTasks, type CsTask, type CsTaskCandidate } from '@/lib/csTasks';

export type CsSyncResult = { ok: true; created: number; updated: number; skipped: number } | { ok: false; reason: 'flag_off' | 'unavailable' };
export type CsListResult = { ok: true; tasks: CsTask[] } | { ok: false; reason: 'flag_off' | 'unavailable' };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Never throws: task creation is a side effect and must not break the at-risk view. */
export async function syncCsTasks(candidates: CsTaskCandidate[]): Promise<CsSyncResult> {
  if (candidates.length === 0) return { ok: false, reason: 'unavailable' };
  try {
    const { data, error } = await supabase.rpc('staff_sync_cs_tasks', { p_candidates: candidates });
    if (error) return { ok: false, reason: 'unavailable' };
    const d = (data ?? {}) as { ok?: boolean; reason?: string; created?: unknown; updated?: unknown; skipped?: unknown };
    if (d.ok === true) return { ok: true, created: num(d.created), updated: num(d.updated), skipped: num(d.skipped) };
    return { ok: false, reason: d.reason === 'flag_off' ? 'flag_off' : 'unavailable' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export async function listCsTasks(): Promise<CsListResult> {
  try {
    const { data, error } = await supabase.rpc('staff_list_cs_tasks');
    if (error) return { ok: false, reason: 'unavailable' };
    const d = (data ?? {}) as { ok?: boolean; reason?: string };
    if (d.ok === true) return { ok: true, tasks: parseCsTasks(data) };
    return { ok: false, reason: d.reason === 'flag_off' ? 'flag_off' : 'unavailable' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export type CsTaskChange = { status: 'in_progress' | 'done' | 'dismissed' } | { assignMe: true };

/** Throws on failure so the UI can show an error; returns false when the task was already closed. */
export async function updateCsTask(id: string, change: CsTaskChange): Promise<boolean> {
  const { data, error } = await supabase.rpc('staff_update_cs_task', {
    p_id: id,
    p_status: 'status' in change ? change.status : null,
    p_assign_me: 'assignMe' in change,
  });
  if (error) throw error;
  return (data as { ok?: boolean } | null)?.ok === true;
}
