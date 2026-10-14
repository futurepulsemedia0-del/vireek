/**
 * Duplicate detection + merge (customers & leads).
 *
 * Detection runs in the database (normalised phone / email / address,
 * scoped to the account owner). Merging re-parents every row that points at
 * the merged-away record and writes a ledger so the whole merge can be
 * undone for UNMERGE_WINDOW_DAYS. See
 * supabase/migrations/20270403000000_duplicate_detection_merge.sql.
 */

import { supabase } from '@/lib/supabase';
import type { UserPermissions } from '@/contexts/AuthContext';

/** Keep in sync with the 7-day interval in merge_records(). */
export const UNMERGE_WINDOW_DAYS = 7;

export type DuplicateKind = 'customers' | 'leads';
export const DUPLICATE_KINDS: readonly DuplicateKind[] = ['customers', 'leads'];

export const DUPLICATE_KIND_LABELS: Record<DuplicateKind, { singular: string; plural: string }> = {
  customers: { singular: 'customer', plural: 'Customers' },
  leads: { singular: 'lead', plural: 'Leads' },
};

export type MatchReason = 'phone' | 'email' | 'address';
export type Confidence = 'high' | 'medium';

export const REASON_LABELS: Record<MatchReason, string> = {
  phone: 'Same phone',
  email: 'Same email',
  address: 'Same address',
};

export type FieldChoice = 'survivor' | 'merged' | 'both';

export interface DuplicateRecord {
  id: string;
  name: string;
  created_at?: string | null;
  [field: string]: string | null | undefined;
}

export interface DuplicatePair {
  key: string;
  kind: DuplicateKind;
  a: DuplicateRecord;
  b: DuplicateRecord;
  reasons: MatchReason[];
  confidence: Confidence;
  score: number;
}

export interface MergeField {
  key: string;
  label: string;
  /** Only free-text notes can be concatenated. */
  allowBoth?: boolean;
}

/** Must match the whitelist in merge_records(). */
export const MERGE_FIELDS: Record<DuplicateKind, readonly MergeField[]> = {
  customers: [
    { key: 'name', label: 'Name' },
    { key: 'phone', label: 'Phone' },
    { key: 'email', label: 'Email' },
    { key: 'address', label: 'Address' },
    { key: 'customer_type', label: 'Type' },
  ],
  leads: [
    { key: 'name', label: 'Name' },
    { key: 'phone', label: 'Phone' },
    { key: 'email', label: 'Email' },
    { key: 'service_interested', label: 'Service' },
    { key: 'notes', label: 'Notes', allowBoth: true },
  ],
};

export interface MergeResult {
  merge_id: string;
  moved: Record<string, number>;
  skipped: Record<string, number>;
  irreversible: string[];
  expires_at: string;
}

export interface UnmergeResult {
  restored: Record<string, number>;
  not_restored: string[];
  kind: DuplicateKind;
  survivor_id: string;
  merged_id: string;
}

export interface RecentMerge {
  id: string;
  kind: DuplicateKind;
  survivor_id: string;
  merged_id: string;
  survivor_name: string | null;
  merged_name: string | null;
  merged_at: string;
  expires_at: string;
  merged_by_email: string | null;
  moved_total: number;
}

export type DuplicatesErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'window_closed'
  | 'not_active'
  | 'unmerge_conflict'
  | 'unknown';

export class DuplicatesError extends Error {
  readonly code: DuplicatesErrorCode;
  constructor(code: DuplicatesErrorCode, message: string) {
    super(message);
    this.name = 'DuplicatesError';
    this.code = code;
  }
}

function toDuplicatesError(error: { message?: string; code?: string }): DuplicatesError {
  const m = error.message ?? '';
  if (m.includes('merge_window_closed')) {
    return new DuplicatesError('window_closed', `The ${UNMERGE_WINDOW_DAYS}-day undo window for this merge has closed.`);
  }
  if (m.includes('unmerge_conflict')) {
    return new DuplicatesError(
      'unmerge_conflict',
      'Can\u2019t undo yet: another record now uses the same phone or email. Change one of them and try again.',
    );
  }
  if (m.includes('not_active')) return new DuplicatesError('not_active', 'This merge was already undone or finalised.');
  if (m.includes('not_found') || error.code === 'P0002') {
    return new DuplicatesError('not_found', 'One of these records no longer exists or was already merged.');
  }
  if (m.includes('forbidden') || error.code === '42501') {
    return new DuplicatesError('forbidden', "You don't have permission to do that.");
  }
  return new DuplicatesError('unknown', m || 'Something went wrong.');
}

/** Owner, or a team member with billing access. Mirrors can_manage_duplicates() in SQL. */
export function canManageDuplicates(isOwner: boolean, permissions: Pick<UserPermissions, 'can_view_billing'>): boolean {
  return isOwner || permissions.can_view_billing === true;
}

export function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim() === '';
}

/** What a field ends up as for a given choice (primary = the record that survives). */
export function resolveValue(
  choice: FieldChoice,
  primary: string | null | undefined,
  other: string | null | undefined,
): string | null {
  const p = isBlank(primary) ? null : primary!.trim();
  const o = isBlank(other) ? null : other!.trim();
  if (choice === 'merged') return o;
  if (choice === 'both') {
    const parts = [p, o].filter((v): v is string => v !== null);
    return parts.length > 0 ? parts.join('\n\n') : null;
  }
  return p;
}

