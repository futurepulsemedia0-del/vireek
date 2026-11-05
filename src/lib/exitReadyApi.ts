/**
 * Exit-Ready — data access for lineage, multiple tables and the staged data room (owner side + buyer side).
 *
 * Owner-only in the database (RLS + exit_is_owner()); nothing here widens that. Buyer calls go through the
 * exit-dataroom-public edge function; the link token is the credential and is never placed in a URL path or query.
 * Extends src/lib/exitReadinessApi.ts (kept as is). DB: 20281115000000_exit_ready_lineage.sql
 */

import { supabase } from '@/lib/supabase';
import { generateToken, sha256Hex } from '@/lib/speedToLead';
import { dataRoomUrl } from '@/lib/exitReadinessApi';
import type { IndustryKey } from '@/lib/exitReadiness';
import { parseRun, type FactRow, type LineageRun, type MultipleRow, type RunRow, type SizeBand } from '@/lib/exitLineage';

interface PgError {
  message?: string;
  code?: string;
}

/** Only messages raised by our own RPCs are shown (22023 invalid input, 53400 limit, 54000 size, 55000 state, P0002 not found). */
function toError(e: PgError | null, fallback: string): Error {
  if (e?.code === '42501') return new Error('Only the account owner can use Exit Readiness.');
  if (e?.code && ['22023', '53400', '54000', '55000', 'P0002'].includes(e.code) && e.message) return new Error(e.message);
  if (e?.code === '23514') return new Error('One of the values is outside the allowed range.');
  if (e?.code === '23505') return new Error('That entry already exists.');
  return new Error(fallback);
}

// ------------------------------------------------------------------ lineage

export async function fetchLatestRun(ownerId: string): Promise<LineageRun | null> {
  const { data: runs, error } = await supabase
    .from('exit_lineage_runs')
    .select('id, as_of, logic_version, run_hash, created_at, reconciliation')
    .eq('account_owner_id', ownerId)
    .not('run_hash', 'is', null)
    .order('created_at', { ascending: false })
    .limit(2);
  if (error) throw toError(error, 'Could not load the evidence check.');
  const rows = (runs ?? []) as unknown as RunRow[];
  if (!rows.length) return null;
  const { data: facts, error: fe } = await supabase
    .from('exit_lineage_facts')
    .select('id, metric_key, label, value, as_of, logic_version, logic_text, source_table, source_count, content_hash')
    .eq('run_id', rows[0].id)
    .limit(100);
  if (fe) throw toError(fe, 'Could not load the evidence facts.');
  return parseRun(rows[0], (facts ?? []) as unknown as FactRow[]);
}

/** The run before the latest one (for the changelog); null when there is none. */
export async function fetchPreviousRun(ownerId: string): Promise<LineageRun | null> {
  const { data: runs, error } = await supabase
    .from('exit_lineage_runs')
    .select('id, as_of, logic_version, run_hash, created_at, reconciliation')
    .eq('account_owner_id', ownerId)
    .not('run_hash', 'is', null)
    .order('created_at', { ascending: false })
    .range(1, 1);
  if (error) throw toError(error, 'Could not load the previous evidence check.');
  const row = ((runs ?? []) as unknown as RunRow[])[0];
  if (!row) return null;
  const { data: facts, error: fe } = await supabase
    .from('exit_lineage_facts')
    .select('id, metric_key, label, value, as_of, logic_version, logic_text, source_table, source_count, content_hash')
    .eq('run_id', row.id)
    .limit(100);
  if (fe) throw toError(fe, 'Could not load the previous evidence facts.');
  return parseRun(row, (facts ?? []) as unknown as FactRow[]);
}

export async function runLineage(): Promise<{ runId: string; reused: boolean }> {
  const { data, error } = await supabase.rpc('exit_run_lineage');
  if (error) throw toError(error, 'Could not run the evidence check.');
  return data as { runId: string; reused: boolean };
}

export interface VerifyResult {
  factId: string;
  metricKey: string;
  matches: boolean;
  storedHash: string;
  recomputedHash: string;
  storedCount: number;
  recomputedCount: number;
  recomputedValue: Record<string, unknown>;
  asOf: string;
}

