/**
 * Install Closeout — data layer (Supabase). Pure rules live in installCloseoutLogic.ts.
 * Every write goes through a validated RPC; the client never writes closeout tables directly.
 */
import { supabase } from '@/lib/supabase';
import type {
  CloseoutAnchor, CloseoutSettings, CloseoutStepKey, CloseoutStepStatus,
  Eligibility, PreApprovalStatus, EvidenceKind,
} from '@/lib/installCloseoutLogic';

export * from '@/lib/installCloseoutLogic';

export interface CloseoutProgram {
  id: string;
  step_key: CloseoutStepKey;
  name: string;
  administrator: string | null;
  anchor: CloseoutAnchor;
  deadline_days: number | null;
  requires_pre_approval: boolean;
  required_evidence: EvidenceKind[];
  enrollment_requirements: string[];
  estimated_value_cents: number | null;
  incentive_program_id: string | null;
  auto_attach: boolean;
  source_url: string | null;
  last_verified_on: string | null;
  reverify_days: number;
  notes: string | null;
  is_active: boolean;
}

export interface CloseoutCase {
  id: string;
  job_id: string;
  install_date: string | null;
  job_complete_date: string | null;
  status: 'open' | 'closed';
  notes: string | null;
  created_at: string;
  jobs?: { customer_name: string; address: string | null; job_status: string } | null;
}

export interface CloseoutStep {
  id: string;
  case_id: string;
  job_id: string;
  step_key: CloseoutStepKey;
  program_id: string | null;
  status: CloseoutStepStatus;
  assignee_member_id: string | null;
  deadline_on: string | null;
  deadline_manual: boolean;
  estimated_value_cents: number | null;
  rebate_application_id: string | null;
  eligibility: Eligibility;
  pre_approval_required: boolean;
  pre_approval_status: PreApprovalStatus;
  pre_approval_reference: string | null;
  reference_number: string | null;
  note: string | null;
  na_reason: string | null;
  approved_at: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  missed_at: string | null;
  closeout_programs?: CloseoutProgram | null;
  closeout_cases?: { job_id: string; install_date: string | null; jobs: { customer_name: string; address: string | null } | null } | null;
}

export interface CloseoutEvidence {
  id: string;
  step_id: string;
  kind: EvidenceKind;
  label: string | null;
  value: string | null;
  job_photo_id: string | null;
  document_id: string | null;
  source: 'manual' | 'auto';
  created_at: string;
}

