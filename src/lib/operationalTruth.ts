import { supabase } from '@/lib/supabase';
import type {
  FactState,
  TruthPolicy,
  TruthVerdict,
} from '../../supabase/functions/_shared/truth/engine';

/**
 * Vireek Operational Truth Engine — dashboard client.
 *
 * Every verdict is computed server-side (supabase/functions/operational-truth) by the
 * pure engine in _shared/truth/engine.ts. This module only invokes it and holds display
 * metadata. Types are imported type-only from the engine so the client can never drift
 * from the server.
 */

export type { FactState, TruthPolicy, TruthVerdict };

// ---------------------------------------------------------------------------
// Payload types (mirror the `overview` action)
// ---------------------------------------------------------------------------

export interface TruthClaimView {
  id: string;
  value: unknown;
  source_key: string;
  source_label: string;
  authoritative: boolean;
  verified_at: string;
  expires_at: string | null;
  evidence_count: number;
  state: FactState;
  effective_confidence: number;
}

export interface TruthItem {
  subject_type: string;
  subject_id: string;
  subject_label: string;
  predicate: string;
  verdict: TruthVerdict;
  allow: boolean;
  confidence: number;
  reason: string;
  required_action: string | null;
  warnings: string[];
  policy: TruthPolicy;
  claims: TruthClaimView[];
}

export interface TruthConflictView {
  id: string;
  subject_type: string;
  subject_id: string;
  subject_label: string;
  predicate: string;
  fact_ids: string[];
  opened_at: string;
}

export interface TruthBlockedDecision {
  id: string;
  agent: string;
  subject_type: string;
  subject_id: string;
  subject_label: string;
  predicate: string;
  verdict: TruthVerdict;
  reason: string | null;
  created_at: string;
}

export interface TruthSourceView {
  key: string;
  label: string;
  kind: string;
  reliability: number;
  authoritative: boolean;
  user_assertable: boolean;
}

export interface TruthOverview {
  now: string;
  truncated: boolean;
  summary: {
    claims: number;
    facts_tracked: number;
    verified: number;
    needs_attention: number;
    expiring_soon: number;
    open_conflicts: number;
    by_verdict: Partial<Record<TruthVerdict, number>>;
    decisions_7d: number;
    blocked_7d: number;
  };
  items: TruthItem[];
  conflicts: TruthConflictView[];
  recent_blocked: TruthBlockedDecision[];
  sources: TruthSourceView[];
}

export interface AssertClaimInput {
  subject_type: string;
  subject_id: string;
  predicate: string;
  value: boolean;
  source_key: string;
  expires_at: string | null;
  evidence: Array<{ kind: 'document' | 'photo' | 'record' | 'note'; uri?: string; excerpt?: string }>;
}

export interface TruthPolicyRow {
  id: string;
  predicate: string;
  min_confidence: number;
  max_age_days: number;
  min_independent_sources: number;
  expiring_warning_days: number;
}

// ---------------------------------------------------------------------------
// Display metadata
// ---------------------------------------------------------------------------

export const VERDICT_META: Record<TruthVerdict, { label: string; tone: string; summary: string }> = {
  verified: { label: 'Verified', tone: 'bg-success-500/10 text-success-500', summary: 'Fresh, corroborated and conflict-free — agents may act on it.' },
  conflict: { label: 'Conflict', tone: 'bg-danger/10 text-danger', summary: 'Trusted sources disagree. Agents are blocked until you resolve it.' },
  expired: { label: 'Expired', tone: 'bg-danger/10 text-danger', summary: 'Every record has passed its expiry date.' },
  stale: { label: 'Stale', tone: 'bg-warning-500/10 text-warning-500', summary: 'Older than the freshness limit — re-verify before agents act.' },
  unverified: { label: 'Unverified', tone: 'bg-bg-tertiary text-text-secondary', summary: 'No verified record exists.' },
  low_confidence: { label: 'Low confidence', tone: 'bg-warning-500/10 text-warning-500', summary: 'Below the confidence this fact requires. Add evidence or an authority.' },
  insufficient_corroboration: { label: 'Needs 2nd source', tone: 'bg-warning-500/10 text-warning-500', summary: 'Policy requires more independent sources.' },
  denied: { label: 'Denied', tone: 'bg-danger/10 text-danger', summary: 'The verified value does not permit this action.' },
};

