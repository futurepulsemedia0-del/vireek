/**
 * AI Diagnosis-to-Resolution Copilot - client domain logic.
 *
 * A technician's symptoms, meter/gauge readings, equipment info and optional
 * photos go to the `diagnosis-copilot` Edge Function, which returns ranked
 * probable causes, an ordered diagnostic test plan, likely parts, safety
 * warnings and a repair path. Every run is saved to `diagnosis_sessions`.
 *
 * Server counterpart: supabase/functions/diagnosis-copilot (index.ts,
 * normalize.ts). Keep the types below in sync with normalize.ts.
 */

import { supabase } from '@/lib/supabase';

export type DiagnosisSeverity = 'low' | 'medium' | 'high' | 'emergency';
export type PartNecessity = 'likely' | 'possible' | 'if_confirmed';

export interface ProbableCause {
  cause: string;
  likelihood: number;
  reasoning: string;
}

export interface DiagnosticTestStep {
  step: string;
  tool_needed: string;
  expected_result: string;
}

export interface DiagnosisPartNeeded {
  name: string;
  quantity: number;
  necessity: PartNecessity;
}

export interface DiagnosisResult {
  summary: string;
  probable_causes: ProbableCause[];
  test_steps: DiagnosticTestStep[];
  safety_warnings: string[];
  parts_needed: DiagnosisPartNeeded[];
  repair_path: string[];
  severity: DiagnosisSeverity;
  confidence: number;
  missing_info: string[];
  recommend_specialist: boolean;
  warnings: string[];
  session_id: string | null;
  model: string;
  inputs: { photos: number };
}

export interface DiagnosisSessionRow {
  id: string;
  job_id: string | null;
  equipment_label: string | null;
  symptoms: string;
  severity: DiagnosisSeverity;
  confidence: number | null;
  ai_result: DiagnosisResult;
  created_at: string;
}

export const DIAGNOSIS_LIMITS = { photos: 4, symptomsChars: 2000, readingsChars: 1000 } as const;

export const DIAGNOSIS_SEVERITY_META: Record<DiagnosisSeverity, { label: string; className: string }> = {
  low: { label: 'Low priority', className: 'bg-bg-tertiary text-text-secondary' },
  medium: { label: 'Medium priority', className: 'bg-accent/10 text-accent' },
  high: { label: 'High priority', className: 'bg-warning-500/10 text-warning-500' },
  emergency: { label: 'Emergency', className: 'bg-danger-500/10 text-danger-500' },
};

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

/** Uploads one equipment photo to the caller's own folder in the private diagnosis-copilot-photos bucket. */
export async function uploadDiagnosisPhoto(userId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from('diagnosis-copilot-photos').upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

export async function analyzeDiagnosis(input: {
  symptoms: string;
  meterReadings?: string;
  equipmentLabel?: string;
  jobId?: string | null;
  equipmentId?: string | null;
  photoPaths?: string[];
}): Promise<DiagnosisResult> {
  const { data, error } = await supabase.functions.invoke('diagnosis-copilot', {
    body: {
      symptoms: input.symptoms.trim().slice(0, DIAGNOSIS_LIMITS.symptomsChars),
      meterReadings: input.meterReadings?.trim().slice(0, DIAGNOSIS_LIMITS.readingsChars) ?? '',
      equipmentLabel: input.equipmentLabel?.trim() ?? '',
      jobId: input.jobId ?? null,
      equipmentId: input.equipmentId ?? null,
      photoPaths: (input.photoPaths ?? []).slice(0, DIAGNOSIS_LIMITS.photos),
    },
  });
  if (error) {
    throw new Error(await functionErrorMessage(error, 'Could not reach the AI diagnostic copilot. Check your connection and try again.'));
  }
  if (data?.error) throw new Error(String(data.error));
  return data as DiagnosisResult;
}

/** Recent diagnosis history for the signed-in technician (RLS scopes this to their own rows). */
export async function fetchDiagnosisHistory(limit = 20): Promise<DiagnosisSessionRow[]> {
  const { data, error } = await supabase
    .from('diagnosis_sessions')
    .select('id, job_id, equipment_label, symptoms, severity, confidence, ai_result, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as DiagnosisSessionRow[]) ?? [];
}
