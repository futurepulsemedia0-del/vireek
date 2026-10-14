/**
 * Trash (soft delete) — customers, jobs, quotes, invoices, leads.
 *
 * Deleting moves a record to /dashboard/trash for TRASH_RETENTION_DAYS;
 * it can be restored until then, after which a daily database job removes
 * it for good. Every mutation goes through SECURITY DEFINER RPCs (see
 * supabase/migrations/20270402000000_trash_soft_delete.sql) which scope to
 * the account owner, enforce permissions and write audit_log rows — the
 * client never touches deleted_at directly.
 */

import { supabase } from '@/lib/supabase';
import type { UserPermissions } from '@/contexts/AuthContext';

/** Keep in sync with public.trash_retention_days() in the migration. */
export const TRASH_RETENTION_DAYS = 30;
/** Matches the server-side cap per RPC call. */
export const TRASH_MAX_IDS_PER_CALL = 500;

export type TrashKind = 'customers' | 'jobs' | 'quotes' | 'invoices' | 'leads';

export const TRASH_KINDS: readonly TrashKind[] = ['customers', 'jobs', 'quotes', 'invoices', 'leads'];

export const TRASH_KIND_LABELS: Record<TrashKind, { singular: string; plural: string }> = {
  customers: { singular: 'Customer', plural: 'Customers' },
  jobs: { singular: 'Job', plural: 'Jobs' },
  quotes: { singular: 'Quote', plural: 'Quotes' },
  invoices: { singular: 'Invoice', plural: 'Invoices' },
  leads: { singular: 'Lead', plural: 'Leads' },
};

export interface TrashItem {
  kind: TrashKind;
  id: string;
  title: string;
  subtitle: string;
  deleted_at: string;
  deleted_by_email: string | null;
  purge_at: string;
}

export interface RestoreResult {
  restored: number;
  /** Items that could not be restored because a live record now clashes (e.g. same phone/email). */
  conflicts: number;
}

export type TrashErrorCode = 'forbidden' | 'legal_hold' | 'unknown';

export class TrashError extends Error {
  readonly code: TrashErrorCode;
  constructor(code: TrashErrorCode, message: string) {
    super(message);
    this.name = 'TrashError';
    this.code = code;
  }
}

function toTrashError(error: { message?: string; code?: string }): TrashError {
  const message = error.message ?? '';
  if (message.includes('legal_hold_active')) {
    return new TrashError('legal_hold', 'This account is under a legal hold, so items cannot be permanently deleted.');
  }
  if (message.includes('forbidden') || error.code === '42501') {
    return new TrashError('forbidden', "You don't have permission to do that.");
  }
  return new TrashError('unknown', message || 'Something went wrong.');
}

/** Owner, or a team member with billing access (also covers custom roles via AuthContext). */
export function canManageTrash(isOwner: boolean, permissions: Pick<UserPermissions, 'can_view_billing'>): boolean {
  return isOwner || permissions.can_view_billing === true;
}

/** Permanent deletion is owner-only. */
export function canPurgeTrash(isOwner: boolean): boolean {
  return isOwner;
}

/** Whole days left before automatic permanent deletion (never negative). */
export function daysUntilPurge(purgeAt: string, now: number = Date.now()): number {
  const ms = new Date(purgeAt).getTime() - now;
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

export function chunkIds(ids: readonly string[], size: number = TRASH_MAX_IDS_PER_CALL): string[][] {
  const unique = Array.from(new Set(ids));
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += size) out.push(unique.slice(i, i + size));
  return out;
}

/** Move records to the trash. Returns how many were actually moved. */
export async function softDeleteRecords(kind: TrashKind, ids: readonly string[]): Promise<number> {
  let total = 0;
  for (const chunk of chunkIds(ids)) {
    const { data, error } = await supabase.rpc('soft_delete_records', { p_kind: kind, p_ids: chunk });
    if (error) throw toTrashError(error);
    total += Number(data ?? 0);
  }
  return total;
}

export async function restoreRecords(kind: TrashKind, ids: readonly string[]): Promise<RestoreResult> {
  const result: RestoreResult = { restored: 0, conflicts: 0 };
  for (const chunk of chunkIds(ids)) {
    const { data, error } = await supabase.rpc('restore_records', { p_kind: kind, p_ids: chunk });
    if (error) throw toTrashError(error);
    const row = (data ?? {}) as Partial<RestoreResult>;
    result.restored += Number(row.restored ?? 0);
    result.conflicts += Number(row.conflicts ?? 0);
  }
  return result;
}

/** Permanently delete items that are already in the trash (owner only). */
export async function purgeRecords(kind: TrashKind, ids: readonly string[]): Promise<number> {
  let total = 0;
  for (const chunk of chunkIds(ids)) {
    const { data, error } = await supabase.rpc('purge_records', { p_kind: kind, p_ids: chunk });
    if (error) throw toTrashError(error);
    total += Number(data ?? 0);
  }
  return total;
}

export interface FetchTrashParams {
  kind?: TrashKind | null;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function fetchTrash({ kind = null, search = '', limit = 25, offset = 0 }: FetchTrashParams = {}): Promise<TrashItem[]> {
  const { data, error } = await supabase.rpc('list_trash', {
    p_kind: kind,
    p_search: search.trim() || null,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw toTrashError(error);
  return (data ?? []) as TrashItem[];
}

export async function fetchTrashCounts(): Promise<Record<TrashKind, number>> {
  const { data, error } = await supabase.rpc('trash_counts');
  if (error) throw toTrashError(error);
  const counts: Record<TrashKind, number> = { customers: 0, jobs: 0, quotes: 0, invoices: 0, leads: 0 };
  for (const row of (data ?? []) as { kind: string; n: number | string }[]) {
    if ((TRASH_KINDS as readonly string[]).includes(row.kind)) counts[row.kind as TrashKind] = Number(row.n);
  }
  return counts;
}
