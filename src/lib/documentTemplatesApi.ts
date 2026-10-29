import { supabase } from '@/lib/supabase';
import {
  normalizeDesign,
  normalizeTemplate,
  normalizeTemplates,
  type DocType,
  type DocumentDesign,
  type DocumentTemplate,
} from '@/lib/documentTemplates';

/**
 * Data access for /dashboard/document-templates. Every read/write is scoped to the account owner
 * (accountOwnerId) on top of RLS. The default flag changes only through set_document_template_default().
 * Schema + rules: supabase/migrations/20280101000000_document_templates.sql.
 */

const COLUMNS = 'id, user_id, name, doc_type, design, is_default, status, revision, created_by, created_at, updated_at';

export class TemplateConflictError extends Error {
  constructor() {
    super('This template changed or is no longer available. Reload to see the latest version.');
    this.name = 'TemplateConflictError';
  }
}

function requireTemplate(data: unknown): DocumentTemplate {
  const row = normalizeTemplate(data);
  if (!row) throw new Error('Unexpected response from the server.');
  return row;
}

export async function fetchDocumentTemplates(accountOwnerId: string): Promise<DocumentTemplate[]> {
  const { data, error } = await supabase
    .from('document_templates')
    .select(COLUMNS)
    .eq('user_id', accountOwnerId)
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return normalizeTemplates(data);
}

/** The account's default template for a type, or null (callers then fall back to the built-in PDF). */
export async function fetchDefaultTemplate(accountOwnerId: string, docType: DocType): Promise<DocumentTemplate | null> {
  const { data, error } = await supabase
    .from('document_templates')
    .select(COLUMNS)
    .eq('user_id', accountOwnerId)
    .eq('doc_type', docType)
    .eq('status', 'active')
    .eq('is_default', true)
    .maybeSingle();
  if (error) throw error;
  return data ? normalizeTemplate(data) : null;
}

export async function createDocumentTemplate(
  accountOwnerId: string,
  input: { name: string; docType: DocType; design: DocumentDesign },
): Promise<DocumentTemplate> {
  const { data, error } = await supabase
    .from('document_templates')
    .insert({
      user_id: accountOwnerId,
      name: input.name.trim(),
      doc_type: input.docType,
      design: normalizeDesign(input.design, input.docType),
    })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return requireTemplate(data);
}

/** Optimistic concurrency: only applies if nobody changed the row since `expectedUpdatedAt`. */
export async function updateDocumentTemplate(
  id: string,
  accountOwnerId: string,
  expectedUpdatedAt: string,
  docType: DocType,
  draft: { name: string; design: DocumentDesign },
): Promise<DocumentTemplate> {
  const { data, error } = await supabase
    .from('document_templates')
    .update({ name: draft.name.trim(), design: normalizeDesign(draft.design, docType) })
    .eq('id', id)
    .eq('user_id', accountOwnerId)
    .eq('updated_at', expectedUpdatedAt)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new TemplateConflictError();
  return requireTemplate(data);
}

export async function setDocumentTemplateStatus(
  id: string,
  accountOwnerId: string,
  expectedUpdatedAt: string,
  status: 'active' | 'archived',
): Promise<DocumentTemplate> {
  const { data, error } = await supabase
    .from('document_templates')
    .update({ status })
    .eq('id', id)
    .eq('user_id', accountOwnerId)
    .eq('updated_at', expectedUpdatedAt)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new TemplateConflictError();
  return requireTemplate(data);
}

export async function setDocumentTemplateDefault(id: string, isDefault: boolean): Promise<DocumentTemplate> {
  const { data, error } = await supabase.rpc('set_document_template_default', { p_id: id, p_default: isDefault });
  if (error) throw error;
  return requireTemplate(Array.isArray(data) ? data[0] : data);
}

/** Human-readable message for any error these functions can throw. */
export function describeDocumentTemplateError(e: unknown): string {
  if (e instanceof TemplateConflictError) return e.message;
  const err = (e ?? {}) as { code?: string; message?: string };
  switch (err.code) {
    case '23505':
      return 'A template with this name already exists for this document type.';
    case '42501':
      return 'You do not have permission to change templates.';
    case '55000':
      return err.message || 'This template is archived. Restore it first.';
    case 'P0002':
      return 'This template is no longer available. Reload to see the latest version.';
    case '22023':
      return 'This template design is too large.';
    default:
      return err.message && !/fetch|network/i.test(err.message) ? err.message : 'Something went wrong. Check your connection and try again.';
  }
}
