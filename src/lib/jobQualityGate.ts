/**
 * Job Quality Gate — client library.
 *
 * The real enforcement lives in the database (see
 * 20261126000000_job_quality_gate.sql — trg_enforce_job_quality_gate).
 * This file only reads the same report the trigger computes
 * (job_quality_gate_report, read-only RPC) so the UI can show live
 * ready/not-ready status, and writes the proof fields (notes, signature,
 * checklist) that feed into it. Nothing here can bypass the gate — the
 * database is the only source of truth.
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type QualityGateCategoryKey =
  | 'photos'
  | 'checklist'
  | 'part_usage'
  | 'signature'
  | 'serial_number'
  | 'notes'
  | 'safety_evidence';

export interface QualityGateCategory {
  required: boolean;
  satisfied: boolean;
  total?: number;
  done?: number;
  installed?: number;
}

export interface QualityGateReport {
  ready_to_close: boolean;
  gaps: QualityGateCategoryKey[];
  categories: Record<QualityGateCategoryKey, QualityGateCategory>;
}

export const QUALITY_GATE_LABELS: Record<QualityGateCategoryKey, string> = {
  photos: 'Job photos',
  checklist: 'Checklist',
  part_usage: 'Part usage confirmed',
  signature: 'Customer signature',
  serial_number: 'Equipment serial number',
  notes: 'Completion notes',
  safety_evidence: 'Safety evidence verified',
};

export interface ChecklistTemplateItem {
  id: string;
  service_type: string;
  item_label: string;
  sort_order: number;
}

export interface QualityRequirement {
  id: string;
  service_type: string;
  require_photos: boolean;
  require_checklist: boolean;
  require_part_usage: boolean;
  require_signature: boolean;
  require_serial_number: boolean;
  require_notes: boolean;
  require_safety_evidence: boolean;
}

// ============================================================
// ERROR PARSING — trigger raises "JOB_QUALITY_GATE_BLOCKED: photos,notes"
// ============================================================

const GATE_ERROR_PREFIX = 'JOB_QUALITY_GATE_BLOCKED:';

export function isQualityGateError(message: string | undefined | null): boolean {
  return !!message && message.includes(GATE_ERROR_PREFIX);
}

/** Turns the raw Postgres exception message into a friendly, labeled list. */
export function parseQualityGateError(message: string): string[] {
  const idx = message.indexOf(GATE_ERROR_PREFIX);
  if (idx === -1) return [];
  const raw = message.slice(idx + GATE_ERROR_PREFIX.length).trim();
  return raw
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => QUALITY_GATE_LABELS[k as QualityGateCategoryKey] ?? k);
}

// ============================================================
// LIVE REPORT
// ============================================================

export async function fetchQualityGateReport(jobId: string): Promise<QualityGateReport> {
  const { data, error } = await supabase.rpc('job_quality_gate_report', { p_job_id: jobId });
  if (error) throw error;
  return data as QualityGateReport;
}

// ============================================================
// PROOF WRITES
// ============================================================

export async function saveCompletionNotes(jobId: string, notes: string): Promise<void> {
  const { error } = await supabase.from('jobs').update({ completion_notes: notes }).eq('id', jobId);
  if (error) throw error;
}

export async function saveCustomerSignature(jobId: string, dataUrl: string, signedByName: string): Promise<void> {
  const { error } = await supabase
    .from('jobs')
    .update({
      customer_signature_data_url: dataUrl,
      customer_signature_name: signedByName || null,
      customer_signature_at: new Date().toISOString(),
    })
    .eq('id', jobId);
  if (error) throw error;
}

export async function clearCustomerSignature(jobId: string): Promise<void> {
  const { error } = await supabase
    .from('jobs')
    .update({ customer_signature_data_url: null, customer_signature_name: null, customer_signature_at: null })
    .eq('id', jobId);
  if (error) throw error;
}

// ============================================================
// CHECKLIST
// ============================================================

export async function fetchChecklistTemplates(serviceType: string): Promise<ChecklistTemplateItem[]> {
  const { data, error } = await supabase
    .from('job_quality_checklist_templates')
    .select('*')
    .eq('service_type', serviceType)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data as ChecklistTemplateItem[]) ?? [];
}

export async function fetchChecklistCompletions(jobId: string): Promise<Set<string>> {
  const { data, error } = await supabase.from('job_checklist_completions').select('template_item_id').eq('job_id', jobId);
  if (error) throw error;
  return new Set((data ?? []).map((r: { template_item_id: string }) => r.template_item_id));
}

export async function toggleChecklistItem(
  jobId: string,
  templateItemId: string,
  checked: boolean,
  completedBy: string | null,
): Promise<void> {
  if (checked) {
    const { error } = await supabase
      .from('job_checklist_completions')
      .upsert({ job_id: jobId, template_item_id: templateItemId, completed_by: completedBy }, { onConflict: 'job_id,template_item_id' });
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from('job_checklist_completions')
      .delete()
      .eq('job_id', jobId)
      .eq('template_item_id', templateItemId);
    if (error) throw error;
  }
}

// ============================================================
// SETTINGS (requirements + templates management)
// ============================================================

export async function fetchQualityRequirements(): Promise<QualityRequirement[]> {
  const { data, error } = await supabase.from('job_quality_requirements').select('*').order('service_type');
  if (error) throw error;
  return (data as QualityRequirement[]) ?? [];
}

export async function saveQualityRequirement(
  serviceType: string,
  flags: Omit<QualityRequirement, 'id' | 'service_type'>,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('job_quality_requirements')
    .upsert({ user_id: userId, service_type: serviceType, ...flags }, { onConflict: 'user_id,service_type' });
  if (error) throw error;
}

export async function fetchAllChecklistTemplates(): Promise<ChecklistTemplateItem[]> {
  const { data, error } = await supabase.from('job_quality_checklist_templates').select('*').order('service_type').order('sort_order');
  if (error) throw error;
  return (data as ChecklistTemplateItem[]) ?? [];
}

export async function addChecklistTemplateItem(serviceType: string, label: string, sortOrder: number, userId: string): Promise<void> {
  const { error } = await supabase
    .from('job_quality_checklist_templates')
    .insert({ user_id: userId, service_type: serviceType, item_label: label, sort_order: sortOrder });
  if (error) throw error;
}

export async function deleteChecklistTemplateItem(id: string): Promise<void> {
  const { error } = await supabase.from('job_quality_checklist_templates').delete().eq('id', id);
  if (error) throw error;
}
