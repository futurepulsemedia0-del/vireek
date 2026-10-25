/**
 * Tenant success tooling — data access.
 *
 * Thin typed wrappers over the SECURITY DEFINER RPCs in
 * supabase/migrations/20271110000000_tenant_success_tooling.sql. All scoping,
 * rate limits and staff checks are enforced by the database, never here.
 */

import { supabase } from '@/lib/supabase';
import {
  NPS_COMMENT_MAX,
  isValidNpsScore,
  parseSnapshot,
  parseStaffOverview,
  type NpsCategory,
  type StaffSuccessData,
  type SuccessSnapshot,
} from '@/lib/successTools';

export type NpsContext = 'prompt' | 'success_center';
export type NpsSubmitResult =
  | { ok: true; category: NpsCategory }
  | { ok: false; reason: 'already_responded' | 'unavailable' };

export async function fetchSuccessSnapshot(): Promise<SuccessSnapshot> {
  const { data, error } = await supabase.rpc('get_my_success_snapshot');
  if (error) throw error;
  return parseSnapshot(data);
}

/** Cheap eligibility check for the in-app prompt. Any failure means "do not prompt". */
export async function fetchNpsDue(): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('nps_should_prompt');
    return !error && data === true;
  } catch {
    return false;
  }
}

export async function submitNps(score: number, comment: string, context: NpsContext = 'prompt'): Promise<NpsSubmitResult> {
  if (!isValidNpsScore(score)) throw new Error('Choose a score from 0 to 10.');
  const { data, error } = await supabase.rpc('submit_nps_response', {
    p_score: score,
    p_comment: comment.trim().slice(0, NPS_COMMENT_MAX) || null,
    p_context: context,
  });
  if (error) throw error;
  const d = (data ?? {}) as { ok?: boolean; reason?: string; category?: string };
  if (d.ok === true) {
    const category: NpsCategory = d.category === 'promoter' || d.category === 'passive' ? d.category : 'detractor';
    return { ok: true, category };
  }
  return { ok: false, reason: d.reason === 'already_responded' ? 'already_responded' : 'unavailable' };
}

export async function snoozeNpsPrompt(days: number): Promise<void> {
  const { error } = await supabase.rpc('set_success_item_state', { p_key: 'nps_prompt', p_status: 'snoozed', p_days: days });
  if (error) throw error;
}

export async function setItemState(key: string, status: 'snoozed' | 'dismissed' | 'skipped', days?: number): Promise<void> {
  const { error } = await supabase.rpc('set_success_item_state', { p_key: key, p_status: status, p_days: days ?? null });
  if (error) throw error;
}

export async function clearItemState(key: string): Promise<void> {
  const { error } = await supabase.rpc('clear_success_item_state', { p_key: key });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Staff (audited server-side). One shared 5-minute cache so the at-risk tab and
// the account detail panel never trigger duplicate heavy reads or audit rows.
// ---------------------------------------------------------------------------

const STAFF_TTL_MS = 5 * 60_000;
let staffCache: { at: number; promise: Promise<StaffSuccessData> } | null = null;

export function getStaffSuccessOverview(opts: { force?: boolean } = {}): Promise<StaffSuccessData> {
  const now = Date.now();
  if (!opts.force && staffCache && now - staffCache.at < STAFF_TTL_MS) return staffCache.promise;
  const promise = (async () => {
    const { data, error } = await supabase.rpc('staff_success_overview', { p_nps_days: 90 });
    if (error) throw error;
    return parseStaffOverview(data);
  })();
  const entry = { at: now, promise };
  staffCache = entry;
  // A failed load must not be cached.
  promise.catch(() => {
    if (staffCache === entry) staffCache = null;
  });
  return promise;
}
