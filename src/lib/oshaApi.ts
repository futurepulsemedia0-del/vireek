import { supabase } from '@/lib/supabase';
import type { OshaCaseInput, OshaCaseRow, OshaLogRow, OshaSummaryExport } from '@/lib/osha/core';

/**
 * OSHA recordkeeping — client API. Reads go through RLS (managers only); every write and every export is a
 * SECURITY DEFINER RPC that re-checks the caller and the tenant. Pure logic lives in src/lib/osha/core.ts.
 */

export interface OshaSettings {
  establishment_name: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  industry_description: string | null;
  naics_code: string | null;
  retention_years: number;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

const CASE_COLS =
  'id, case_year, case_seq, case_no, incident_id, employee_name, job_title, date_of_injury, location_where, description, classification, days_away, days_restricted, illness_type, privacy_case, voided_at, retain_until';

export async function listOshaCases(year: number): Promise<OshaCaseRow[]> {
  const { data, error } = await supabase.from('osha_cases').select(CASE_COLS).eq('case_year', year).order('case_seq', { ascending: true }).limit(2000);
  if (error) throw new Error(error.message);
  return (data ?? []) as OshaCaseRow[];
}

export async function getOshaSettings(): Promise<OshaSettings | null> {
  const { data, error } = await supabase.from('osha_settings')
    .select('establishment_name, street, city, state, zip, industry_description, naics_code, retention_years').maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as OshaSettings | null;
}

export const saveOshaSettings = (s: Partial<OshaSettings>) => rpc<{ success: boolean }>('osha_upsert_settings', { p: s });
export const createOshaCase = (c: OshaCaseInput) => rpc<{ success: boolean; existing: boolean; id: string; case_no: string }>('osha_create_case', { p: c });
export const updateOshaCase = (id: string, patch: Partial<OshaCaseInput>) => rpc<{ success: boolean; changed_fields: string[] }>('osha_update_case', { p_id: id, p: patch });
export const voidOshaCase = (id: string, reason: string) => rpc<{ success: boolean }>('osha_void_case', { p_id: id, p_reason: reason });
export const exportOshaLog = (year: number) => rpc<{ year: number; rows: OshaLogRow[] }>('osha_export_log', { p_year: year });
export const saveOshaSummaryInputs = (year: number, avgEmployees: number, totalHours: number) =>
  rpc<{ success: boolean }>('osha_save_summary_inputs', { p_year: year, p_avg_employees: avgEmployees, p_total_hours: totalHours });
export const exportOshaSummary = (year: number) => rpc<OshaSummaryExport>('osha_export_summary', { p_year: year });
export const certifyOshaSummary = (year: number, name: string, title: string, phone?: string) =>
  rpc<{ success: boolean; already_certified: boolean }>('osha_certify_summary', { p_year: year, p_name: name, p_title: title, p_phone: phone ?? null });
export const listCasesPastRetention = () => rpc<Array<{ id: string; case_no: string; retain_until: string }>>('osha_cases_past_retention', {});
