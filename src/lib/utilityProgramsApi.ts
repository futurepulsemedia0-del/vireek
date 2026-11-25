/** Utility-program operations client (item 141). All reads/writes go through RLS (account scope = get_account_owner_id()). */
import { supabase } from '@/lib/supabase';
import {
  summarizeApplications, type ApplicationRow, type EnrollmentStatus, type SubmissionProfile, type TrackingSummary,
} from '../../supabase/functions/_shared/rebate-intelligence/utilityPrograms';

export { buildProgramActions, summarizeApplications, SUBMISSION_METHODS, ENROLLMENT_STATUSES } from '../../supabase/functions/_shared/rebate-intelligence/utilityPrograms';
export type { ApplicationRow, EnrollmentStatus, ProgramAction, SubmissionProfile, TrackingSummary } from '../../supabase/functions/_shared/rebate-intelligence/utilityPrograms';

export async function loadSubmissionProfiles(programIds: string[]): Promise<Record<string, SubmissionProfile>> {
  if (programIds.length === 0) return {};
  const { data, error } = await supabase.from('utility_program_submission_profiles')
    .select('program_id, submission_method, submission_url, submission_deadline_days, required_documents').in('program_id', programIds);
  if (error) throw error;
  return Object.fromEntries(((data ?? []) as SubmissionProfile[]).map((p) => [p.program_id, p]));
}

export async function loadEnrollments(): Promise<Record<string, EnrollmentStatus>> {
  const { data, error } = await supabase.from('contractor_program_enrollments').select('program_id, status');
  if (error) throw error;
  return Object.fromEntries(((data ?? []) as { program_id: string; status: EnrollmentStatus }[]).map((e) => [e.program_id, e.status]));
}

export async function setEnrollment(accountOwnerId: string, programId: string, status: EnrollmentStatus, ref: string | null): Promise<void> {
  const { error } = await supabase.from('contractor_program_enrollments').upsert(
    { user_id: accountOwnerId, program_id: programId, status, enrollment_ref: ref },
    { onConflict: 'user_id,program_id' },
  );
  if (error) throw error;
}

export async function loadTracking(nowIso: string = new Date().toISOString()): Promise<TrackingSummary> {
  const { data, error } = await supabase.from('rebate_applications')
    .select('id, status, estimated_cents, approved_cents, paid_cents, submission_due_at, submitted_at').limit(5000);
  if (error) throw error;
  return summarizeApplications((data ?? []) as ApplicationRow[], nowIso);
}

export async function setSubmissionDue(applicationId: string, completedAtIso: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('rebate_set_submission_due', { p_application: applicationId, p_completed_at: completedAtIso });
  if (error) throw error;
  return (data as string | null) ?? null;
}
