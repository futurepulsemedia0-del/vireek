import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type {
  ExpertRiskRow,
  KceEvidence,
  KceManualSourceType,
  KceOverview,
  KceRule,
  KceSourceType,
  KceVersion,
} from '@/lib/knowledgeCapture';

const MEDIA_BUCKET = 'kce-media';
export const MAX_MEDIA_BYTES = 14 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Edge function
// ---------------------------------------------------------------------------

async function invokeExtract<T>(payload: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('kce-extract', { body: payload });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const body = (await error.context.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? 'The request failed. Please try again.');
    }
    throw new Error('Could not reach the capture service. Check your connection and try again.');
  }
  return data as T;
}

export interface ScanProgress {
  enqueued: number;
  processed: number;
  rulesCreated: number;
  failed: number;
  remaining: number;
  quotaExhausted: boolean;
}

interface BatchResponse {
  processed: number;
  extracted: number;
  no_knowledge: number;
  failed: number;
  rules_created: number;
  quota_exhausted: boolean;
  remaining: number;
}

/**
 * Harvest every new source, then work the queue in small batches (each batch is bounded so a
 * single request never runs long). Stops when the queue is empty, the hourly AI quota is hit,
 * or a batch makes no progress.
 */
export async function runCaptureScan(
  onProgress?: (p: ScanProgress) => void,
  maxBatches = 40,
): Promise<ScanProgress> {
  const scan = await invokeExtract<{ enqueued: number; pending: number }>({ action: 'scan' });
  const progress: ScanProgress = {
    enqueued: scan.enqueued,
    processed: 0,
    rulesCreated: 0,
    failed: 0,
    remaining: scan.pending,
    quotaExhausted: false,
  };
  onProgress?.({ ...progress });

  for (let i = 0; i < maxBatches && progress.remaining > 0; i++) {
    const batch = await invokeExtract<BatchResponse>({ action: 'process_batch', limit: 6 });
    progress.processed += batch.processed;
    progress.rulesCreated += batch.rules_created;
    progress.failed += batch.failed;
    progress.remaining = batch.remaining;
    progress.quotaExhausted = batch.quota_exhausted;
    onProgress?.({ ...progress });
    if (batch.quota_exhausted || batch.processed === 0) break;
  }
  return progress;
}

export interface IngestInput {
  sourceType: KceManualSourceType;
  notes?: string;
  mediaPath?: string;
  jobId?: string;
}

export interface IngestResult {
  ok: boolean;
  queued?: boolean;
  message?: string;
  outcome?: 'extracted' | 'no_knowledge';
  rules_created?: number;
}

export function ingestCapture(input: IngestInput): Promise<IngestResult> {
  return invokeExtract<IngestResult>({ action: 'ingest', ...input });
}

export function retryCapture(
  captureId: string,
): Promise<{ ok: boolean; outcome: string; rules_created: number }> {
  return invokeExtract({ action: 'process', captureId });
}

