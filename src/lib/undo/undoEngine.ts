/**
 * Undo engine for destructive dashboard actions. Pure logic: the Supabase
 * clients are injected (structural types) so everything is unit-testable
 * without a network, exactly like `lib/bulk/engine.ts`.
 *
 * Two strategies:
 *  - DELETE  -> server-side soft delete (`soft_delete_records`) + `restore_records`.
 *  - UPDATE  -> before-snapshot + conflict-guarded inverse update. The inverse
 *               only touches rows that STILL hold the value we wrote, so an
 *               undo can never overwrite a newer change made by a teammate.
 */
import { chunk, mapWithConcurrency, ROW_CONCURRENCY, type BulkFailure, type BulkResult, type BulkTable } from '@/lib/bulk/engine';

export const UNDO_WINDOW_MS = 10_000;
export const SOFT_DELETE_CHUNK = 500; // must stay <= the server-side cap (1000)

export type UndoTable = BulkTable;

export interface UndoOutcome {
  ok: boolean;
  message: string;
}

/* ───────────────────────────── soft delete ───────────────────────────── */

export type RpcFn = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export interface SoftDeleteResult extends BulkResult {
  /** One id per server batch (a delete of >500 rows is split). Pass to `restoreSoftDeleted`. */
  undoIds: string[];
}

interface SoftDeletePayload {
  undo_id?: string | null;
  deleted?: string[];
  failed?: { id: string; reason?: string }[];
}

export async function softDeleteRecords(
  rpc: RpcFn,
  table: UndoTable,
  rows: { id: string; label?: string }[],
): Promise<SoftDeleteResult> {
  const unique = Array.from(new Map(rows.map((r) => [r.id, r])).values());
  const result: SoftDeleteResult = { requested: unique.length, succeeded: [], failed: [], skipped: [], undoIds: [] };
  for (const part of chunk(unique, SOFT_DELETE_CHUNK)) {
    try {
      const { data, error } = await rpc('soft_delete_records', {
        p_table: table,
        p_ids: part.map((r) => r.id),
        p_labels: part.slice(0, 50).map((r) => r.label ?? ''),
      });
      if (error) throw new Error(error.message);
      const payload = (data ?? {}) as SoftDeletePayload;
      result.succeeded.push(...(payload.deleted ?? []));
      (payload.failed ?? []).forEach((f) => result.failed.push({ id: f.id, reason: f.reason ?? 'Could not delete.' }));
      if (payload.undo_id) result.undoIds.push(payload.undo_id);
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'Unexpected error.';
      part.forEach((r) => result.failed.push({ id: r.id, reason }));
    }
  }
  return result;
}

export interface RestoreResult {
  restored: string[];
  failed: BulkFailure[];
}

export async function restoreSoftDeleted(rpc: RpcFn, undoIds: string[]): Promise<RestoreResult> {
  const out: RestoreResult = { restored: [], failed: [] };
  for (const id of undoIds) {
    try {
      const { data, error } = await rpc('restore_records', { p_batch_id: id });
      if (error) throw new Error(error.message);
      const payload = (data ?? {}) as { restored?: string[]; failed?: { id: string; reason?: string }[] };
      out.restored.push(...(payload.restored ?? []));
      (payload.failed ?? []).forEach((f) => out.failed.push({ id: f.id, reason: f.reason ?? 'Could not restore.' }));
    } catch (e) {
      out.failed.push({ id, reason: e instanceof Error ? e.message : 'Unexpected error.' });
    }
  }
  return out;
}

/* ─────────────────────────── conflict-guarded revert ─────────────────────────── */

export interface RevertQuery extends PromiseLike<{ data?: { id: string }[] | null; error: { message: string } | null }> {
  in(column: string, values: string[]): RevertQuery;
  eq(column: string, value: unknown): RevertQuery;
  is(column: string, value: null): RevertQuery;
  select(columns: string): RevertQuery;
}
export interface RevertClient {
  from(table: string): { update(patch: Record<string, unknown>): RevertQuery };
}

/** What a row looked like before the change. Only keys the row actually carried are captured. */
export interface RowSnapshot {
  id: string;
  before: Record<string, unknown>;
}

export function snapshotRows<T extends { id: string }>(rows: T[], keys: string[]): RowSnapshot[] {
  return rows.map((row) => {
    const rec = row as unknown as Record<string, unknown>;
    const before: Record<string, unknown> = {};
    for (const k of keys) if (k in rec && rec[k] !== undefined) before[k] = rec[k];
    return { id: row.id, before };
  });
}

export interface RevertGroup {
  ids: string[];
  patch: Record<string, unknown>;
}

