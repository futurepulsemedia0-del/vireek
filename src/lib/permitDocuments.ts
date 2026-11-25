/**
 * Permit document checklist (metadata only). Server table: public.permit_documents
 * (supabase/migrations/20290311000100_permit_documents.sql). RLS scopes rows to the account owner.
 */

import { supabase } from '@/lib/supabase';

export type PermitDocumentKind =
  | 'application_form' | 'site_plan' | 'drawings' | 'load_calc' | 'equipment_spec'
  | 'contractor_license' | 'insurance' | 'owner_authorization' | 'other';

export type PermitDocumentStatus = 'needed' | 'attached' | 'submitted' | 'accepted' | 'rejected';

export interface PermitDocument {
  id: string;
  application_id: string;
  kind: PermitDocumentKind;
  label: string;
  required: boolean;
  status: PermitDocumentStatus;
  file_reference: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export const PERMIT_DOCUMENT_KIND_LABELS: Record<PermitDocumentKind, string> = {
  application_form: 'Application form',
  site_plan: 'Site plan',
  drawings: 'Drawings',
  load_calc: 'Load calculation',
  equipment_spec: 'Equipment specification',
  contractor_license: 'Contractor license',
  insurance: 'Insurance certificate',
  owner_authorization: 'Owner authorization',
  other: 'Other',
};

export const PERMIT_DOCUMENT_STATUS_LABELS: Record<PermitDocumentStatus, string> = {
  needed: 'Needed',
  attached: 'Attached',
  submitted: 'Submitted',
  accepted: 'Accepted',
  rejected: 'Rejected',
};

export interface DocumentChecklistSummary {
  total: number;
  requiredTotal: number;
  requiredReady: number;
  rejected: number;
  /** True when every required document is attached, submitted or accepted and none is rejected. */
  readyToFile: boolean;
}

const READY: ReadonlySet<PermitDocumentStatus> = new Set(['attached', 'submitted', 'accepted']);

export function summarizeDocuments(
  docs: Pick<PermitDocument, 'required' | 'status'>[],
): DocumentChecklistSummary {
  const required = docs.filter((d) => d.required);
  const requiredReady = required.filter((d) => READY.has(d.status)).length;
  const rejected = docs.filter((d) => d.status === 'rejected').length;
  return {
    total: docs.length,
    requiredTotal: required.length,
    requiredReady,
    rejected,
    readyToFile: required.length > 0 && requiredReady === required.length && rejected === 0,
  };
}

const COLUMNS = 'id, application_id, kind, label, required, status, file_reference, notes, created_at, updated_at';

export async function fetchPermitDocuments(applicationId: string): Promise<PermitDocument[]> {
  const { data, error } = await supabase
    .from('permit_documents')
    .select(COLUMNS)
    .eq('application_id', applicationId)
    .order('created_at', { ascending: true });
  if (error) throw new Error('Could not load the document checklist.');
  return (data ?? []) as PermitDocument[];
}

export async function addPermitDocument(args: {
  applicationId: string;
  kind: PermitDocumentKind;
  label: string;
  required?: boolean;
}): Promise<PermitDocument> {
  const label = args.label.trim();
  if (!label) throw new Error('Enter a document name.');
  const { data, error } = await supabase
    .from('permit_documents')
    .insert({
      application_id: args.applicationId,
      kind: args.kind,
      label: label.slice(0, 160),
      required: args.required ?? true,
    })
    .select(COLUMNS)
    .single();
  if (error) throw new Error('Could not add the document.');
  return data as PermitDocument;
}

export async function updatePermitDocument(
  id: string,
  patch: Partial<Pick<PermitDocument, 'status' | 'file_reference' | 'notes' | 'required' | 'label'>>,
): Promise<PermitDocument> {
  const { data, error } = await supabase
    .from('permit_documents')
    .update(patch)
    .eq('id', id)
    .select(COLUMNS)
    .single();
  if (error) throw new Error('Could not save the document.');
  return data as PermitDocument;
}

export async function deletePermitDocument(id: string): Promise<void> {
  const { error } = await supabase.from('permit_documents').delete().eq('id', id);
  if (error) throw new Error('Could not remove the document.');
}