export async function uploadCaptureMedia(file: File): Promise<string> {
  if (file.size > MAX_MEDIA_BYTES)
    throw new Error('That file is over 14 MB. Trim it or record a shorter clip.');
  if (!file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
    throw new Error('Only audio or video files can be captured.');
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('You need to be signed in.');

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'recording';
  const path = `${user.id}/${Date.now()}-${safeName}`;
  const { error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error('The upload failed. Please try again.');
  return path;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchOverview(): Promise<KceOverview> {
  const { data, error } = await supabase.rpc('kce_get_overview');
  if (error) throw error;
  return (data ?? { is_reviewer: false, status_counts: {} }) as KceOverview;
}

export async function fetchRules(): Promise<KceRule[]> {
  const { data, error } = await supabase
    .from('kce_rules')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(300);
  if (error) throw error;
  return (data ?? []) as KceRule[];
}

export interface RuleDetail {
  evidence: KceEvidence[];
  versions: KceVersion[];
}

export async function fetchRuleDetail(ruleId: string): Promise<RuleDetail> {
  const [evidence, versions] = await Promise.all([
    supabase
      .from('kce_evidence')
      .select(
        'id, excerpt, specificity, contributor_id, created_at, capture:kce_captures(source_type)',
      )
      .eq('rule_id', ruleId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('kce_rule_versions')
      .select('id, version, snapshot, change_note, created_at')
      .eq('rule_id', ruleId)
      .order('version', { ascending: false })
      .limit(50),
  ]);
  if (evidence.error) throw evidence.error;
  if (versions.error) throw versions.error;
  return {
    evidence: (evidence.data ?? []) as unknown as KceEvidence[],
    versions: (versions.data ?? []) as KceVersion[],
  };
}

export interface CaptureRow {
  id: string;
  source_type: KceSourceType;
  status: 'pending' | 'processing' | 'extracted' | 'no_knowledge' | 'failed';
  rules_found: number;
  error_message: string | null;
  created_at: string;
}

export async function fetchRecentCaptures(limit = 25): Promise<CaptureRow[]> {
  const { data, error } = await supabase
    .from('kce_captures')
    .select('id, source_type, status, rules_found, error_message, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as CaptureRow[];
}

export async function fetchExpertRisk(): Promise<ExpertRiskRow[]> {
  const { data, error } = await supabase.rpc('kce_get_expert_risk');
  if (error) throw error;
  return (data ?? []) as ExpertRiskRow[];
}

export async function fetchCanReview(): Promise<boolean> {
  const { data, error } = await supabase.rpc('kce_can_review');
  if (error) throw error;
  return data === true;
}

// ---------------------------------------------------------------------------
// Writes (all go through SECURITY DEFINER RPCs; the database enforces every rule)
// ---------------------------------------------------------------------------

export interface RuleEdits {
  title?: string;
  equipment_make?: string;
  equipment_model?: string;
  symptoms?: string[];
  condition_summary?: string;
  likely_cause?: string;
  recommended_action?: string;
  caveats?: string;
}

export async function reviewRule(
  ruleId: string,
  action: 'start_review' | 'approve' | 'reject' | 'revise',
  note?: string,
  edits?: RuleEdits,
): Promise<KceRule> {
  const { data, error } = await supabase.rpc('kce_review_rule', {
    p_rule_id: ruleId,
    p_action: action,
    p_note: note?.trim() || null,
    p_edits: edits && Object.keys(edits).length > 0 ? edits : null,
  });
  if (error) throw new Error(error.message);
  return data as KceRule;
}

export async function deployRule(ruleId: string, note?: string): Promise<KceRule> {
  const { data, error } = await supabase.rpc('kce_deploy_rule', {
    p_rule_id: ruleId,
    p_note: note?.trim() || null,
  });
  if (error) throw new Error(error.message);
  return data as KceRule;
}

export async function retireRule(ruleId: string, reason: string): Promise<KceRule> {
  const { data, error } = await supabase.rpc('kce_retire_rule', {
    p_rule_id: ruleId,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
  return data as KceRule;
}

export interface DeployedRuleHit {
  id: string;
  title: string;
  equipment_make: string | null;
  equipment_model: string | null;
  symptoms: string[];
  condition_summary: string;
  likely_cause: string;
  recommended_action: string;
  caveats: string | null;
  confidence_score: number;
  applied_count: number;
  success_count: number;
  deployed_version: number | null;
  needs_revalidation: boolean;
  relevance: number;
}

export async function searchDeployedRules(
  query: string,
  make?: string,
  model?: string,
  limit = 5,
): Promise<DeployedRuleHit[]> {
  const { data, error } = await supabase.rpc('kce_search_deployed_rules', {
    p_query: query || null,
    p_make: make || null,
    p_model: model || null,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as DeployedRuleHit[];
}

export interface ApplicationResult {
  confidence_score: number;
  applied_count: number;
  success_count: number;
  needs_revalidation: boolean;
}

export async function recordApplication(
  ruleId: string,
  jobId: string,
  outcome: 'resolved' | 'not_resolved',
): Promise<ApplicationResult> {
  const { data, error } = await supabase.rpc('kce_record_application', {
    p_rule_id: ruleId,
    p_job_id: jobId,
    p_outcome: outcome,
  });
  if (error) throw new Error(error.message);
  return data as ApplicationResult;
}

export async function setExpertProfile(
  teamMemberId: string,
  expectedDeparture: string | null,
  notes: string,
): Promise<void> {
  const { error } = await supabase.rpc('kce_set_expert_profile', {
    p_team_member_id: teamMemberId,
    p_expected_departure: expectedDeparture || null,
    p_notes: notes || null,
  });
  if (error) throw new Error(error.message);
}

export async function setAutoCapture(enabled: boolean): Promise<void> {
  const { error } = await supabase.rpc('kce_set_auto_capture', { p_enabled: enabled });
  if (error) throw new Error(error.message);
}
