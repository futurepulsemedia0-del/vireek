/**
 * Vireek Operational Experimentation Platform - data access.
 *
 * Thin typed wrappers over Supabase. Scoping and integrity (locked designs, forward-only
 * status, server-side randomization) are enforced by the database, see
 * 20270210000000_operational_experimentation.sql.
 */

import { supabase, type TeamMember } from '@/lib/supabase';
import type {
  Alpha,
  Assignment,
  Decision,
  DraftInput,
  ExpJob,
  ExperimentCategory,
  ExperimentConfig,
  ExperimentStatus,
  ResultSnapshot,
} from '@/lib/opsExperiments';

export interface ExperimentRow extends ExperimentConfig {
  title: string;
  category: ExperimentCategory;
  hypothesis: string;
  intervention: string;
  comparison_desc: string;
  decision: Decision | null;
  learning: string | null;
  result_snapshot: ResultSnapshot | null;
  created_at: string;
}

const PAGE = 1000;
const MAX_ROWS = 10000;
const LOOKBACK_DAYS = 450;

const JOB_COLUMNS =
  'id, service_type, job_status, scheduled_datetime, created_at, completed_at, invoice_amount, sla_response_hours, assigned_technician_id, is_rework, rework_of_job_id';

function normalize(row: Record<string, unknown>): ExperimentRow {
  return {
    ...(row as unknown as ExperimentRow),
    alpha: Number(row.alpha) as Alpha,
    min_detectable_effect: Number(row.min_detectable_effect),
    guardrail_tolerance: row.guardrail_tolerance === null || row.guardrail_tolerance === undefined ? null : Number(row.guardrail_tolerance),
    duration_days: Number(row.duration_days),
    treatment_share: Number(row.treatment_share),
    maturity_days: Number(row.maturity_days),
    service_types: (row.service_types as string[] | null) ?? [],
  };
}

export async function listExperiments(): Promise<ExperimentRow[]> {
  const { data, error } = await supabase.from('ops_experiments').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  return ((data as Record<string, unknown>[]) ?? []).map(normalize);
}

export async function fetchAssignments(experimentId: string): Promise<Assignment[]> {
  const rows: Assignment[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from('ops_experiment_assignments')
      .select('unit_type, unit_id, arm')
      .eq('experiment_id', experimentId)
      .order('assigned_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data as Assignment[]) ?? [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

export async function fetchJobsForAnalysis(): Promise<ExpJob[]> {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const rows: ExpJob[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from('jobs')
      .select(JOB_COLUMNS)
      .or(`job_status.eq.scheduled,created_at.gte.${cutoff}`)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data as unknown as ExpJob[]) ?? [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

export async function fetchTechnicians(): Promise<Pick<TeamMember, 'id' | 'member_name' | 'member_email'>[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, member_name, member_email')
    .eq('role', 'technician')
    .eq('invite_status', 'active')
    .order('member_name', { ascending: true });
  if (error) throw error;
  return (data as Pick<TeamMember, 'id' | 'member_name' | 'member_email'>[]) ?? [];
}

export interface NewExperiment extends DraftInput {
  category: ExperimentCategory;
  service_types: string[];
  alpha: Alpha;
}

export async function createExperiment(input: NewExperiment): Promise<string> {
  const { data, error } = await supabase
    .from('ops_experiments')
    .insert({
      title: input.title.trim(),
      category: input.category,
      hypothesis: input.hypothesis.trim(),
      intervention: input.intervention.trim(),
      comparison_desc: input.comparison_desc.trim(),
      design: input.design,
      primary_metric: input.primary_metric,
      guardrail_metric: input.guardrail_metric,
      guardrail_tolerance: input.guardrail_metric ? input.guardrail_tolerance : null,
      min_detectable_effect: input.min_detectable_effect,
      alpha: input.alpha,
      duration_days: input.duration_days,
      treatment_share: input.treatment_share,
      service_types: input.service_types,
      maturity_days: input.maturity_days,
    })
    .select('id')
    .single();
  if (error) throw error;
  const id = (data as { id: string }).id;

  if (input.design === 'comparison') {
    const rows = [
      ...input.treatmentTechnicians.map((unit_id) => ({ experiment_id: id, unit_type: 'technician', unit_id, arm: 'treatment' })),
      ...input.comparisonTechnicians.map((unit_id) => ({ experiment_id: id, unit_type: 'technician', unit_id, arm: 'control' })),
    ];
    const { error: armError } = await supabase.from('ops_experiment_assignments').insert(rows);
    if (armError) {
      // Do not leave a half-built draft behind.
      await supabase.from('ops_experiments').delete().eq('id', id);
      throw armError;
    }
  }
  return id;
}

async function setStatus(id: string, from: ExperimentStatus, to: ExperimentStatus): Promise<void> {
  const { data, error } = await supabase.from('ops_experiments').update({ status: to }).eq('id', id).eq('status', from).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('This experiment changed in the meantime. Refresh and try again.');
}

export const startExperiment = (id: string) => setStatus(id, 'draft', 'running');

export async function concludeExperiment(id: string, decision: Decision, learning: string, snapshot: ResultSnapshot): Promise<void> {
  const { data, error } = await supabase
    .from('ops_experiments')
    .update({ status: 'concluded', decision, learning: learning.trim(), result_snapshot: snapshot })
    .eq('id', id)
    .eq('status', 'running')
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('This experiment changed in the meantime. Refresh and try again.');
}

export async function archiveExperiment(id: string, from: ExperimentStatus): Promise<void> {
  await setStatus(id, from, 'archived');
}

export async function deleteDraft(id: string): Promise<void> {
  const { error } = await supabase.from('ops_experiments').delete().eq('id', id).eq('status', 'draft');
  if (error) throw error;
}

export async function updateLearning(id: string, learning: string): Promise<void> {
  const { error } = await supabase.from('ops_experiments').update({ learning: learning.trim() }).eq('id', id).eq('status', 'concluded');
  if (error) throw error;
}

/** Enrolls jobs; the server decides the arm. Already-enrolled jobs are ignored. */
export async function enrollJobs(experimentId: string, jobIds: string[]): Promise<void> {
  for (let i = 0; i < jobIds.length; i += 500) {
    const chunk = jobIds.slice(i, i + 500).map((unit_id) => ({ experiment_id: experimentId, unit_type: 'job', unit_id }));
    const { error } = await supabase
      .from('ops_experiment_assignments')
      .upsert(chunk, { onConflict: 'experiment_id,unit_type,unit_id', ignoreDuplicates: true });
    if (error) throw error;
  }
}
