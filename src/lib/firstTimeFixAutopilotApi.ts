/**
 * Vireek First-Time-Fix Autopilot - data access.
 *
 * Thin typed wrappers over Supabase. Scoping is enforced by RLS
 * (see 20270106000000_first_time_fix_autopilot.sql). Optional datasets degrade
 * to empty so the autopilot keeps working with whatever data exists.
 */

import { supabase, type Job, type ReviewRequest, type TeamMember } from '@/lib/supabase';
import { computeSkillGraph } from '@/lib/technicianSkillGraph';
import { buildStockFitMap, fetchStockFit, listJobSourcing } from '@/lib/truckStock';
import {
  DEFAULT_THRESHOLD,
  type AutopilotData,
  type DiagnosisRow,
  type Enforcement,
  type EquipmentRow,
  type JobEquipmentLink,
  type Prediction,
  type PredictionRecord,
  type TechnicianToolRow,
  type ToolRequirementRow,
} from '@/lib/firstTimeFixAutopilot';

export interface FtfSettings {
  threshold: number;
  enforcement: Enforcement;
}

export const DEFAULT_SETTINGS: FtfSettings = { threshold: DEFAULT_THRESHOLD, enforcement: 'warn' };

const PAGE = 1000;
const MAX_ROWS = 5000;

async function optional<T>(query: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  try {
    const { data, error } = await query;
    return error ? [] : (data ?? []);
  } catch {
    return [];
  }
}

async function fetchJobs(): Promise<Job[]> {
  const cutoff = new Date(Date.now() - 400 * 86400000).toISOString();
  const rows: Job[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from('jobs')
      .select('*')
      .or(`job_status.eq.scheduled,scheduled_datetime.gte.${cutoff},completed_at.gte.${cutoff}`)
      .order('scheduled_datetime', { ascending: false, nullsFirst: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data as Job[]) ?? [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

export async function loadAutopilotData(): Promise<AutopilotData> {
  const now = new Date();
  const [jobs, teamRes, reviews] = await Promise.all([
    fetchJobs(),
    supabase.from('team_members').select('*').eq('role', 'technician').eq('invite_status', 'active'),
    optional<ReviewRequest>(supabase.from('review_requests').select('*').not('rating', 'is', null)),
  ]);
  if (teamRes.error) throw teamRes.error;
  const technicians = (teamRes.data as TeamMember[]) ?? [];

  const upcomingIds = jobs.filter((j) => j.job_status === 'scheduled').map((j) => j.id);
  const [stockRows, sourcing, diagnoses, jobEquipment, equipment, toolRequirements, technicianTools] = await Promise.all([
    fetchStockFit(upcomingIds),
    listJobSourcing().catch(() => []),
    optional<DiagnosisRow>(
      supabase.from('diagnosis_sessions').select('job_id, confidence, created_at').not('job_id', 'is', null).order('created_at', { ascending: false }).limit(2000),
    ),
    optional<JobEquipmentLink>(supabase.from('job_equipment').select('job_id, equipment_id').limit(5000)),
    optional<EquipmentRow>(supabase.from('equipment').select('id, install_date, expected_lifespan_years, status').limit(5000)),
    optional<ToolRequirementRow>(supabase.from('service_tool_requirements').select('service_type, tool_name')),
    optional<TechnicianToolRow>(supabase.from('technician_tools').select('team_member_id, tool_name')),
  ]);

  return {
    jobs,
    technicians,
    graph: computeSkillGraph(jobs, reviews, technicians, now),
    stockFit: buildStockFitMap(stockRows),
    sourcing,
    diagnoses,
    jobEquipment,
    equipment,
    toolRequirements,
    technicianTools,
    now,
  };
}

// ---------------- settings ----------------

export async function fetchSettings(): Promise<FtfSettings> {
  const { data, error } = await supabase.from('ftf_settings').select('threshold, enforcement').maybeSingle();
  if (error || !data) return DEFAULT_SETTINGS;
  return { threshold: Number(data.threshold), enforcement: data.enforcement as Enforcement };
}

export async function saveSettings(ownerId: string, s: FtfSettings): Promise<void> {
  const { error } = await supabase
    .from('ftf_settings')
    .upsert({ account_owner_id: ownerId, threshold: s.threshold, enforcement: s.enforcement, updated_at: new Date().toISOString() }, { onConflict: 'account_owner_id' });
  if (error) throw error;
}

// ---------------- tools ----------------

export async function addToolRequirement(ownerId: string, serviceType: string, toolName: string): Promise<void> {
  const { error } = await supabase.from('service_tool_requirements').insert({ account_owner_id: ownerId, service_type: serviceType.trim(), tool_name: toolName.trim() });
  if (error) throw error;
}

export async function removeToolRequirement(serviceType: string, toolName: string): Promise<void> {
  const { error } = await supabase.from('service_tool_requirements').delete().eq('service_type', serviceType).eq('tool_name', toolName);
  if (error) throw error;
}

export async function addTechnicianTool(ownerId: string, teamMemberId: string, toolName: string): Promise<void> {
  const { error } = await supabase.from('technician_tools').insert({ account_owner_id: ownerId, team_member_id: teamMemberId, tool_name: toolName.trim() });
  if (error) throw error;
}

export async function removeTechnicianTool(teamMemberId: string, toolName: string): Promise<void> {
  const { error } = await supabase.from('technician_tools').delete().eq('team_member_id', teamMemberId).eq('tool_name', toolName);
  if (error) throw error;
}

// ---------------- predictions ----------------

export async function fetchPredictions(): Promise<PredictionRecord[]> {
  const rows = await optional<PredictionRecord>(supabase.from('ftf_predictions').select('job_id, technician_id, probability, verdict').limit(5000));
  return rows;
}

export async function savePredictions(ownerId: string, items: { jobId: string; technicianId: string; prediction: Prediction }[]): Promise<void> {
  if (items.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await supabase.from('ftf_predictions').upsert(
    items.map(({ jobId, technicianId, prediction }) => ({
      account_owner_id: ownerId,
      job_id: jobId,
      technician_id: technicianId,
      probability: prediction.probability,
      verdict: prediction.verdict,
      confidence: prediction.confidence,
      factors: prediction.factors.map((f) => ({ key: f.key, status: f.status, impactPts: f.impactPts })),
      model_version: 1,
      updated_at: now,
    })),
    { onConflict: 'job_id,technician_id' },
  );
  if (error) throw error;
}

// ---------------- applying autofix steps ----------------

export async function applyReassign(jobId: string, technicianId: string): Promise<void> {
  const { data, error } = await supabase.rpc('assign_technician_to_job', { p_job_id: jobId, p_technician_id: technicianId });
  if (error || data?.status !== 'assigned') throw new Error(data?.reason || 'Could not assign this job');
}

export async function applyDuration(jobId: string, minutes: number): Promise<void> {
  const { error } = await supabase.from('jobs').update({ duration_minutes: minutes }).eq('id', jobId);
  if (error) throw error;
}
