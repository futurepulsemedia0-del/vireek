import { supabase } from '@/lib/supabase';

export interface QualityIssue { photo_index: number; issue: string; severity: 'low' | 'medium' | 'high' }
export interface SafetyFlag { photo_index: number; hazard: string; severity: 'low' | 'medium' | 'high' }

export interface JobEvidenceVerdict {
  check_id: string;
  verdict: 'pass' | 'needs_attention' | 'fail';
  evidence_completeness: number;
  quality_issues: QualityIssue[];
  safety_flags: SafetyFlag[];
  detected_serials: string[];
  summary: string;
}

export const MAX_EVIDENCE_PHOTOS = 6;

/** Uploads one job-evidence photo to the caller's own folder in the private job-evidence-photos bucket. */
export async function uploadEvidencePhoto(userId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from('job-evidence-photos').upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

/** Sends already-uploaded photo paths for a job to the AI safety/quality checker. */
export async function verifyJobEvidence(jobId: string, storagePaths: string[]): Promise<JobEvidenceVerdict> {
  const { data, error } = await supabase.functions.invoke('verify-job-evidence', { body: { jobId, storagePaths } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as JobEvidenceVerdict;
}
