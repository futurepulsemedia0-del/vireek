// Marketplace third-party app vetting: client types, pure helpers and Supabase access.
// Server rules live in supabase/migrations/20290311000000_marketplace_vetting.sql (gate) and
// supabase/functions/_shared/agent-marketplace/vetting.ts (static checks). Staff only, enforced by RLS/RPC.
import { supabase } from '@/lib/supabase';
import type { MarketplaceAgent, ReviewQueueItem } from '@/lib/agentMarketplace';

export type CheckStatus = 'pass' | 'warn' | 'fail';
export type RiskTier = 'low' | 'medium' | 'high';

export interface VettingCheck {
  id: string;
  category: 'manifest' | 'scopes' | 'outbound' | 'data' | 'identity';
  status: CheckStatus;
  detail: string;
  evidence?: string[];
}

export interface VettingReportRow {
  id: string;
  version_id: string;
  manifest_hash: string;
  endpoint_url: string | null;
  verdict: CheckStatus;
  risk_tier: RiskTier;
  checks: VettingCheck[];
  data_exposure: { classification: string; jobFields: string[]; customerFields: string[] };
  outbound_domains: string[];
  created_at: string;
}

export type ChecklistAnswer = 'pass' | 'fail' | 'na';

export interface ChecklistItemState {
  slug: string;
  category: 'identity' | 'security' | 'data' | 'behavior' | 'commercial' | 'legal';
  allows_na: boolean;
  needs_counsel: boolean;
  applies: boolean;
  answer: ChecklistAnswer | null;
  note: string | null;
}

export interface ReviewState {
  version_id: string;
  status: string;
  report: VettingReportRow | null;
  items: ChecklistItemState[];
  blockers: string[];
  ready: boolean;
}

export const DELIST_REASONS = ['security', 'privacy', 'policy', 'fraud', 'quality', 'publisher_request', 'legal', 'other'] as const;
export type DelistReason = (typeof DELIST_REASONS)[number];

export const BLOCKER_CODES = [
  'self_review', 'agent_suspended', 'agent_delisted', 'no_report', 'report_manifest_mismatch', 'report_endpoint_mismatch',
  'report_stale', 'report_failed', 'checklist_failed', 'checklist_incomplete', 'version_missing',
] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];

export const MIN_NOTE = 5;

export interface DelistingEvent {
  id: number;
  agent_id: string;
  agent_slug: string;
  action: 'delisted' | 'reinstated';
  reason_code: DelistReason | null;
  detail: string;
  installs_revoked: number;
  created_at: string;
}

// ---------------------------------------------------------------- pure helpers --

/** Extracts blocker codes from the database error 'APPROVAL_BLOCKED: a,b'. Unknown codes are dropped. */
export function parseApprovalBlockers(message: string | null | undefined): BlockerCode[] {
  const m = /APPROVAL_BLOCKED:\s*([a-z_,\s]+)/i.exec(message ?? '');
  if (!m) return [];
  const known = new Set<string>(BLOCKER_CODES);
  return m[1].split(',').map((s) => s.trim()).filter((s): s is BlockerCode => known.has(s));
}

export function checklistProgress(items: readonly ChecklistItemState[]): { total: number; done: number; failed: number; complete: boolean } {
  const applicable = items.filter((i) => i.applies);
  const done = applicable.filter((i) => i.answer === 'pass' || i.answer === 'na').length;
  const failed = applicable.filter((i) => i.answer === 'fail').length;
  return { total: applicable.length, done, failed, complete: done === applicable.length && failed === 0 };
}

/** Client-side mirror of the server rule, used only to enable/disable buttons. The server is the authority. */
export function noteIsValid(note: string | null | undefined): boolean {
  return (note ?? '').trim().length >= MIN_NOTE;
}

export function answerNeedsNote(answer: ChecklistAnswer): boolean {
  return answer !== 'pass';
}

export function groupChecks(checks: readonly VettingCheck[]): Record<VettingCheck['category'], VettingCheck[]> {
  const out: Record<VettingCheck['category'], VettingCheck[]> = { manifest: [], scopes: [], outbound: [], data: [], identity: [] };
  for (const c of checks) out[c.category]?.push(c);
  return out;
}

export function worstStatus(checks: readonly Pick<VettingCheck, 'status'>[]): CheckStatus {
  return checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
}

export type StaffErrorKind = 'forbidden' | 'blocked' | 'notFound' | 'generic';

export function classifyError(message: string | null | undefined): StaffErrorKind {
  const m = (message ?? '').toLowerCase();
  if (m.includes('staff only') || m.includes('permission denied')) return 'forbidden';
  if (m.includes('approval_blocked')) return 'blocked';
  if (m.includes('not found')) return 'notFound';
  return 'generic';
}

// ---------------------------------------------------------------- data access --

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export async function runVetting(versionId: string): Promise<VettingReportRow> {
  const { data, error } = await supabase.functions.invoke('marketplace-vetting', { body: { versionId } });
  if (error) throw new Error(error.message);
  const report = (data as { report?: VettingReportRow } | null)?.report;
  if (!report) throw new Error('No report returned');
  return report;
}

export const getReviewState = (versionId: string) => rpc<ReviewState>('get_marketplace_review_state', { p_version_id: versionId });

export const saveChecklistAnswer = (versionId: string, slug: string, answer: ChecklistAnswer, note: string | null) =>
  rpc<unknown>('save_marketplace_review_answer', { p_version_id: versionId, p_item_slug: slug, p_answer: answer, p_note: note });

export const requestChanges = (versionId: string, notes: string) =>
  rpc<unknown>('request_marketplace_changes', { p_version_id: versionId, p_notes: notes });

export const delistAgent = (agentId: string, reason: DelistReason, internalDetail: string, publisherMessage: string) =>
  rpc<{ installs_revoked: number }>('delist_marketplace_agent', {
    p_agent_id: agentId, p_reason_code: reason, p_internal_detail: internalDetail, p_publisher_message: publisherMessage,
  });

export const reinstateAgent = (agentId: string, detail: string) =>
  rpc<unknown>('reinstate_marketplace_agent', { p_agent_id: agentId, p_detail: detail });

export async function fetchStaffAgents(): Promise<MarketplaceAgent[]> {
  const { data, error } = await supabase.from('marketplace_agents').select('*').in('status', ['published', 'suspended', 'delisted']).order('name');
  if (error) throw new Error(error.message);
  return (data ?? []) as MarketplaceAgent[];
}

export async function fetchDelistingEvents(limit = 50): Promise<DelistingEvent[]> {
  const { data, error } = await supabase.from('marketplace_delisting_events')
    .select('id, agent_id, agent_slug, action, reason_code, detail, installs_revoked, created_at').order('id', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as DelistingEvent[];
}

export type { ReviewQueueItem };