export interface CloseoutEvent {
  id: string;
  case_id: string | null;
  step_id: string | null;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_email: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface MonthlySummary {
  month: string;
  cases_opened: number;
  totals: {
    steps_due: number; completed_on_time: number; completed_late: number; missed_open: number; still_open: number;
    estimated_cents_completed_on_time: number; estimated_cents_missed: number;
  };
  by_step: { step_key: CloseoutStepKey; due: number; on_time: number; late: number; missed: number }[];
  estimate_note: string;
}

export interface TeamMemberLite { id: string; member_name: string | null; member_email: string; role: string }

/** Friendly message for the CLOSEOUT_* errors raised by the database. */
export function closeoutErrorMessage(err: unknown): string {
  const raw = (err as { message?: string })?.message ?? '';
  const m = raw.match(/CLOSEOUT_([A-Z_]+):\s*(.*)$/);
  if (m) {
    const detail = m[2].trim();
    switch (m[1]) {
      case 'MISSING_EVIDENCE': return `Required items are missing: ${detail.split(',').join(', ')}.`;
      case 'HUMAN_APPROVAL_REQUIRED': return 'A person must approve this and submit it externally — tick the confirmation box.';
      case 'REFERENCE_REQUIRED': return 'Record the confirmation/reference number (or add a note).';
      case 'PRE_APPROVAL_NOT_RECORDED': return 'Pre-approval has not been recorded for this program yet.';
      case 'DEPENDENCY': return `Finish these steps first: ${detail.replace(/^finish first:\s*/, '').split(',').join(', ')}.`;
      case 'NOTE_REQUIRED': return `A note is required: ${detail}.`;
      case 'INVALID_TRANSITION': return `That status change is not allowed (${detail}).`;
      case 'PROGRAM_NEEDS_SOURCE': return 'Add the source URL and the date you last verified it before activating a rule.';
      case 'PRE_APPROVAL_REQUIRED': return `Pre-approval required first: ${detail.split('||').join(', ')}.`;
      default: return detail || raw;
    }
  }
  return raw || 'Something went wrong. Please try again.';
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(closeoutErrorMessage(error));
  return data as T;
}

// ---------------------------------------------------------------- reads

const STEP_SELECT =
  '*, closeout_programs(*), closeout_cases(job_id, install_date, jobs(customer_name, address))';

export async function fetchCloseoutSteps(): Promise<CloseoutStep[]> {
  const { data, error } = await supabase
    .from('closeout_steps').select(STEP_SELECT).order('deadline_on', { ascending: true, nullsFirst: false }).limit(2000);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as CloseoutStep[];
}

export async function fetchCaseSteps(caseId: string): Promise<CloseoutStep[]> {
  const { data, error } = await supabase.from('closeout_steps').select(STEP_SELECT).eq('case_id', caseId);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as CloseoutStep[];
}

export async function fetchCloseoutCases(): Promise<CloseoutCase[]> {
  const { data, error } = await supabase
    .from('closeout_cases').select('*, jobs(customer_name, address, job_status)')
    .order('created_at', { ascending: false }).limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as CloseoutCase[];
}

export async function fetchCloseoutPrograms(): Promise<CloseoutProgram[]> {
  const { data, error } = await supabase.from('closeout_programs').select('*').order('step_key').order('name');
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as CloseoutProgram[];
}

export async function fetchCloseoutSettings(): Promise<CloseoutSettings> {
  const { data, error } = await supabase
    .from('closeout_settings').select('technician_days, office_days, owner_days').maybeSingle();
  if (error) throw new Error(error.message);
  return (data as CloseoutSettings | null) ?? { technician_days: 7, office_days: 3, owner_days: 0 };
}

export async function fetchCaseEvidence(caseId: string): Promise<CloseoutEvidence[]> {
  const { data, error } = await supabase.from('closeout_evidence').select('*').eq('case_id', caseId).order('created_at');
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as CloseoutEvidence[];
}

export async function fetchCaseEvents(caseId: string): Promise<CloseoutEvent[]> {
  const { data, error } = await supabase
    .from('closeout_events').select('id, case_id, step_id, event_type, from_status, to_status, actor_email, detail, created_at')
    .eq('case_id', caseId).order('created_at', { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as CloseoutEvent[];
}

export async function fetchRecentEvents(limit = 100): Promise<CloseoutEvent[]> {
  const { data, error } = await supabase
    .from('closeout_events').select('id, case_id, step_id, event_type, from_status, to_status, actor_email, detail, created_at')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as CloseoutEvent[];
}

export async function fetchJobCloseout(jobId: string): Promise<{ case: CloseoutCase | null; steps: CloseoutStep[] }> {
  const { data: c, error } = await supabase.from('closeout_cases').select('*').eq('job_id', jobId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!c) return { case: null, steps: [] };
  const { data: steps, error: e2 } = await supabase
    .from('closeout_steps').select('*, closeout_programs(*)').eq('case_id', (c as { id: string }).id);
  if (e2) throw new Error(e2.message);
  return { case: c as unknown as CloseoutCase, steps: (steps ?? []) as unknown as CloseoutStep[] };
}

export async function fetchJobsWithoutCase(): Promise<{ id: string; customer_name: string; address: string | null }[]> {
  const [{ data: jobs, error }, { data: cases }] = await Promise.all([
    supabase.from('jobs').select('id, customer_name, address').order('created_at', { ascending: false }).limit(200),
    supabase.from('closeout_cases').select('job_id'),
  ]);
  if (error) throw new Error(error.message);
  const taken = new Set((cases ?? []).map((c: { job_id: string }) => c.job_id));
  return ((jobs ?? []) as { id: string; customer_name: string; address: string | null }[]).filter((j) => !taken.has(j.id));
}

export async function fetchTeamMembers(): Promise<TeamMemberLite[]> {
  const { data, error } = await supabase
    .from('team_members').select('id, member_name, member_email, role').eq('invite_status', 'active').order('member_name');
  if (error) throw new Error(error.message);
  return (data ?? []) as TeamMemberLite[];
}

export async function fetchJobPhotos(jobId: string): Promise<{ id: string; file_name: string; storage_path: string; kind: string }[]> {
  const { data, error } = await supabase
    .from('job_photos').select('id, file_name, storage_path, kind').eq('job_id', jobId).order('taken_at', { ascending: false }).limit(60);
  if (error) throw new Error(error.message);
  return (data ?? []) as { id: string; file_name: string; storage_path: string; kind: string }[];
}

export async function fetchDocuments(): Promise<{ id: string; title: string; category: string }[]> {
  const { data, error } = await supabase.from('documents').select('id, title, category').order('created_at', { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as { id: string; title: string; category: string }[];
}

export async function fetchRebateApplications(): Promise<{ id: string; program_name: string; estimated_cents: number; status: string }[]> {
  const { data, error } = await supabase
    .from('rebate_applications').select('id, program_name, estimated_cents, status').order('created_at', { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as { id: string; program_name: string; estimated_cents: number; status: string }[];
}

// ---------------------------------------------------------------- writes (RPC only)

export const openCloseoutCase = (jobId: string, installDate?: string | null) =>
  rpc<CloseoutCase>('closeout_open_case', { p_job_id: jobId, p_install_date: installDate || null });

export const updateCloseoutCase = (caseId: string, patch: Record<string, unknown>) =>
  rpc<CloseoutCase>('closeout_update_case', { p_case_id: caseId, p_patch: patch });

export const updateCloseoutStep = (stepId: string, patch: Record<string, unknown>) =>
  rpc<CloseoutStep>('closeout_update_step', { p_step_id: stepId, p_patch: patch });

export const transitionCloseoutStep = (
  stepId: string, to: CloseoutStepStatus,
  opts: { note?: string; reference?: string; attest?: boolean } = {},
) =>
  rpc<CloseoutStep>('closeout_transition_step', {
    p_step_id: stepId, p_to: to, p_note: opts.note ?? null, p_reference: opts.reference ?? null, p_attest: opts.attest === true,
  });

export const setPreApproval = (stepId: string, status: 'pending' | 'requested' | 'approved' | 'denied', reference?: string, note?: string) =>
  rpc<CloseoutStep>('closeout_set_pre_approval', { p_step_id: stepId, p_status: status, p_reference: reference ?? null, p_note: note ?? null });

export const attachProgram = (caseId: string, programId: string) =>
  rpc<CloseoutStep>('closeout_attach_program', { p_case_id: caseId, p_program_id: programId });

export const linkRebate = (stepId: string, rebateApplicationId: string) =>
  rpc<CloseoutStep>('closeout_link_rebate', { p_step_id: stepId, p_rebate_application_id: rebateApplicationId });

export const addEvidence = (
  stepId: string, kind: EvidenceKind,
  opts: { label?: string; value?: string; jobPhotoId?: string; documentId?: string } = {},
) =>
  rpc<CloseoutEvidence>('closeout_add_evidence', {
    p_step_id: stepId, p_kind: kind, p_label: opts.label ?? null, p_value: opts.value ?? null,
    p_job_photo_id: opts.jobPhotoId ?? null, p_document_id: opts.documentId ?? null,
  });

export const removeEvidence = (evidenceId: string) => rpc<void>('closeout_remove_evidence', { p_evidence_id: evidenceId });
export const autocollectEvidence = (stepId: string) => rpc<number>('closeout_autocollect_evidence', { p_step_id: stepId });
export const logPacketGenerated = (stepId: string) => rpc<void>('closeout_log_packet', { p_step_id: stepId });

export const saveCloseoutProgram = (id: string | null, program: Record<string, unknown>) =>
  rpc<CloseoutProgram>('closeout_save_program', { p_id: id, p: program });
export const verifyCloseoutProgram = (id: string) => rpc<CloseoutProgram>('closeout_verify_program', { p_id: id });

export const saveCloseoutSettings = (s: CloseoutSettings) =>
  rpc<CloseoutSettings>('closeout_save_settings', { p_technician: s.technician_days, p_office: s.office_days, p_owner: s.owner_days });

export const fetchMonthlySummary = (month: string) => rpc<MonthlySummary>('closeout_monthly_summary', { p_month: month });
