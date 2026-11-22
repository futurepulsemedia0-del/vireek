import { supabase } from '@/lib/supabase';
import { allInProgress, resolveClaims, type ClaimView } from '@/lib/compliance/trustClaims';
import type { ControlRow, EvidenceRow } from '@/lib/compliance/controlStatus';
import type { AckMatrix, PolicyOverview } from '@/lib/compliance/policyApproval';
import type { RecordInput, WorkforceOverview } from '@/lib/compliance/workforce';

/** Staff-only (RLS). Non-staff callers get zero rows. */
export async function fetchControls(): Promise<ControlRow[]> {
  const { data, error } = await supabase.from('compliance_control_status').select('*').order('id');
  if (error) throw new Error(error.message);
  return (data ?? []) as ControlRow[];
}

/** Staff-only (RLS). Latest evidence index for the auditor export; capped. */
export async function fetchEvidenceIndex(limit = 2000): Promise<EvidenceRow[]> {
  const { data, error } = await supabase
    .from('compliance_evidence')
    .select('id,control_id,collector,collected_at,result,outcome,sha256,storage_path,run_ref,source')
    .order('collected_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as EvidenceRow[];
}

/** Public. Any failure => every claim "In progress" (fail closed). */
export async function fetchPublicClaims(): Promise<ClaimView[]> {
  try {
    const { data, error } = await supabase.rpc('public_trust_claims');
    if (error) return allInProgress();
    return resolveClaims(Array.isArray(data) ? data : null);
  } catch {
    return allInProgress();
  }
}

// ---------------------------------------------------------------- policy approval workflow (staff only)
// Every call is an RPC that re-checks is_vireek_staff() in SQL; the UI gate (StaffRoute) is only a convenience.

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const fetchPolicyOverview = () => call<PolicyOverview>('staff_policy_overview');
export const fetchAckMatrix = (slug: string) => call<AckMatrix>('staff_policy_ack_matrix', { p_slug: slug });
export const submitPolicyVersion = (slug: string, version: string, changeSummary: string) =>
  call<string>('staff_policy_submit_version', { p_slug: slug, p_version: version, p_change_summary: changeSummary.trim() || null });
export const approvePolicyVersion = (versionId: string, effectiveOn: string | null) =>
  call<{ self_approved: boolean }>('staff_policy_approve_version', { p_version_id: versionId, p_effective_on: effectiveOn });
export const withdrawPolicyVersion = (versionId: string) => call<null>('staff_policy_withdraw_version', { p_version_id: versionId });
export const acknowledgePolicyVersion = (versionId: string) => call<boolean>('staff_policy_acknowledge', { p_version_id: versionId });

// ---------------------------------------------------------------- workforce completion facts (staff only)
export const fetchWorkforceOverview = () => call<WorkforceOverview>('staff_workforce_overview');
export const addWorkforceRecord = (i: RecordInput) =>
  call<string>('staff_workforce_record_add', {
    p_subject: i.subjectId,
    p_record_type: i.recordType,
    p_course_key: i.courseKey,
    p_status: i.status,
    p_completed_on: i.status === 'completed' ? i.completedOn : null,
    p_valid_until: i.status === 'completed' && i.validUntil ? i.validUntil : null,
    p_waiver_code: i.status === 'waived' ? i.waiverCode : null,
    p_provider_label: i.providerLabel.trim() || null,
    p_external_ref: i.externalRef.trim() || null,
  });
export const setWorkforceRequirement = (key: string, required: boolean) => call<null>('staff_workforce_set_requirement', { p_key: key, p_required: required });
