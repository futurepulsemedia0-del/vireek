// Supabase access for pilot management. Every function throws an Error with a
// message that is safe to show. All of it is staff-only and enforced server-side
// (RLS + is_vireek_staff in every RPC); the UI gate (StaffRoute) is convenience.
import { supabase } from '@/lib/supabase';
import {
  toCaseStudy, toFlaggedCall, toPilot, toWeek,
  type CaseStudyExport, type ConsentPayload, type ExportFormat, type FlaggedCall, type Pilot, type PilotAuditEntry, type PilotPayload, type PilotWeek,
} from '@/lib/pilotManagement';

interface DbError { message?: string; code?: string }

function fail(error: DbError | null | undefined, fallback: string): never {
  switch (error?.code) {
    case '23505': throw new Error('This customer already has an open pilot. Complete it before starting another.');
    case '42501': throw new Error('Staff access is required for this action.');
    case '55000': throw new Error('Export needs the customer’s recorded consent to share metrics.');
    case 'P0002': throw new Error(error.message || 'That record no longer exists.');
    case '22023': throw new Error(error.message || fallback);
    case '23514': throw new Error('Some values are out of range. Check the form and try again.');
    default: throw new Error(fallback);
  }
}

const PILOT_COLS = 'id';

export async function listPilots(): Promise<Pilot[]> {
  const { data, error } = await supabase.rpc('staff_list_pilots');
  if (error) fail(error, 'Could not load pilots.');
  return ((data ?? []) as Record<string, unknown>[]).map(toPilot);
}

export async function createPilot(p: PilotPayload): Promise<void> {
  const { error } = await supabase.from('pilot_customers').insert(p).select(PILOT_COLS).single();
  if (error) fail(error, 'Could not create the pilot.');
}

/** The tenant is immutable, so it is never part of an update. */
export async function updatePilot(id: string, patch: Partial<Omit<PilotPayload, 'tenant_id'>> | ConsentPayload): Promise<void> {
  const { error } = await supabase.from('pilot_customers').update(patch).eq('id', id).select(PILOT_COLS).single();
  if (error) fail(error, 'Could not save the changes.');
}

export async function deletePilot(id: string): Promise<void> {
  const { error } = await supabase.from('pilot_customers').delete().eq('id', id);
  if (error) fail(error, 'Could not delete the pilot.');
}

export async function getPilotTrend(id: string): Promise<PilotWeek[]> {
  const { data, error } = await supabase.rpc('staff_pilot_trend', { p_pilot_id: id });
  if (error) fail(error, 'Could not load the weekly trend.');
  return ((data ?? []) as Record<string, unknown>[]).map(toWeek);
}

export async function getFlaggedCalls(id: string, limit = 50): Promise<FlaggedCall[]> {
  const { data, error } = await supabase.rpc('staff_pilot_quality_flags', { p_pilot_id: id, p_limit: limit });
  if (error) fail(error, 'Could not load flagged calls.');
  return ((data ?? []) as Record<string, unknown>[]).map(toFlaggedCall);
}

export async function listPilotAudit(id: string): Promise<PilotAuditEntry[]> {
  const { data, error } = await supabase.rpc('staff_list_pilot_audit', { p_pilot_id: id });
  if (error) fail(error, 'Could not load history.');
  return ((data ?? []) as PilotAuditEntry[]).map((a) => ({ ...a, id: Number(a.id) }));
}

/** Consent-gated and audited on the server. Throws if consent is missing. */
export async function exportCaseStudy(id: string, format: ExportFormat): Promise<CaseStudyExport> {
  const { data, error } = await supabase.rpc('staff_export_pilot_case_study', { p_pilot_id: id, p_format: format });
  if (error) fail(error, 'Could not export the case study.');
  return toCaseStudy((data ?? {}) as Record<string, unknown>);
}
