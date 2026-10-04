/**
 * Vireek Outcome Intelligence Network — API layer (Supabase).
 * All privacy rules are enforced in Postgres (RLS + SECURITY DEFINER RPCs);
 * nothing here can widen what a tenant is allowed to see or share.
 */

import { supabase } from '@/lib/supabase';
import {
  tradeFromIndustry,
  type ClimateBand,
  type OinCase,
  type OinOverview,
  type OinRecommendResult,
  type OinSettings,
  type OinTrade,
  type TaxonomyItem,
} from '@/lib/outcomeNetwork';

export interface CapturableJob {
  id: string;
  customer_name: string;
  service_type: string | null;
  completed_at: string | null;
  latitude: number | null;
  notes: string | null;
  equipment: { id: string; equipment_type: string; make: string | null; model: string | null } | null;
}

export interface EquipmentOption {
  equipment_type: string;
  make: string | null;
  model: string | null;
}

export async function fetchTrade(): Promise<OinTrade | 'other'> {
  const { data, error } = await supabase.from('business_profile').select('primary_industry').maybeSingle();
  if (error) throw error;
  return tradeFromIndustry((data as { primary_industry?: string | null } | null)?.primary_industry);
}

export async function fetchTaxonomy(trade: OinTrade): Promise<TaxonomyItem[]> {
  const { data, error } = await supabase.from('oin_taxonomy').select('kind, trade, key, label').eq('trade', trade).order('label');
  if (error) throw error;
  return (data as TaxonomyItem[]) ?? [];
}

export async function fetchSettings(): Promise<OinSettings | null> {
  const { data, error } = await supabase.from('oin_settings').select('*').maybeSingle();
  if (error) throw error;
  return (data as OinSettings | null) ?? null;
}

export async function setContribution(enabled: boolean): Promise<OinSettings> {
  const { data, error } = await supabase.rpc('oin_set_contribution', { p_enabled: enabled });
  if (error) throw error;
  return data as OinSettings;
}

export async function fetchOverview(): Promise<OinOverview> {
  const { data, error } = await supabase.rpc('oin_network_overview');
  if (error) throw error;
  return data as OinOverview;
}

export async function fetchMyCases(limit = 100): Promise<OinCase[]> {
  const { data, error } = await supabase.from('oin_case_records').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data as OinCase[]) ?? [];
}

export async function matureMyCases(): Promise<number> {
  const { data, error } = await supabase.rpc('oin_mature_my_cases');
  if (error) throw error;
  return (data as number) ?? 0;
}

export async function fetchEquipmentOptions(): Promise<EquipmentOption[]> {
  const { data, error } = await supabase.from('equipment').select('equipment_type, make, model').limit(300);
  if (error) throw error;
  return (data as EquipmentOption[]) ?? [];
}

/** Completed jobs (last 180 days) that have not been captured yet, each with its first linked equipment. */
export async function fetchCapturableJobs(limit = 40): Promise<CapturableJob[]> {
  const since = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, customer_name, service_type, completed_at, latitude, notes')
    .eq('job_status', 'completed')
    .gte('completed_at', since)
    .order('completed_at', { ascending: false })
    .limit(limit * 3);
  if (error) throw error;
  const rows = (jobs as Omit<CapturableJob, 'equipment'>[]) ?? [];
  if (rows.length === 0) return [];

  const ids = rows.map((j) => j.id);
  const [{ data: captured, error: capErr }, { data: links, error: linkErr }] = await Promise.all([
    supabase.from('oin_case_records').select('job_id').in('job_id', ids),
    supabase.from('job_equipment').select('job_id, equipment:equipment(id, equipment_type, make, model)').in('job_id', ids),
  ]);
  if (capErr) throw capErr;
  if (linkErr) throw linkErr;

  const done = new Set(((captured as { job_id: string }[]) ?? []).map((c) => c.job_id));
  const eqByJob = new Map<string, CapturableJob['equipment']>();
  for (const l of (links as unknown as { job_id: string; equipment: CapturableJob['equipment'] }[]) ?? []) {
    if (!eqByJob.has(l.job_id)) eqByJob.set(l.job_id, l.equipment);
  }

  return rows
    .filter((j) => !done.has(j.id))
    .slice(0, limit)
    .map((j) => ({ ...j, equipment: eqByJob.get(j.id) ?? null }));
}

export interface RecordCaseInput {
  jobId: string;
  symptoms: string[];
  failureMode: string;
  action: string;
  parts: string[];
  equipmentId?: string | null;
  predictedSuccess?: number | null;
  predictedAction?: string | null;
}

export async function recordCase(input: RecordCaseInput): Promise<OinCase> {
  const { data, error } = await supabase.rpc('oin_record_case', {
    p_job_id: input.jobId,
    p_symptoms: input.symptoms,
    p_failure_mode: input.failureMode,
    p_action: input.action,
    p_parts: input.parts,
    p_equipment_id: input.equipmentId ?? null,
    p_predicted_success: input.predictedSuccess ?? null,
    p_predicted_action: input.predictedAction ?? null,
  });
  if (error) throw error;
  return data as OinCase;
}

export interface RecommendInput {
  trade: OinTrade;
  equipmentType: string;
  make: string;
  model: string;
  climate: ClimateBand;
  symptoms: string[];
  failureMode?: string | null;
}

export async function recommend(input: RecommendInput): Promise<OinRecommendResult> {
  const { data, error } = await supabase.rpc('oin_recommend', {
    p_trade: input.trade,
    p_equipment_type: input.equipmentType,
    p_make: input.make,
    p_model: input.model,
    p_climate_band: input.climate,
    p_symptoms: input.symptoms,
    p_failure_mode: input.failureMode ?? null,
  });
  if (error) throw error;
  return data as OinRecommendResult;
}
