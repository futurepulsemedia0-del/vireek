/**
 * Document Template Studio — client API. Thin typed wrappers over Supabase tables/RPCs and the
 * `doc-studio` / `doc-share` edge functions. Business rules live in the database and edge functions;
 * nothing here is trusted for security.
 */
import { supabase } from '@/lib/supabase';
import { createSignatureRequest, type CreateSignatureRequestResult } from '@/lib/signatures';
import { createDocument, uploadDocumentVersion } from '@/lib/documentsApi';
import type { ClauseSnapshot, Diagnostic } from '@/lib/docTemplates/mergeEngine';

export type VersionStatus = 'draft' | 'pending_review' | 'published' | 'rejected' | 'retired';
export type StudioKind = 'clause' | 'template';

export interface ClauseRef { slug: string; version: number; sha256: string }

export interface DocClause {
  id: string; slug: string; title: string; category: string; jurisdictions: string[]; locale: string;
  archived_at: string | null; created_at: string;
}
export interface DocClauseVersion {
  id: string; clause_id: string; version_number: number; body: string; sha256: string; status: VersionStatus;
  validated_sha256: string | null; review_note: string | null; self_approved: boolean;
  created_by: string; reviewed_by: string | null; created_at: string; published_at: string | null;
}
export interface DocTemplate {
  id: string; name: string; doc_type: 'contract' | 'notice'; jurisdictions: string[]; locale: string;
  archived_at: string | null; created_at: string;
}
export interface DocTemplateVersion {
  id: string; template_id: string; version_number: number; body: string; clause_refs: ClauseRef[];
  test_data: Record<string, string | number | boolean>; sha256: string; status: VersionStatus;
  validated_sha256: string | null; review_note: string | null; self_approved: boolean;
  created_by: string; reviewed_by: string | null; created_at: string; published_at: string | null;
}
export interface GeneratedDocument {
  id: string; template_version_id: string; customer_id: string | null; job_id: string | null; title: string;
  locale: string; currency: string | null; rendered_text: string; body_sha256: string;
  input_snapshot: Record<string, string | number | boolean>; clause_refs: ClauseRef[];
  vault_document_id: string | null; signature_request_id: string | null; voided_at: string | null; created_at: string;
}
export interface ShareLink {
  id: string; version_id: string; expires_at: string; max_views: number | null; view_count: number;
  has_password: boolean; revoked_at: string | null; created_at: string; created_by: string;
}
export interface AccessLogRow {
  id: number; document_id: string | null; version_id: string | null; share_link_id: string | null;
  actor_id: string | null; actor_kind: 'member' | 'share_link' | 'system'; action: string;
  outcome: 'ok' | 'denied'; created_at: string;
}

/** Error carrying the structured payload the edge function returned (diagnostics, missing fields …). */
export class StudioError extends Error {
  constructor(message: string, readonly code: string, readonly detail: unknown = null) { super(message); this.name = 'StudioError'; }
}

async function invokeStudio<T>(fn: 'doc-studio' | 'doc-share', body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    const ctx = (error as { context?: unknown }).context;
    if (typeof Response !== 'undefined' && ctx instanceof Response) {
      try {
        const payload = (await ctx.clone().json()) as { error?: string } & Record<string, unknown>;
        throw new StudioError(String(payload.error ?? 'request_failed'), String(payload.error ?? 'request_failed'), payload);
      } catch (e) {
        if (e instanceof StudioError) throw e;
      }
    }
    throw new StudioError('request_failed', 'request_failed');
  }
  return data as T;
}

const must = <T>(r: { data: T | null; error: unknown }): T => {
  if (r.error || r.data === null) throw r.error ?? new Error('No data returned.');
  return r.data;
};

/* -------------------------------- clauses -------------------------------- */

export async function listClauses(): Promise<DocClause[]> {
  return must(await supabase.from('doc_clauses').select('*').is('archived_at', null).order('title')) as DocClause[];
}
export async function listClauseVersions(clauseId: string): Promise<DocClauseVersion[]> {
  return must(await supabase.from('doc_clause_versions').select('*').eq('clause_id', clauseId).order('version_number', { ascending: false })) as DocClauseVersion[];
}
/** Published, non-retired clause versions (what a template may pin). */
export async function listPublishedClauseSnapshots(): Promise<(ClauseSnapshot & { title: string })[]> {
  const rows = must(await supabase.from('doc_clause_versions')
    .select('version_number, body, sha256, clause:doc_clauses!inner(slug, title, archived_at)')
    .eq('status', 'published')) as unknown as { version_number: number; body: string; sha256: string; clause: { slug: string; title: string; archived_at: string | null } }[];
  return rows.filter((r) => !r.clause.archived_at).map((r) => ({ slug: r.clause.slug, title: r.clause.title, version: r.version_number, body: r.body, sha256: r.sha256 }));
}
export async function createClause(input: { slug: string; title: string; category: string; jurisdictions: string[]; locale: string; body: string }): Promise<{ clause: DocClause; version: DocClauseVersion }> {
  const { body, ...meta } = input;
  const clause = must(await supabase.from('doc_clauses').insert(meta).select('*').single()) as DocClause;
  const version = must(await supabase.from('doc_clause_versions').insert({ clause_id: clause.id, body }).select('*').single()) as DocClauseVersion;
  return { clause, version };
}
export async function createClauseVersion(clauseId: string, body: string): Promise<DocClauseVersion> {
  return must(await supabase.from('doc_clause_versions').insert({ clause_id: clauseId, body }).select('*').single()) as DocClauseVersion;
}
export async function saveClauseDraft(versionId: string, body: string): Promise<void> {
  const { error } = await supabase.from('doc_clause_versions').update({ body }).eq('id', versionId);
  if (error) throw error;
}

