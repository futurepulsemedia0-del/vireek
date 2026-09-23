import { supabase } from '@/lib/supabase';

// ============================================================
// RETENTION POLICIES
// ============================================================

export interface RetentionPolicy {
  id: string;
  user_id: string;
  dataset: string;
  retention_days: number | null;
  auto_delete_enabled: boolean;
  anonymize_instead_of_delete: boolean;
  legal_hold: boolean;
  legal_hold_reason: string | null;
  last_swept_at: string | null;
  updated_at: string;
}

// Keep in sync with supabase/functions/_shared/compliance/ownedTables.ts.
export const GOVERNABLE_DATASETS = [
  { id: 'leads', label: 'Leads' },
  { id: 'calls', label: 'Calls & recordings' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'quotes', label: 'Quotes' },
  { id: 'payment_requests', label: 'Payment requests' },
  { id: 'ai_insights', label: 'AI insights' },
  { id: 'review_requests', label: 'Review requests' },
] as const;

export async function fetchRetentionPolicies(): Promise<RetentionPolicy[]> {
  const { data, error } = await supabase.from('data_retention_policies').select('*').order('dataset');
  if (error) throw error;
  return (data as RetentionPolicy[]) || [];
}

export async function saveRetentionPolicy(
  userId: string,
  dataset: string,
  patch: Partial<Pick<RetentionPolicy, 'retention_days' | 'auto_delete_enabled' | 'anonymize_instead_of_delete' | 'legal_hold' | 'legal_hold_reason'>>,
  existingId?: string
): Promise<void> {
  const payload = { user_id: userId, dataset, ...patch, updated_at: new Date().toISOString() };
  const query = existingId
    ? supabase.from('data_retention_policies').update(payload).eq('id', existingId)
    : supabase.from('data_retention_policies').insert(payload);
  const { error } = await query;
  if (error) throw error;
  await supabase.rpc('log_audit_event', {
    p_user_id: userId,
    p_action: 'updated_retention_policy',
    p_target_table: 'data_retention_policies',
    p_target_id: existingId ?? null,
  });
}

// ============================================================
// DELETION REQUESTS
// ============================================================

export type DeletionRequestType = 'full_account' | 'customer_record' | 'dataset';
export type DeletionRequestStatus = 'grace_period' | 'processing' | 'completed' | 'cancelled' | 'blocked_legal_hold';

export interface DeletionRequest {
  id: string;
  user_id: string;
  requested_by: string | null;
  request_type: DeletionRequestType;
  target_customer_id: string | null;
  target_dataset: string | null;
  reason: string | null;
  status: DeletionRequestStatus;
  grace_period_days: number;
  scheduled_for: string;
  completed_at: string | null;
  result: Record<string, number> | null;
  created_at: string;
}

export async function fetchDeletionRequests(): Promise<DeletionRequest[]> {
  const { data, error } = await supabase.from('deletion_requests').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return (data as DeletionRequest[]) || [];
}

export async function createDeletionRequest(params: {
  userId: string;
  requestType: DeletionRequestType;
  targetCustomerId?: string;
  targetDataset?: string;
  reason?: string;
  gracePeriodDays?: number;
}): Promise<DeletionRequest> {
  const gracePeriodDays = params.gracePeriodDays ?? 14;
  const scheduledFor = new Date(Date.now() + gracePeriodDays * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('deletion_requests')
    .insert({
      user_id: params.userId,
      requested_by: (await supabase.auth.getUser()).data.user?.id ?? null,
      request_type: params.requestType,
      target_customer_id: params.targetCustomerId ?? null,
      target_dataset: params.targetDataset ?? null,
      reason: params.reason ?? null,
      grace_period_days: gracePeriodDays,
      scheduled_for: scheduledFor,
    })
    .select()
    .single();
  if (error) throw error;
  await supabase.rpc('log_audit_event', {
    p_user_id: params.userId,
    p_action: `requested_deletion:${params.requestType}`,
    p_target_table: 'deletion_requests',
    p_target_id: data.id,
  });
  return data as DeletionRequest;
}

export async function cancelDeletionRequest(id: string): Promise<void> {
  const { error } = await supabase.from('deletion_requests').update({ status: 'cancelled' }).eq('id', id);
  if (error) throw error;
}

// ============================================================
// CONSENT RECORDS
// ============================================================

export type ConsentType = 'call_recording' | 'marketing_sms' | 'marketing_email' | 'data_processing';

export interface ConsentRecord {
  id: string;
  user_id: string;
  customer_id: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  consent_type: ConsentType;
  granted: boolean;
  source: 'ivr_verbal' | 'web_form' | 'manual' | 'import' | 'sms_reply';
  notes: string | null;
  expires_at: string | null;
  created_at: string;
}

export async function fetchConsentRecords(limit = 200): Promise<ConsentRecord[]> {
  const { data, error } = await supabase
    .from('consent_records')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as ConsentRecord[]) || [];
}

