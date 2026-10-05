// src/lib/serviceIntelligenceLoopApi.ts
//
// Supabase access for the Service Intelligence Loop. All reads are RLS-scoped
// or go through SECURITY DEFINER RPCs that derive the tenant themselves
// (get_account_owner_id), so nothing here can read another account's rows.

import { supabase } from '@/lib/supabase';
import type { LoopMetrics, LoopPriorRow } from '@/lib/serviceIntelligenceLoop';

export function emptyLoopMetrics(): LoopMetrics {
  return {
    own: { outcomes: 0, with_cause: 0, verified: 0, pending: 0, refuted: 0, first_visit_fixed: 0, callbacks: 0 },
    predictions: {
      cases: 0, scored: 0, top1: 0, top3: 0,
      with_priors_scored: 0, with_priors_top1: 0, without_priors_scored: 0, without_priors_top1: 0,
    },
    network: { job_types: 0, cases: 0, verified: 0, max_contributors: 0 },
    sharing: true,
  };
}

/** Merge so a partially populated RPC result (or `{}` for a missing account) never crashes the UI. */
export async function fetchLoopMetrics(): Promise<LoopMetrics> {
  const { data, error } = await supabase.rpc('sil_loop_metrics');
  if (error) throw new Error(error.message);
  const base = emptyLoopMetrics();
  const d = (data ?? {}) as Partial<LoopMetrics>;
  return {
    own: { ...base.own, ...(d.own ?? {}) },
    predictions: { ...base.predictions, ...(d.predictions ?? {}) },
    network: { ...base.network, ...(d.network ?? {}) },
    sharing: typeof d.sharing === 'boolean' ? d.sharing : base.sharing,
  };
}

export async function fetchLoopPriors(playbookSlug: string, jobTypeKey: string): Promise<LoopPriorRow[]> {
  const { data, error } = await supabase.rpc('sil_get_priors', { p_playbook: playbookSlug, p_job_type: jobTypeKey });
  if (error) throw new Error(error.message);
  return (data ?? []) as LoopPriorRow[];
}

/** Marks this account's due outcomes as verified now (the nightly cron does the same for everyone). */
export async function verifyMyDueOutcomes(): Promise<number> {
  const { data, error } = await supabase.rpc('sil_verify_my_due_outcomes');
  if (error) throw new Error(error.message);
  return typeof data === 'number' ? data : 0;
}

export interface LoopOutcomeRow {
  id: string;
  job_id: string;
  playbook_slug: string;
  job_type_key: string;
  root_cause_key: string | null;
  resolution: string;
  verification_status: 'pending' | 'verified' | 'refuted' | 'inconclusive';
  verify_after: string | null;
  parts_used: string[];
  recorded_at: string;
}

export async function fetchRecentLoopOutcomes(limit = 15): Promise<LoopOutcomeRow[]> {
  const { data, error } = await supabase
    .from('job_outcomes')
    .select('id, job_id, playbook_slug, job_type_key, root_cause_key, resolution, verification_status, verify_after, parts_used, recorded_at')
    .order('recorded_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 50));
  if (error) throw new Error(error.message);
  return (data ?? []) as LoopOutcomeRow[];
}

/** Owner-only (enforced by RLS). Opting out also stops receiving network priors. */
export async function setLoopSharing(ownerId: string, share: boolean): Promise<void> {
  const { error } = await supabase
    .from('service_loop_settings')
    .upsert({ user_id: ownerId, share_global: share, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
}