export async function verifyFact(factId: string): Promise<VerifyResult> {
  const { data, error } = await supabase.rpc('exit_verify_fact', { p_fact_id: factId });
  if (error) throw toError(error, 'Could not re-check this figure.');
  return data as VerifyResult;
}

// ------------------------------------------------------------------ multiple tables

interface MultipleDbRow {
  id: string;
  industry_key: IndustryKey;
  size_band: SizeBand;
  basis: 'sde' | 'ebitda';
  multiple_low: number | string;
  multiple_mid: number | string;
  multiple_high: number | string;
  source: string;
  source_date: string;
  is_illustrative: boolean;
}

export async function fetchMultipleRows(ownerId: string): Promise<MultipleRow[]> {
  const { data, error } = await supabase
    .from('exit_multiple_tables')
    .select('id, industry_key, size_band, basis, multiple_low, multiple_mid, multiple_high, source, source_date, is_illustrative')
    .eq('account_owner_id', ownerId)
    .limit(200);
  if (error) throw toError(error, 'Could not load your multiple tables.');
  return ((data ?? []) as unknown as MultipleDbRow[]).map((r) => ({
    id: r.id, industryKey: r.industry_key, sizeBand: r.size_band, basis: r.basis,
    low: Number(r.multiple_low), mid: Number(r.multiple_mid), high: Number(r.multiple_high),
    source: r.source, sourceDate: r.source_date, isIllustrative: r.is_illustrative,
  }));
}

export async function saveMultipleRow(ownerId: string, row: MultipleRow): Promise<void> {
  const { error } = await supabase.from('exit_multiple_tables').upsert(
    {
      account_owner_id: ownerId,
      industry_key: row.industryKey,
      size_band: row.sizeBand,
      basis: row.basis,
      multiple_low: row.low,
      multiple_mid: row.mid,
      multiple_high: row.high,
      source: row.source.trim(),
      source_date: row.sourceDate,
      is_illustrative: row.isIllustrative,
    },
    { onConflict: 'account_owner_id,industry_key,size_band,basis' },
  );
  if (error) throw toError(error, 'Could not save the multiple.');
}

export async function deleteMultipleRow(id: string): Promise<void> {
  const { error } = await supabase.from('exit_multiple_tables').delete().eq('id', id);
  if (error) throw toError(error, 'Could not delete the multiple.');
}

// ------------------------------------------------------------------ staged rooms (owner side)

export type Stage = 'teaser' | 'nda' | 'detailed';
export type PiiLevel = 'aggregated' | 'pseudonymized' | 'named';

export interface StagedLink {
  id: string;
  label: string;
  recipientLabel: string | null;
  tokenHint: string;
  expiresAt: string;
  maxViews: number;
  viewCount: number;
  lastViewedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  stageCeiling: Stage;
  piiLevel: PiiLevel;
  ndaAcceptedAt: string | null;
  detailedApprovedAt: string | null;
  viewOnly: boolean;
  lineageRunId: string | null;
}

export async function fetchStagedLinks(ownerId: string): Promise<StagedLink[]> {
  const { data, error } = await supabase
    .from('exit_dataroom_links')
    .select('id, recipient_label, token_hint, expires_at, max_views, view_count, last_viewed_at, revoked_at, created_at, stage_ceiling, pii_level, nda_accepted_at, detailed_approved_at, view_only, exit_dataroom_packages(label, lineage_run_id)')
    .eq('account_owner_id', ownerId)
    .eq('room_mode', 'staged')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw toError(error, 'Could not load staged rooms.');
  type Pkg = { label: string; lineage_run_id: string | null };
  type Row = {
    id: string; recipient_label: string | null; token_hint: string; expires_at: string; max_views: number; view_count: number;
    last_viewed_at: string | null; revoked_at: string | null; created_at: string; stage_ceiling: Stage; pii_level: PiiLevel;
    nda_accepted_at: string | null; detailed_approved_at: string | null; view_only: boolean; exit_dataroom_packages: Pkg | Pkg[] | null;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => {
    const pkg = Array.isArray(r.exit_dataroom_packages) ? r.exit_dataroom_packages[0] : r.exit_dataroom_packages;
    return {
      id: r.id, label: pkg?.label ?? 'Data room', recipientLabel: r.recipient_label, tokenHint: r.token_hint, expiresAt: r.expires_at,
      maxViews: r.max_views, viewCount: r.view_count, lastViewedAt: r.last_viewed_at, revokedAt: r.revoked_at, createdAt: r.created_at,
      stageCeiling: r.stage_ceiling, piiLevel: r.pii_level, ndaAcceptedAt: r.nda_accepted_at, detailedApprovedAt: r.detailed_approved_at,
      viewOnly: r.view_only, lineageRunId: pkg?.lineage_run_id ?? null,
    };
  });
}