/* ------------------------------- templates ------------------------------- */

export async function listTemplates(): Promise<DocTemplate[]> {
  return must(await supabase.from('doc_content_templates').select('*').is('archived_at', null).order('name')) as DocTemplate[];
}
export async function listTemplateVersions(templateId: string): Promise<DocTemplateVersion[]> {
  return must(await supabase.from('doc_content_template_versions').select('*').eq('template_id', templateId).order('version_number', { ascending: false })) as DocTemplateVersion[];
}
export async function createTemplate(input: { name: string; doc_type: 'contract' | 'notice'; jurisdictions: string[]; locale: string; body: string; clause_refs?: ClauseRef[]; test_data?: Record<string, string | number | boolean> }): Promise<{ template: DocTemplate; version: DocTemplateVersion }> {
  const { body, clause_refs, test_data, ...meta } = input;
  const template = must(await supabase.from('doc_content_templates').insert(meta).select('*').single()) as DocTemplate;
  const version = must(await supabase.from('doc_content_template_versions')
    .insert({ template_id: template.id, body, clause_refs: clause_refs ?? [], test_data: test_data ?? {} }).select('*').single()) as DocTemplateVersion;
  return { template, version };
}
export async function createTemplateVersion(templateId: string, input: { body: string; clause_refs: ClauseRef[]; test_data: Record<string, string | number | boolean> }): Promise<DocTemplateVersion> {
  return must(await supabase.from('doc_content_template_versions').insert({ template_id: templateId, ...input }).select('*').single()) as DocTemplateVersion;
}
export async function saveTemplateDraft(versionId: string, input: { body: string; clause_refs: ClauseRef[]; test_data: Record<string, string | number | boolean> }): Promise<void> {
  const { error } = await supabase.from('doc_content_template_versions').update(input).eq('id', versionId);
  if (error) throw error;
}

/* --------------------------- validate / workflow --------------------------- */

/** Server-side validation with the same engine; on success the draft is attested and can be submitted. */
export async function validateVersion(kind: StudioKind, versionId: string): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> {
  return invokeStudio('doc-studio', { action: 'validate', kind, version_id: versionId });
}
export async function submitForReview(kind: StudioKind, versionId: string): Promise<void> {
  const { error } = await supabase.rpc('doc_studio_submit', { p_kind: kind, p_version_id: versionId });
  if (error) throw error;
}
export async function reviewVersion(kind: StudioKind, versionId: string, approve: boolean, note?: string): Promise<void> {
  const { error } = await supabase.rpc('doc_studio_review', { p_kind: kind, p_version_id: versionId, p_approve: approve, p_note: note ?? null });
  if (error) throw error;
}
export async function retireVersion(kind: StudioKind, versionId: string): Promise<void> {
  const { error } = await supabase.rpc('doc_studio_retire', { p_kind: kind, p_version_id: versionId });
  if (error) throw error;
}

/* -------------------------------- generate -------------------------------- */