/**
 * Sensible starting choices: keep the primary's value, but fill gaps from the
 * other record, and keep both versions of free-text notes.
 */
export function defaultChoices(
  kind: DuplicateKind,
  primary: DuplicateRecord,
  other: DuplicateRecord,
): Record<string, FieldChoice> {
  const out: Record<string, FieldChoice> = {};
  for (const f of MERGE_FIELDS[kind]) {
    const p = primary[f.key];
    const o = other[f.key];
    if (isBlank(p) && !isBlank(o)) out[f.key] = 'merged';
    else if (f.allowBoth && !isBlank(p) && !isBlank(o) && p!.trim() !== o!.trim()) out[f.key] = 'both';
    else out[f.key] = 'survivor';
  }
  return out;
}

/** Only the choices that change the primary — that's all the server needs. */
export function changedChoices(choices: Record<string, FieldChoice>): Record<string, FieldChoice> {
  return Object.fromEntries(Object.entries(choices).filter(([, c]) => c !== 'survivor'));
}

/** Whole days left to undo a merge (never negative). */
export function daysLeftToUnmerge(expiresAt: string, now: number = Date.now()): number {
  const ms = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** "home_service_passports" -> "Home service passports". */
export function humanizeTable(table: string): string {
  const s = table.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function totalMoved(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

/** Records with more history win; ties go to the older record. */
export function pickDefaultPrimary(
  a: DuplicateRecord,
  b: DuplicateRecord,
  aCounts: Record<string, number> | null,
  bCounts: Record<string, number> | null,
): 'a' | 'b' {
  const ta = aCounts ? totalMoved(aCounts) : 0;
  const tb = bCounts ? totalMoved(bCounts) : 0;
  if (ta !== tb) return ta > tb ? 'a' : 'b';
  const da = a.created_at ? new Date(a.created_at).getTime() : Infinity;
  const db = b.created_at ? new Date(b.created_at).getTime() : Infinity;
  return da <= db ? 'a' : 'b';
}

// ── RPC wrappers ────────────────────────────────────────────────────────────

interface PairRow {
  kind: DuplicateKind;
  a_id: string;
  b_id: string;
  reasons: MatchReason[];
  confidence: Confidence;
  score: number;
  a: DuplicateRecord;
  b: DuplicateRecord;
  total_count: number | string;
}

export async function fetchDuplicatePairs(
  kind: DuplicateKind,
  limit = 10,
  offset = 0,
): Promise<{ pairs: DuplicatePair[]; total: number }> {
  const { data, error } = await supabase.rpc('find_duplicate_pairs', { p_kind: kind, p_limit: limit, p_offset: offset });
  if (error) throw toDuplicatesError(error);
  const rows = (data ?? []) as PairRow[];
  return {
    total: rows.length > 0 ? Number(rows[0].total_count) : 0,
    pairs: rows.map((r) => ({
      key: `${r.a_id}:${r.b_id}`,
      kind: r.kind,
      a: r.a,
      b: r.b,
      reasons: r.reasons,
      confidence: r.confidence,
      score: r.score,
    })),
  };
}

export async function fetchDuplicateCounts(): Promise<Record<DuplicateKind, number>> {
  const { data, error } = await supabase.rpc('duplicate_counts');
  if (error) throw toDuplicatesError(error);
  const out: Record<DuplicateKind, number> = { customers: 0, leads: 0 };
  for (const row of (data ?? []) as { kind: string; n: number | string }[]) {
    if (row.kind === 'customers' || row.kind === 'leads') out[row.kind] = Number(row.n);
  }
  return out;
}

export async function fetchRelatedCounts(kind: DuplicateKind, id: string): Promise<Record<string, number>> {
  const { data, error } = await supabase.rpc('duplicate_related_counts', { p_kind: kind, p_id: id });
  if (error) throw toDuplicatesError(error);
  return Object.fromEntries(Object.entries((data ?? {}) as Record<string, number | string>).map(([k, v]) => [k, Number(v)]));
}

export async function mergeRecords(
  kind: DuplicateKind,
  survivorId: string,
  mergedId: string,
  choices: Record<string, FieldChoice>,
): Promise<MergeResult> {
  const { data, error } = await supabase.rpc('merge_records', {
    p_kind: kind,
    p_survivor: survivorId,
    p_merged: mergedId,
    p_choices: changedChoices(choices),
  });
  if (error) throw toDuplicatesError(error);
  return data as MergeResult;
}

export async function unmergeRecords(mergeId: string): Promise<UnmergeResult> {
  const { data, error } = await supabase.rpc('unmerge_records', { p_merge_id: mergeId });
  if (error) throw toDuplicatesError(error);
  return data as UnmergeResult;
}

export async function dismissPair(kind: DuplicateKind, aId: string, bId: string): Promise<void> {
  const { error } = await supabase.rpc('dismiss_duplicate_pair', { p_kind: kind, p_a: aId, p_b: bId });
  if (error) throw toDuplicatesError(error);
}

export async function fetchRecentMerges(limit = 20): Promise<RecentMerge[]> {
  const { data, error } = await supabase.rpc('list_recent_merges', { p_limit: limit });
  if (error) throw toDuplicatesError(error);
  return ((data ?? []) as (RecentMerge & { moved_total: number | string })[]).map((r) => ({
    ...r,
    moved_total: Number(r.moved_total),
  }));
}
