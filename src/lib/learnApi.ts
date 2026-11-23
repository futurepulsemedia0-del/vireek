// src/lib/learnApi.ts — client API for /dashboard/learn. RLS scopes every row; the pass mark is re-checked in SQL.

import { supabase } from './supabase';
import { getModule, isLearnRole, PASS_PCT, type LearnRole } from './learnCourses';

export interface CompletionRow { course_slug: LearnRole; module_id: string; score_pct: number; completed_at: string }
export interface TeamCompletionRow { userId: string; displayName: string; course: LearnRole; modulesCompleted: number; lastCompletedAt: string }

/** The signed-in person's own completions (RLS also lets owners read teammates', so filter by user id). */
export async function fetchMyCompletions(userId: string): Promise<CompletionRow[]> {
  const { data, error } = await supabase
    .from('learn_module_completions')
    .select('course_slug,module_id,score_pct,completed_at')
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return ((data ?? []) as CompletionRow[]).filter((r) => isLearnRole(r.course_slug) && getModule(r.course_slug, r.module_id));
}

export async function recordCompletion(course: LearnRole, moduleId: string, scorePct: number): Promise<void> {
  if (!getModule(course, moduleId)) throw new Error('Unknown module.');
  if (!Number.isInteger(scorePct) || scorePct < PASS_PCT || scorePct > 100) throw new Error('Score is below the pass mark.');
  const { error } = await supabase.rpc('record_learn_completion', { p_course: course, p_module: moduleId, p_score_pct: scorePct });
  if (error) throw new Error(error.message);
}

/** Owner-only (the SQL function refuses anyone else). */
export async function fetchTeamCompletions(): Promise<TeamCompletionRow[]> {
  const { data, error } = await supabase.rpc('learn_team_completion_summary');
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).flatMap((r) =>
    isLearnRole(r.out_course_slug)
      ? [{ userId: String(r.out_user_id), displayName: String(r.out_display_name ?? ''), course: r.out_course_slug, modulesCompleted: Number(r.out_modules_completed) || 0, lastCompletedAt: String(r.out_last_completed_at ?? '') }]
      : [],
  );
}