export async function recordConsent(params: {
  userId: string;
  consentType: ConsentType;
  granted: boolean;
  customerId?: string;
  contactPhone?: string;
  contactEmail?: string;
  source?: ConsentRecord['source'];
  notes?: string;
}): Promise<void> {
  const { error } = await supabase.from('consent_records').insert({
    user_id: params.userId,
    customer_id: params.customerId ?? null,
    contact_phone: params.contactPhone ?? null,
    contact_email: params.contactEmail ?? null,
    consent_type: params.consentType,
    granted: params.granted,
    source: params.source ?? 'manual',
    notes: params.notes ?? null,
  });
  if (error) throw error;
}

// ============================================================
// PII FIELD REGISTRY (read-only)
// ============================================================

export interface PiiFieldEntry {
  id: string;
  table_name: string;
  column_name: string;
  classification: string;
  sensitivity: 'standard' | 'high' | 'critical';
  masking_strategy: string;
  notes: string | null;
}

export async function fetchPiiRegistry(): Promise<PiiFieldEntry[]> {
  const { data, error } = await supabase
    .from('pii_field_registry')
    .select('*')
    .order('sensitivity', { ascending: false })
    .order('table_name');
  if (error) throw error;
  return (data as PiiFieldEntry[]) || [];
}

// ============================================================
// DR HEALTH (backup runs + restore drills, read-only)
// ============================================================

export interface BackupRun {
  id: string;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'completed' | 'failed';
  storage_path: string | null;
  size_bytes: number | null;
  table_row_counts: Record<string, number>;
  error_message: string | null;
}

export interface RestoreDrill {
  id: string;
  backup_run_id: string | null;
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'passed' | 'failed';
  rto_seconds: number | null;
  row_count_mismatches: Record<string, unknown>;
  notes: string | null;
}

export async function fetchRecentBackupRuns(limit = 10): Promise<BackupRun[]> {
  const { data, error } = await supabase
    .from('platform_backup_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as BackupRun[]) || [];
}

export async function fetchRecentRestoreDrills(limit = 10): Promise<RestoreDrill[]> {
  const { data, error } = await supabase
    .from('platform_restore_drills')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as RestoreDrill[]) || [];
}

export interface DrHealthSummary {
  lastBackup: BackupRun | null;
  lastBackupAgeHours: number | null;
  lastDrill: RestoreDrill | null;
  drillPassed: boolean | null;
}

export async function fetchDrHealthSummary(): Promise<DrHealthSummary> {
  const [backups, drills] = await Promise.all([fetchRecentBackupRuns(1), fetchRecentRestoreDrills(1)]);
  const lastBackup = backups[0] ?? null;
  const lastDrill = drills[0] ?? null;
  return {
    lastBackup,
    lastBackupAgeHours: lastBackup?.completed_at
      ? (Date.now() - new Date(lastBackup.completed_at).getTime()) / 3_600_000
      : null,
    lastDrill,
    drillPassed: lastDrill ? lastDrill.status === 'passed' : null,
  };
}
