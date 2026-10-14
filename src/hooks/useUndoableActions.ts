import { useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useUndo } from '@/contexts/UndoContext';
import { logBulkAudit, type AuditRpc } from '@/lib/bulk/audit';
import {
  planRevert,
  restoreSoftDeleted,
  revertUpdates,
  snapshotRows,
  softDeleteRecords,
  summarizeRestore,
  summarizeRevert,
  type RevertClient,
  type RevertGuard,
  type RpcFn,
  type UndoTable,
} from '@/lib/undo/undoEngine';

const rpcFn: RpcFn = (fn, args) => supabase.rpc(fn, args) as unknown as ReturnType<RpcFn>;
const auditRpc: AuditRpc = (fn, args) => supabase.rpc(fn, args) as unknown as ReturnType<AuditRpc>;
const revertClient = supabase as unknown as RevertClient;

type Noun = { singular: string; plural: string };
type ChangeAudit = 'status_change' | 'undo_status_change' | 'undo_assign' | 'undo_tags';

/**
 * Undo for SINGLE-record actions (detail drawers, drag & drop, row buttons).
 * Bulk actions get the same behavior inside `useBulkTable`.
 *
 * - `deleteOne`  performs the soft delete itself (server audits it) and offers Undo.
 * - `updateOne`  is called AFTER the page's own successful write, so each page keeps
 *                its own validation / quality-gate error handling untouched.
 */
export function useUndoableActions() {
  const { user } = useAuth();
  const { toast } = useToast();
  const { offerUndo } = useUndo();

  const deleteOne = useCallback(
    async <T extends { id: string }>(o: {
      table: UndoTable;
      row: T;
      noun: Noun;
      label: string;
      onRemoved: () => void;
      onRestored: (row: T) => void;
    }): Promise<boolean> => {
      const result = await softDeleteRecords(rpcFn, o.table, [{ id: o.row.id, label: o.label }]);
      if (result.succeeded.length === 0) {
        toast(`Could not delete this ${o.noun.singular}.${result.failed[0] ? ` (${result.failed[0].reason})` : ''}`, 'error');
        return false;
      }
      o.onRemoved();
      offerUndo({
        message: `Deleted ${o.noun.singular}.`,
        undo: async () => {
          const r = await restoreSoftDeleted(rpcFn, result.undoIds);
          if (r.restored.includes(o.row.id)) o.onRestored(o.row);
          return summarizeRestore(r, o.noun);
        },
      });
      return true;
    },
    [offerUndo, toast],
  );

  const updateOne = useCallback(
    <T extends { id: string }>(o: {
      table: UndoTable;
      /** The row as it was BEFORE the change (read it before you set state). */
      row: T;
      /** What the page just wrote. */
      patch: Record<string, unknown>;
      /** Rows no longer holding this value were changed by someone else and are not reverted. */
      guard?: RevertGuard;
      noun: Noun;
      message: string;
      /** Logs the change itself (omit if the page already audits it). */
      audit?: 'status_change';
      undoAudit?: ChangeAudit;
      /** Apply the previous values to local state / refetch. */
      onReverted: (before: Record<string, unknown>) => void;
    }): void => {
      const snaps = snapshotRows([o.row], Object.keys(o.patch));
      const groups = planRevert(snaps);
      const before = snaps[0]?.before ?? {};
      if (o.audit) {
        void logBulkAudit({ action: o.audit, table: o.table, ids: [o.row.id], metadata: { to: o.patch, from: before } }, auditRpc, user?.id);
      }
      if (groups.length === 0) return;
      offerUndo({
        message: o.message,
        undo: async () => {
          const r = await revertUpdates(revertClient, o.table, groups, o.guard);
          if (r.reverted.length) {
            o.onReverted(before);
            await logBulkAudit(
              { action: o.undoAudit ?? 'undo_status_change', table: o.table, ids: r.reverted, metadata: { conflicts: r.conflicts.length } },
              auditRpc,
              user?.id,
            );
          }
          return summarizeRevert(r, o.noun);
        },
      });
    },
    [offerUndo, user?.id],
  );

  return { deleteOne, updateOne };
}