export interface GenerateInput {
  template_version_id: string; customer_id?: string | null; job_id?: string | null; title?: string;
  locale?: string; currency?: string; time_zone?: string; overrides?: Record<string, string | number | boolean>;
}
/** Throws StudioError('incomplete', …, { missing }) / ('render_failed', …, { diagnostics }) etc. */
export async function generateDocument(input: GenerateInput): Promise<GeneratedDocument> {
  const r = await invokeStudio<{ generated: GeneratedDocument }>('doc-studio', { action: 'generate', ...input });
  return r.generated;
}
export async function listGeneratedDocuments(customerId?: string): Promise<GeneratedDocument[]> {
  let q = supabase.from('generated_documents').select('*').order('created_at', { ascending: false }).limit(200);
  if (customerId) q = q.eq('customer_id', customerId);
  return must(await q) as GeneratedDocument[];
}
export async function voidGeneratedDocument(id: string): Promise<void> {
  const { error } = await supabase.from('generated_documents').update({ voided_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

/* ------------------------------ PDF → vault ------------------------------ */

export interface PdfLabels { kindLabel: string; integrityLabel: string; voidLabel: string; legalLine: string }

/** Builds the PDF in the browser (jsPDF, same design system as quotes/invoices). */
export async function buildGeneratedPdf(g: GeneratedDocument, ctx: { businessName: string | null; customerName: string | null; contact: string[]; labels: PdfLabels }): Promise<Blob> {
  const [{ jsPDF }, { buildDocEnv }, { renderContractDocument }] = await Promise.all([
    import('jspdf'), import('@/lib/documents/docEnv'), import('@/lib/documents/contractDocument'),
  ]);
  const env = await buildDocEnv();
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  renderContractDocument(doc as unknown as Parameters<typeof renderContractDocument>[0], {
    businessName: ctx.businessName, title: g.title, number: g.id.slice(0, 8).toUpperCase(), customerName: ctx.customerName,
    contact: ctx.contact, issuedAt: g.created_at, body: g.rendered_text, bodySha256: g.body_sha256, voided: g.voided_at !== null,
  }, { ...env, ...ctx.labels });
  return doc.output('blob');
}

/** Stores the PDF as a vault document (immutable version, expiry/trash rules apply) and links it once. */
export async function savePdfToVault(ownerId: string, g: GeneratedDocument, pdf: Blob): Promise<string> {
  if (g.vault_document_id) return g.vault_document_id;
  const record = await createDocument(ownerId, {
    title: g.title, category: 'contract', reference_number: g.id.slice(0, 8).toUpperCase(), issuer: '',
    issued_on: g.created_at.slice(0, 10), expires_on: '', alert_days: 30, notes: `SHA-256 ${g.body_sha256}`, customer_id: g.customer_id,
  });
  const file = new File([pdf], `${g.title.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 80) || 'document'}.pdf`, { type: 'application/pdf' });
  await uploadDocumentVersion({ ownerId, documentId: record.id, file, note: 'Generated from template' });
  const { error } = await supabase.from('generated_documents').update({ vault_document_id: record.id }).eq('id', g.id);
  if (error) throw error;
  return record.id;
}

/* ------------------------------- share links ------------------------------- */

export function getShareUrl(token: string): string { return `${window.location.origin}/shared-document/${token}`; }

export async function createShareLink(input: { document_id: string; version_id?: string; expires_in_hours?: number; max_views?: number; password?: string }): Promise<{ link_id: string; token: string; url: string; expires_at: string; has_password: boolean }> {
  const r = await invokeStudio<{ link_id: string; token: string; expires_at: string; has_password: boolean }>('doc-studio', { action: 'share_create', ...input });
  return { ...r, url: getShareUrl(r.token) };
}
export async function listShareLinks(documentId: string): Promise<ShareLink[]> {
  return must(await supabase.rpc('list_document_share_links', { p_document_id: documentId })) as ShareLink[];
}
export async function revokeShareLink(linkId: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_document_share_link', { p_link_id: linkId });
  if (error) throw error;
}
export interface ResolvedShare { url: string; file_name: string; mime_type: string | null; size_bytes: number; expires_at: string }
/** Public viewer call. Throws StudioError with code: password_required | wrong_password | expired | revoked | limit_reached | locked | unavailable. */
export async function resolveShareLink(token: string, password?: string, download = false): Promise<ResolvedShare> {
  return invokeStudio<ResolvedShare>('doc-share', { token, password, download });
}
export async function listAccessLog(documentId: string, limit = 100): Promise<AccessLogRow[]> {
  return must(await supabase.from('document_access_log').select('*').eq('document_id', documentId).order('created_at', { ascending: false }).limit(limit)) as AccessLogRow[];
}

/* ------------------------------- e-sign hand-off ------------------------------- */

/**
 * Sends a generated contract for native e-signature. Requirements (checked here, enforced by the DB link guard):
 * the PDF is in the vault, the document is not voided, and the share link the signer opens stays valid for the
 * whole signing window. The signer-visible summary carries the SHA-256 of the exact merged text.
 */
export async function handOffToSignature(args: {
  generated: GeneratedDocument; shareToken: string; shareExpiresAt: string; expiresInDays: number;
  signers: { name: string; email?: string; phone?: string; role?: 'signer' | 'company_rep' | 'witness' }[];
}): Promise<CreateSignatureRequestResult> {
  const g = args.generated;
  if (g.voided_at) throw new StudioError('document_voided', 'document_voided');
  if (!g.vault_document_id) throw new StudioError('not_in_vault', 'not_in_vault');
  if (g.signature_request_id) throw new StudioError('already_sent', 'already_sent');
  if (new Date(args.shareExpiresAt).getTime() < Date.now() + args.expiresInDays * 86_400_000) throw new StudioError('share_link_too_short', 'share_link_too_short');
  const result = await createSignatureRequest({
    document_type: 'contract', document_id: g.id, customer_id: g.customer_id, title: g.title,
    document_summary: `${g.title}\nSHA-256 ${g.body_sha256}`, document_url: getShareUrl(args.shareToken),
    expires_in_days: args.expiresInDays, signers: args.signers,
  });
  const { error } = await supabase.from('generated_documents').update({ signature_request_id: result.request.id }).eq('id', g.id);
  if (error) throw error;
  return result;
}
