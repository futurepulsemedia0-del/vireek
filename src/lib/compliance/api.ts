import { supabase } from '@/lib/supabase';
import { allInProgress, resolveClaims, type ClaimView } from '@/lib/compliance/trustClaims';
import type { ControlRow, EvidenceRow } from '@/lib/compliance/controlStatus';

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
