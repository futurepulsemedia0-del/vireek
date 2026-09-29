/**
 * Vireek Technician Apprenticeship Engine - data access.
 *
 * Thin, typed wrappers over Supabase. All scoping is enforced by RLS and the
 * SECURITY DEFINER RPCs in 20270105000000_technician_apprenticeship_engine.sql,
 * so nothing here decides who may see or write what.
 */

import { supabase } from '@/lib/supabase';
import type { SimTrade } from '@/lib/technicianSimulator';
import type { ApprenticeshipLevel, SimEvidenceRow } from '@/lib/technicianApprenticeship';

export interface ApprenticeshipPlan {
  id: string;
  account_owner_id: string;
  team_member_id: string;
  target_level: ApprenticeshipLevel;
  trades: SimTrade[];
  status: 'active' | 'completed' | 'cancelled';
  baseline_readiness: number | null;
  baseline_scores: Record<string, number | null>;
  target_date: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface LessonCompletion {
  team_member_id: string;
  lesson_id: string;
  completed_at: string;
}

const PLAN_COLUMNS =
  'id, account_owner_id, team_member_id, target_level, trades, status, baseline_readiness, baseline_scores, target_date, created_at, completed_at';

export async function fetchSimEvidence(): Promise<SimEvidenceRow[]> {
  const { data, error } = await supabase.rpc('get_apprenticeship_sim_evidence', {
    p_technician_id: null,
  });
  if (error) throw error;
  return (data as SimEvidenceRow[]) ?? [];
}

/** Active plans only: cancelled and completed plans are history, not current targets. */
export async function fetchActivePlans(): Promise<ApprenticeshipPlan[]> {
  const { data, error } = await supabase
    .from('apprenticeship_plans')
    .select(PLAN_COLUMNS)
    .eq('status', 'active');
  if (error) throw error;
  return (data as ApprenticeshipPlan[]) ?? [];
}

export async function fetchLessonCompletions(): Promise<LessonCompletion[]> {
  const { data, error } = await supabase
    .from('apprenticeship_lesson_completions')
    .select('team_member_id, lesson_id, completed_at');
  if (error) throw error;
  return (data as LessonCompletion[]) ?? [];
}

export async function createPlan(input: {
  accountOwnerId: string;
  teamMemberId: string;
  targetLevel: ApprenticeshipLevel;
  trades: SimTrade[];
  baselineReadiness: number;
  baselineScores: Record<string, number | null>;
  targetDate?: string | null;
}): Promise<ApprenticeshipPlan> {
  const { data, error } = await supabase
    .from('apprenticeship_plans')
    .insert({
      account_owner_id: input.accountOwnerId,
      team_member_id: input.teamMemberId,
      target_level: input.targetLevel,
      trades: input.trades,
      baseline_readiness: input.baselineReadiness,
      baseline_scores: input.baselineScores,
      target_date: input.targetDate || null,
    })
    .select(PLAN_COLUMNS)
    .single();
  if (error) {
    if (error.code === '23505')
      throw new Error('This technician already has an active apprenticeship plan.');
    throw error;
  }
  return data as ApprenticeshipPlan;
}

export async function setPlanStatus(
  planId: string,
  status: 'cancelled' | 'completed',
): Promise<void> {
  const { error } = await supabase
    .from('apprenticeship_plans')
    .update({ status, completed_at: status === 'completed' ? new Date().toISOString() : null })
    .eq('id', planId)
    .eq('status', 'active');
  if (error) throw error;
}

export async function completeLesson(lessonId: string): Promise<void> {
  const { error } = await supabase.rpc('complete_apprenticeship_lesson', { p_lesson_id: lessonId });
  if (error) throw error;
}
