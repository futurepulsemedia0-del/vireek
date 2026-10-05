/**
 * Vireek Resolution Probability Engine - data access.
 *
 * Reuses the First-Time-Fix data loader for jobs, technicians, skill graph,
 * truck stock, tools and diagnoses (one source of truth), and adds the evidence
 * checks RPE needs. Scoping is enforced by RLS
 * (see 20270202000000_resolution_probability_engine.sql). Optional datasets
 * degrade to empty so the engine works with whatever data exists.
 */

import { supabase } from '@/lib/supabase';
import { loadAutopilotData } from '@/lib/firstTimeFixAutopilotApi';
import {
  DEFAULT_RPE_SETTINGS,
  RPE_MODEL_VERSION,
  type Assessment,
  type AssessmentRecord,
  type EvidenceCheckRow,
  type Recommendation,
  type ResolutionData,
  type RpeSettings,
} from '@/lib/resolutionProbability';

async function optional<T>(query: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  try {
    const { data, error } = await query;
    return error ? [] : (data ?? []);
  } catch {
    return [];
  }
}

export async function loadResolutionData(): Promise<ResolutionData> {
  const base = await loadAutopilotData();
  const since = new Date(base.now.getTime() - 120 * 86400000).toISOString();
  const evidence = await optional<EvidenceCheckRow>(
    supabase
      .from('job_evidence_checks')
      .select('job_id, verdict, evidence_completeness, quality_issues, safety_flags, resolved, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5000),
  );
  return { base, evidence };
}

// ---------------- settings ----------------

export async function fetchRpeSettings(): Promise<RpeSettings> {
  const { data, error } = await supabase.from('rpe_settings').select('threshold, floor, truck_roll_cost_cents').maybeSingle();
  if (error || !data) return DEFAULT_RPE_SETTINGS;
  return {
    threshold: Number(data.threshold),
    floor: Number(data.floor),
    truckRollCostCents: Number(data.truck_roll_cost_cents),
  };
}

export async function saveRpeSettings(ownerId: string, s: RpeSettings): Promise<void> {
  const { error } = await supabase.from('rpe_settings').upsert(
    {
      account_owner_id: ownerId,
      threshold: s.threshold,
      floor: s.floor,
      truck_roll_cost_cents: s.truckRollCostCents,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'account_owner_id' },
  );
  if (error) throw error;
}

// ---------------- saved assessments ----------------

export async function fetchAssessmentRecords(): Promise<AssessmentRecord[]> {
  return optional<AssessmentRecord>(supabase.from('rpe_assessments').select('job_id, technician_id, probability').limit(5000));
}

export interface AssessmentToSave {
  jobId: string;
  technicianId: string;
  assessment: Assessment;
  recommendation: Recommendation;
}

export async function saveAssessments(ownerId: string, items: AssessmentToSave[]): Promise<void> {
  if (items.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await supabase.from('rpe_assessments').upsert(
    items.map(({ jobId, technicianId, assessment, recommendation }) => ({
      account_owner_id: ownerId,
      job_id: jobId,
      technician_id: technicianId,
      probability: assessment.probability,
      verdict: assessment.verdict,
      confidence: assessment.confidence,
      recommendation: recommendation.headline,
      dimensions: assessment.dimensions.map((d) => ({ key: d.key, status: d.status, impactPts: d.impactPts })),
      model_version: RPE_MODEL_VERSION,
      updated_at: now,
    })),
    { onConflict: 'job_id,technician_id' },
  );
  if (error) throw error;
}