export async function createStagedRoom(input: {
  label: string;
  recipient: string;
  expiresHours: number;
  maxViews: number;
  ndaText: string;
  valuation: Record<string, unknown> | null;
}): Promise<{ url: string; expiresAt: string; linkId: string }> {
  const token = generateToken();
  const { data, error } = await supabase.rpc('exit_create_staged_room', {
    p_label: input.label.trim(),
    p_recipient: input.recipient.trim() || null,
    p_expires_hours: input.expiresHours,
    p_max_views: input.maxViews,
    p_nda_text: input.ndaText,
    p_valuation: input.valuation,
    p_token_hash: await sha256Hex(token),
    p_token_hint: token.slice(-4),
  });
  if (error) throw toError(error, 'Could not create the staged room.');
  const out = data as { linkId: string; expiresAt: string };
  return { url: dataRoomUrl(token), expiresAt: out.expiresAt, linkId: out.linkId };
}

export async function setStage(linkId: string, ceiling: Stage, piiLevel: PiiLevel, sections: string[]): Promise<void> {
  const { error } = await supabase.rpc('exit_set_stage', {
    p_link_id: linkId, p_ceiling: ceiling, p_pii_level: piiLevel, p_sections: ceiling === 'detailed' ? sections : null,
  });
  if (error) throw toError(error, 'Could not change the stage.');
}

export interface OwnerDocument {
  id: string;
  title: string;
  category: string;
}

export async function fetchOwnerDocuments(ownerId: string): Promise<OwnerDocument[]> {
  const { data, error } = await supabase.from('documents').select('id, title, category').eq('user_id', ownerId).order('title').limit(300);
  if (error) throw toError(error, 'Could not load your documents.');
  return (data ?? []) as unknown as OwnerDocument[];
}

export interface SharedDocument {
  id: string;
  linkId: string;
  documentId: string;
  title: string;
  minStage: 'nda' | 'detailed';
}

export async function fetchSharedDocuments(ownerId: string): Promise<SharedDocument[]> {
  const { data, error } = await supabase
    .from('exit_dataroom_documents')
    .select('id, link_id, document_id, min_stage, documents(title)')
    .eq('account_owner_id', ownerId)
    .limit(500);
  if (error) throw toError(error, 'Could not load shared documents.');
  type Row = { id: string; link_id: string; document_id: string; min_stage: 'nda' | 'detailed'; documents: { title: string } | { title: string }[] | null };
  return ((data ?? []) as unknown as Row[]).map((r) => {
    const d = Array.isArray(r.documents) ? r.documents[0] : r.documents;
    return { id: r.id, linkId: r.link_id, documentId: r.document_id, title: d?.title ?? 'Document', minStage: r.min_stage };
  });
}

export async function shareDocument(linkId: string, documentId: string, minStage: 'nda' | 'detailed'): Promise<void> {
  const { error } = await supabase.rpc('exit_share_document', { p_link_id: linkId, p_document_id: documentId, p_min_stage: minStage });
  if (error) throw toError(error, 'Could not share the document.');
}

export async function unshareDocument(linkId: string, documentId: string): Promise<void> {
  const { error } = await supabase.rpc('exit_unshare_document', { p_link_id: linkId, p_document_id: documentId });
  if (error) throw toError(error, 'Could not stop sharing the document.');
}