/** Groups rows that share an identical "before" patch so we issue one statement per distinct value. */
export function planRevert(snapshots: RowSnapshot[], onlyIds?: string[]): RevertGroup[] {
  const allowed = onlyIds ? new Set(onlyIds) : null;
  const groups = new Map<string, RevertGroup>();
  for (const s of snapshots) {
    if (allowed && !allowed.has(s.id)) continue;
    if (Object.keys(s.before).length === 0) continue;
    const key = JSON.stringify(Object.entries(s.before).sort(([a], [b]) => a.localeCompare(b)));
    const g = groups.get(key) ?? { ids: [], patch: s.before };
    g.ids.push(s.id);
    groups.set(key, g);
  }
  return Array.from(groups.values());
}

export interface RevertGuard {
  column: string;
  /** The value WE wrote. Rows no longer holding it were changed by someone else and are left alone. */
  value: unknown;
}

export interface RevertResult {
  reverted: string[];
  conflicts: string[];
  failed: BulkFailure[];
}

function guarded(q: RevertQuery, guard?: RevertGuard): RevertQuery {
  if (!guard) return q;
  return guard.value === null || guard.value === undefined ? q.is(guard.column, null) : q.eq(guard.column, guard.value);
}

export async function revertUpdates(
  client: RevertClient,
  table: UndoTable,
  groups: RevertGroup[],
  guard?: RevertGuard,
): Promise<RevertResult> {
  const out: RevertResult = { reverted: [], conflicts: [], failed: [] };
  const rowByRow = async (g: RevertGroup, ids: string[]) => {
    const res = await mapWithConcurrency(ids, ROW_CONCURRENCY, async (id) => {
      try {
        const { data, error } = await guarded(client.from(table).update(g.patch).in('id', [id]), guard).select('id');
        if (error) return { id, error: error.message };
        return { id, hit: (data ?? []).length > 0 };
      } catch (e) {
        return { id, error: e instanceof Error ? e.message : 'Unexpected error.' };
      }
    });
    for (const r of res) {
      if ('error' in r && r.error) out.failed.push({ id: r.id, reason: r.error });
      else if ('hit' in r && r.hit) out.reverted.push(r.id);
      else out.conflicts.push(r.id);
    }
  };
  for (const g of groups) {
    for (const part of chunk(g.ids)) {
      try {
        const { data, error } = await guarded(client.from(table).update(g.patch).in('id', part), guard).select('id');
        if (error) {
          await rowByRow(g, part);
          continue;
        }
        const hit = new Set((data ?? []).map((r) => r.id));
        for (const id of part) (hit.has(id) ? out.reverted : out.conflicts).push(id);
      } catch {
        await rowByRow(g, part);
      }
    }
  }
  return out;
}

/* ───────────────────────────── messages & lists ───────────────────────────── */

type Noun = { singular: string; plural: string };

export function summarizeRevert(r: RevertResult, noun: Noun): UndoOutcome {
  const n = r.reverted.length;
  const label = (c: number) => (c === 1 ? noun.singular : noun.plural);
  if (n === 0 && r.failed.length === 0 && r.conflicts.length === 0) return { ok: false, message: 'Nothing to undo.' };
  let msg = n > 0 ? `Undone — ${n} ${label(n)} reverted.` : `Nothing was reverted.`;
  if (r.conflicts.length) msg += ` ${r.conflicts.length} changed since and ${r.conflicts.length === 1 ? 'was' : 'were'} left as is.`;
  if (r.failed.length) msg += ` ${r.failed.length} failed (${r.failed[0].reason}).`;
  return { ok: n > 0 && r.failed.length === 0, message: msg };
}

export function summarizeRestore(r: RestoreResult, noun: Noun): UndoOutcome {
  const n = r.restored.length;
  const label = (c: number) => (c === 1 ? noun.singular : noun.plural);
  if (n === 0 && r.failed.length === 0) return { ok: false, message: 'Nothing to restore.' };
  let msg = n > 0 ? `Restored ${n} ${label(n)}.` : `Nothing was restored.`;
  if (r.failed.length) msg += ` ${r.failed.length} could not be restored (${r.failed[0].reason}).`;
  return { ok: n > 0 && r.failed.length === 0, message: msg };
}

/**
 * Puts restored rows back into a list that is ordered by `orderKey` DESC
 * (every dashboard list is fetched newest-first). De-duplicates by id, so a
 * realtime refetch racing the restore can never produce a double row.
 */
export function mergeRestored<T extends { id: string }>(prev: T[], restored: T[], orderKey: keyof T & string): T[] {
  const have = new Set(prev.map((r) => r.id));
  const fresh = restored.filter((r) => !have.has(r.id));
  if (fresh.length === 0) return prev;
  const time = (r: T) => {
    const v = r[orderKey] as unknown;
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  return [...prev, ...fresh].sort((a, b) => {
    const d = time(b) - time(a);
    return Number.isNaN(d) ? 0 : d; // Infinity - Infinity (both missing the key) must not poison the sort
  });
}
