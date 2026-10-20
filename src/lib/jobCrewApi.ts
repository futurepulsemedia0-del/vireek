import { supabase } from '@/lib/supabase';
import {
  describeCrewError,
  normalizeSkills,
  toRpcMembers,
  validateCrewDraft,
  type CrewDraft,
  type JobCrew,
} from '@/lib/jobCrew';

/**
 * Data access for multi-technician job crews.
 * Every write goes through the set_job_crew() RPC, which re-checks the caller's
 * permission, validates the roster and computes the shares on the server.
 */

export class JobCrewApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'JobCrewApiError';
    this.code = code;
  }
}

export interface CrewCandidate {
  id: string;
  name: string;
  skills: string[];
}

/** Returns null when the viewer is not allowed to see this job's crew. */
export async function fetchJobCrew(jobId: string): Promise<JobCrew | null> {
  const { data, error } = await supabase.rpc('get_job_crew', { p_job_id: jobId });
  if (error) throw new JobCrewApiError(describeCrewError(error), error.code);
  const row = data as (Partial<JobCrew> & { error?: string }) | null;
  if (!row || row.error) return null;
  return {
    has_crew: row.has_crew === true,
    can_manage: row.can_manage === true,
    can_see_money: row.can_see_money === true,
    labor_mode: row.labor_mode ?? 'role_weights',
    commission_mode: row.commission_mode ?? 'role_weights',
    required_skills: Array.isArray(row.required_skills) ? row.required_skills : [],
    skill_gaps: Array.isArray(row.skill_gaps) ? row.skill_gaps : [],
    total_minutes: typeof row.total_minutes === 'number' ? row.total_minutes : 0,
    members: Array.isArray(row.members) ? row.members : [],
  };
}

/** Active technicians who can be put on a crew. */
export async function fetchCrewCandidates(ownerId: string): Promise<CrewCandidate[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, member_name, member_email, skills')
    .eq('account_owner_id', ownerId)
    .eq('role', 'technician')
    .eq('invite_status', 'active')
    .order('member_name', { ascending: true });
  if (error) throw new JobCrewApiError(describeCrewError(error), error.code);
  return (Array.isArray(data) ? data : []).flatMap((row) => {
    const r = row as { id?: unknown; member_name?: unknown; member_email?: unknown; skills?: unknown };
    if (typeof r.id !== 'string') return [];
    const name = typeof r.member_name === 'string' && r.member_name.trim() ? r.member_name.trim() : typeof r.member_email === 'string' ? r.member_email : 'Technician';
    const skills = Array.isArray(r.skills) ? r.skills.filter((s): s is string => typeof s === 'string') : [];
    return [{ id: r.id, name, skills }];
  });
}

/** Saves the crew (an empty roster dissolves it). Returns required skills nobody on the crew covers. */
export async function saveJobCrew(jobId: string, draft: CrewDraft): Promise<{ skillGaps: string[] }> {
  const problem = validateCrewDraft(draft);
  if (problem) throw new JobCrewApiError(problem, 'validation');
  const { data, error } = await supabase.rpc('set_job_crew', {
    p_job_id: jobId,
    p_members: toRpcMembers(draft),
    p_labor_mode: draft.laborMode,
    p_commission_mode: draft.commissionMode,
    p_required_skills: normalizeSkills(draft.requiredSkills),
  });
  if (error) throw new JobCrewApiError(describeCrewError(error), error.code);
  const gaps = (data as { skill_gaps?: unknown } | null)?.skill_gaps;
  return { skillGaps: Array.isArray(gaps) ? gaps.filter((s): s is string => typeof s === 'string') : [] };
}

export async function dissolveJobCrew(jobId: string): Promise<void> {
  const { error } = await supabase.rpc('set_job_crew', {
    p_job_id: jobId,
    p_members: [],
    p_labor_mode: 'role_weights',
    p_commission_mode: 'role_weights',
    p_required_skills: [],
  });
  if (error) throw new JobCrewApiError(describeCrewError(error), error.code);
}