export const STATE_META: Record<FactState, { label: string; tone: string }> = {
  fresh: { label: 'Fresh', tone: 'text-success-500' },
  aging: { label: 'Aging', tone: 'text-warning-500' },
  stale: { label: 'Stale', tone: 'text-warning-500' },
  expired: { label: 'Expired', tone: 'text-danger' },
};

export const SUBJECT_TYPES = [
  { value: 'technician', label: 'Technician' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'customer', label: 'Customer' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'job', label: 'Job' },
];

/** Sources a logged-in user may assert. Authorities can only be written by verified integrations. */
export const USER_SOURCES = [
  { value: 'document_upload', label: 'Uploaded document (strongest)' },
  { value: 'field_observation', label: 'Field observation' },
  { value: 'owner_entered', label: 'Owner entered' },
  { value: 'customer_stated', label: 'Customer stated' },
];

export const PREDICATE_SUGGESTIONS = [
  'credential.hvac_license',
  'credential.epa_608',
  'credential.electrical_license',
  'qualification.equipment.carrier_infinity',
  'insurance.general_liability',
  'equipment.warranty_active',
  'pricing.labor_rate_confirmed',
];

export function formatConfidence(fraction: number): string {
  return `${(fraction * 100).toFixed(fraction >= 0.995 ? 1 : 0)}%`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function describeExpiry(iso: string | null, nowIso: string): string {
  if (!iso) return 'No expiry';
  const days = Math.ceil((Date.parse(iso) - Date.parse(nowIso)) / 86_400_000);
  if (days <= 0) return `Expired ${formatDate(iso)}`;
  return days === 1 ? 'Expires tomorrow' : `Expires in ${days} days`;
}

export function formatClaimValue(value: unknown): string {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function prettyPredicate(predicate: string): string {
  return predicate.replace(/\./g, ' › ').replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function extractInvokeError(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx && typeof (ctx as Response).json === 'function') {
    try {
      const body = (await (ctx as Response).clone().json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      // fall through
    }
  }
  return error instanceof Error ? error.message : fallback;
}

async function call<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke('operational-truth', { body });
  if (error) throw new Error(await extractInvokeError(error, fallback));
  if (data?.error) throw new Error(String(data.error));
  return data as T;
}

export function fetchTruthOverview(): Promise<TruthOverview> {
  return call<TruthOverview>({ action: 'overview' }, 'Could not load the Truth Engine.');
}

export async function assertClaim(input: AssertClaimInput): Promise<void> {
  await call({ action: 'assert', assertion: { ...input, method: 'dashboard' } }, 'Could not record this claim.');
}

export async function confirmClaim(factId: string, expiresAt: string | null, note?: string): Promise<void> {
  await call({ action: 'verify', factId, result: 'confirmed', expires_at: expiresAt, note }, 'Could not confirm this claim.');
}

export async function rejectClaim(factId: string, note?: string): Promise<void> {
  await call({ action: 'verify', factId, result: 'rejected', note }, 'Could not reject this claim.');
}

export async function resolveTruthConflict(conflictId: string, winningFactId: string, note?: string): Promise<void> {
  await call({ action: 'resolve_conflict', conflictId, winningFactId, note }, 'Could not resolve this conflict.');
}

// ---------------------------------------------------------------------------
// Policies (owner-editable through RLS)
// ---------------------------------------------------------------------------

export async function fetchTruthPolicies(): Promise<TruthPolicyRow[]> {
  const { data, error } = await supabase
    .from('truth_policies')
    .select('id, predicate, min_confidence, max_age_days, min_independent_sources, expiring_warning_days')
    .order('predicate');
  if (error) throw new Error('Could not load policies.');
  return (data ?? []).map((p) => ({ ...p, min_confidence: Number(p.min_confidence) })) as TruthPolicyRow[];
}

export async function saveTruthPolicy(policy: Omit<TruthPolicyRow, 'id'>, userId: string): Promise<void> {
  const { error } = await supabase
    .from('truth_policies')
    .upsert({ ...policy, user_id: userId }, { onConflict: 'user_id,predicate' });
  if (error) throw new Error('Could not save this policy.');
}

export async function deleteTruthPolicy(id: string): Promise<void> {
  const { error } = await supabase.from('truth_policies').delete().eq('id', id);
  if (error) throw new Error('Could not delete this policy.');
}

export async function fetchTechnicianOptions(): Promise<Array<{ id: string; name: string }>> {
  const { data } = await supabase.from('team_members').select('id, member_name').order('member_name');
  return (data ?? [])
    .filter((t) => t.member_name)
    .map((t) => ({ id: t.id as string, name: t.member_name as string }));
}
