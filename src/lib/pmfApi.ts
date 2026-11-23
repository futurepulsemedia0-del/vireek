import { supabase } from '@/lib/supabase';
import {
  parsePmfSummary, parseRetention,
  type PmfAnswer, type PmfDimension, type PmfSegmentRow, type RetentionDimension, type RetentionRow,
} from '@/lib/pmf';

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

/** True only when the server says this person is eligible AND records the prompt as shown. Never throws. */
export async function claimPmf(): Promise<boolean> {
  try {
    const d = await rpc<{ ok?: boolean }>('pmf_claim');
    return d?.ok === true;
  } catch {
    return false;
  }
}

export const respondPmf = (answer: PmfAnswer, mainBenefit: string, improvement: string) =>
  rpc<{ ok?: boolean; reason?: string }>('pmf_respond', {
    p_answer: answer,
    p_main_benefit: mainBenefit || null,
    p_improvement: improvement || null,
  });

export const dismissPmf = (action: 'dismissed' | 'snoozed' | 'never', days = 30) =>
  rpc('pmf_dismiss', { p_action: action, p_days: days }).catch(() => undefined);

// ---- staff (each RPC re-checks is_vireek_staff server-side) ----
export async function fetchPmfSummary(days: number, dimension: PmfDimension): Promise<PmfSegmentRow[]> {
  return parsePmfSummary(await rpc<unknown>('staff_pmf_summary', { p_days: days, p_dimension: dimension }));
}

export async function fetchRetention(weeks: number, dimension: RetentionDimension): Promise<RetentionRow[]> {
  return parseRetention(await rpc<unknown>('staff_retention_by_segment', { p_weeks: weeks, p_dimension: dimension }));
}