export interface QaEntry {
  id: string;
  linkId: string;
  question: string;
  askedAt: string;
  answer: string | null;
  answeredAt: string | null;
}

export async function fetchQuestions(ownerId: string): Promise<QaEntry[]> {
  const { data, error } = await supabase
    .from('exit_dataroom_questions')
    .select('id, link_id, question, asked_at, answer, answered_at')
    .eq('account_owner_id', ownerId)
    .order('asked_at', { ascending: false })
    .limit(200);
  if (error) throw toError(error, 'Could not load buyer questions.');
  return ((data ?? []) as unknown as { id: string; link_id: string; question: string; asked_at: string; answer: string | null; answered_at: string | null }[]).map((r) => ({
    id: r.id, linkId: r.link_id, question: r.question, askedAt: r.asked_at, answer: r.answer, answeredAt: r.answered_at,
  }));
}

export async function answerQuestion(id: string, answer: string): Promise<void> {
  const { error } = await supabase.rpc('exit_answer_question', { p_question_id: id, p_answer: answer });
  if (error) throw toError(error, 'Could not save the answer.');
}

export interface DocAccessEntry {
  id: string;
  linkId: string | null;
  documentId: string | null;
  action: 'view' | 'denied_stage' | 'denied_not_shared';
  accessedAt: string;
}

export async function fetchDocAccessLogs(ownerId: string): Promise<DocAccessEntry[]> {
  const { data, error } = await supabase
    .from('exit_dataroom_doc_access_logs')
    .select('id, link_id, document_id, action, accessed_at')
    .eq('account_owner_id', ownerId)
    .order('accessed_at', { ascending: false })
    .limit(200);
  if (error) throw toError(error, 'Could not load document access logs.');
  return ((data ?? []) as unknown as { id: string; link_id: string | null; document_id: string | null; action: DocAccessEntry['action']; accessed_at: string }[]).map((r) => ({
    id: r.id, linkId: r.link_id, documentId: r.document_id, action: r.action, accessedAt: r.accessed_at,
  }));
}

export interface AuditEntry {
  id: string;
  actorKind: 'owner' | 'recipient' | 'system';
  action: string;
  entity: string;
  createdAt: string;
}

