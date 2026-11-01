import { useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOptimisticMutation } from '@/hooks/useOptimisticMutation';
import { useUndoableActions } from '@/hooks/useUndoableActions';
import { ConflictError, type AppError } from '@/lib/trust/appError';
import { updateWithVersion, type Row, type VersionedClient } from '@/lib/trust/conflict';
import { snapshotRows, type RevertGuard, type UndoTable } from '@/lib/undo/undoEngine';

type Q = PromiseLike<{ data: { id: string }[] | null; error: unknown }> & { select(c: string): Q; eq(c: string, v: unknown): Q };
interface UpdateClient {
  from(t: string): { update(p: Record<string, unknown>): Q };
}
const client = supabase as unknown as UpdateClient;

export interface OptimisticUpdateArgs<T extends { id: string }> {
  table: UndoTable;
  /** The row as it is BEFORE the change. */
  row: T;
  patch: Record<string, unknown>;
  /** Apply the patch to local state NOW (list + any open drawer). */
  applyLocal: (patch: Record<string, unknown>) => void;
  /** Put the previous values back (rollback AND undo). */
  revertLocal: (before: Record<string, unknown>) => void;
  noun: { singular: string; plural: string };
  /** Success toast / undo toast text, e.g. "Job moved to Done." */
  message: string;
  /** Rows no longer holding this value were changed by someone else and are not reverted by Undo. */
  guard?: RevertGuard;
  audit?: 'status_change';
  /** Opt in to optimistic concurrency: pass `row.row_version` AND handle `onSaved`, or later edits will conflict with themselves. */
  expectedVersion?: number;
  onSaved?: (serverRow: Row) => void;
  /** Return true if you handled the failure yourself (quality gates, conflict dialog). */
  onFailure?: (error: AppError, cause: unknown) => boolean;
}

/**
 * Optimistic single-record update: UI changes instantly, the write runs in the
 * background (serialised per record), failure rolls back with an explanation,
 * Retry and — on success — the existing 10 s Undo toast.
 *
 * RLS note: a PostgREST UPDATE that RLS filters out returns NO error and zero
 * rows, so we ask for the affected ids and treat "0 rows" as a permission failure.
 */
export function useOptimisticUpdate() {
  const { mutate } = useOptimisticMutation();
  const undoable = useUndoableActions();

  return useCallback(
    <T extends { id: string }>(a: OptimisticUpdateArgs<T>) => {
      const before = snapshotRows([a.row], Object.keys(a.patch))[0]?.before ?? {};
      return mutate({
        key: `${a.table}:${a.row.id}`,
        vars: a.patch,
        apply: (patch) => {
          a.applyLocal(patch);
          return before;
        },
        run: async (patch) => {
          if (a.expectedVersion !== undefined) {
            const r = await updateWithVersion(supabase as unknown as VersionedClient, a.table, a.row.id, a.expectedVersion, patch);
            if (r.status === 'ok') return r.row;
            if (r.status === 'conflict') throw new ConflictError(r.current);
            if (r.status === 'gone') throw { code: 'PGRST116', message: 'record gone' };
            throw r.error;
          }
          const { data, error } = await client.from(a.table).update(patch).eq('id', a.row.id).select('id');
          if (error) throw error;
          if (!data || data.length === 0) throw { code: '42501', message: 'no rows updated' };
          return null;
        },
        rollback: (snap) => a.revertLocal(snap),
        onFailure: a.onFailure,
        onSuccess: (serverRow) => {
          if (serverRow && a.onSaved) a.onSaved(serverRow);
          undoable.updateOne({
            table: a.table,
            row: a.row,
            patch: a.patch,
            guard: a.guard,
            noun: a.noun,
            message: a.message,
            audit: a.audit,
            onReverted: a.revertLocal,
          });
        },
      });
    },
    [mutate, undoable],
  );
}