export async function fetchAudit(ownerId: string): Promise<AuditEntry[]> {
  const { data, error } = await supabase
    .from('exit_audit_events')
    .select('id, actor_kind, action, entity, created_at')
    .eq('account_owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw toError(error, 'Could not load the audit log.');
  return ((data ?? []) as unknown as { id: string; actor_kind: AuditEntry['actorKind']; action: string; entity: string; created_at: string }[]).map((r) => ({
    id: r.id, actorKind: r.actor_kind, action: r.action, entity: r.entity, createdAt: r.created_at,
  }));
}

// ------------------------------------------------------------------ staged rooms (buyer side)

export interface PublicStagedRoom {
  mode: 'staged';
  label: string;
  expiresAt: string;
  viewsRemaining: number;
  stage: Stage;
  stageCeiling: Stage;
  ndaRequired: boolean;
  ndaText: string | null;
  viewOnly: boolean;
  watermark: string | null;
  content: { teaser: Record<string, unknown>; nda?: Record<string, unknown>; detailed?: Record<string, unknown> };
  documents: { documentId: string; title: string; category: string; fileName: string | null; minStage: 'nda' | 'detailed' }[];
  questions: { id: string; question: string; askedAt: string; answer: string | null; answeredAt: string | null }[];
}

async function invokePublic(body: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; status: number }> {
  const { data, error } = await supabase.functions.invoke('exit-dataroom-public', { body });
  if (error) return { ok: false, status: (error as { context?: { status?: number } }).context?.status ?? 500 };
  return { ok: true, data };
}

export async function acceptNda(token: string, name: string, email: string): Promise<'accepted' | 'invalid' | 'unavailable' | 'error'> {
  const r = await invokePublic({ token, action: 'accept_nda', name: name.trim(), email: email.trim(), agree: true });
  if (r.ok) return 'accepted';
  return r.status === 400 ? 'invalid' : r.status === 404 ? 'unavailable' : 'error';
}

export async function askQuestion(token: string, question: string): Promise<'asked' | 'invalid' | 'nda_required' | 'rate_limited' | 'unavailable' | 'error'> {
  const r = await invokePublic({ token, action: 'ask', question: question.trim() });
  if (r.ok) return 'asked';
  return r.status === 400 ? 'invalid' : r.status === 403 ? 'nda_required' : r.status === 429 ? 'rate_limited' : r.status === 404 ? 'unavailable' : 'error';
}

export async function getDocumentUrl(token: string, documentId: string): Promise<{ url: string; fileName: string } | null> {
  const r = await invokePublic({ token, action: 'document', documentId });
  if (!r.ok) return null;
  const d = r.data as { url?: string; fileName?: string };
  return typeof d.url === 'string' ? { url: d.url, fileName: d.fileName ?? 'document' } : null;
}

// ------------------------------------------------------------------ add-back evidence

export interface EvidenceRow {
  id: string;
  addbackId: string;
  documentId: string;
  title: string;
}

export async function fetchAddbackEvidence(ownerId: string): Promise<EvidenceRow[]> {
  const { data, error } = await supabase
    .from('exit_addback_evidence')
    .select('id, addback_id, document_id, documents(title)')
    .eq('account_owner_id', ownerId)
    .limit(500);
  if (error) throw toError(error, 'Could not load add-back evidence.');
  type Row = { id: string; addback_id: string; document_id: string; documents: { title: string } | { title: string }[] | null };
  return ((data ?? []) as unknown as Row[]).map((r) => {
    const d = Array.isArray(r.documents) ? r.documents[0] : r.documents;
    return { id: r.id, addbackId: r.addback_id, documentId: r.document_id, title: d?.title ?? 'Document' };
  });
}

export async function attachEvidence(ownerId: string, addbackId: string, documentId: string): Promise<void> {
  const { error } = await supabase.from('exit_addback_evidence').insert({ account_owner_id: ownerId, addback_id: addbackId, document_id: documentId });
  if (error) throw toError(error, 'Could not attach the document.');
}

export async function detachEvidence(id: string): Promise<void> {
  const { error } = await supabase.from('exit_addback_evidence').delete().eq('id', id);
  if (error) throw toError(error, 'Could not remove the document.');
}

export async function revokeStagedLink(linkId: string): Promise<void> {
  const { error } = await supabase.rpc('exit_revoke_link', { p_link_id: linkId });
  if (error) throw toError(error, 'Could not revoke the link.');
}

// ------------------------------------------------------------------ buyer: open / refresh

import type { PublicDataRoom } from '@/lib/exitReadinessApi';

export type OpenAnyResult =
  | { ok: true; kind: 'legacy'; room: PublicDataRoom }
  | { ok: true; kind: 'staged'; room: PublicStagedRoom }
  | { ok: false; reason: 'unavailable' | 'rate_limited' | 'error' };

const isStaged = (d: unknown): d is PublicStagedRoom => typeof d === 'object' && d !== null && (d as { mode?: unknown }).mode === 'staged';

/** Opens a room (counts one view). Legacy single-stage rooms keep their original shape. */
export async function openAnyRoom(token: string): Promise<OpenAnyResult> {
  const r = await invokePublic({ token, action: 'open' });
  if (!r.ok) return { ok: false, reason: r.status === 404 ? 'unavailable' : r.status === 429 ? 'rate_limited' : 'error' };
  return isStaged(r.data) ? { ok: true, kind: 'staged', room: r.data } : { ok: true, kind: 'legacy', room: r.data as PublicDataRoom };
}

/** Re-reads a staged room without using a view (valid for 30 minutes after an open). */
export async function refreshStagedRoom(token: string): Promise<PublicStagedRoom | null> {
  const r = await invokePublic({ token, action: 'refresh' });
  return r.ok && isStaged(r.data) ? r.data : null;
}
