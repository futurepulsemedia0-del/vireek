import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { BulkActionBar, type Assignee, type BulkStatusOption } from '@/components/bulk/BulkActionBar';
import { BulkCheckbox } from '@/components/bulk/BulkCheckbox';
import { useBulkSelection } from '@/hooks/useBulkSelection';
import { exportToCsv, type CsvColumn } from '@/lib/csvExport';
import {
  bulkTags,
  bulkUpdate,
  summarize,
  type BulkClient,
  type BulkResult,
  type BulkTable,
  type RowUpdate,
} from '@/lib/bulk/engine';
import { logBulkAudit, type AuditRpc, type BulkAuditAction } from '@/lib/bulk/audit';
import { useUndo } from '@/contexts/UndoContext';
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
  type UndoOutcome,
} from '@/lib/undo/undoEngine';

type BulkRow = { id: string; tags?: string[] | null };

export interface BulkTableConfig<T extends BulkRow> {
  table: BulkTable;
  /** Rows in the exact order they are displayed (drives shift-click ranges + pruning). */
  rows: T[];
  noun: { singular: string; plural: string };
  getLabel: (row: T) => string;
  exportColumns: CsvColumn<T>[];
  exportFilename: string;
  statusField: string;
  statusOptions?: BulkStatusOption[];
  /** Extra columns to write with a status (e.g. sent_at, paid_at), keyed by option value. */
  statusExtras?: (value: string) => Record<string, unknown>;
  /** Force row-by-row status updates (DB triggers validate each row). */
  perRowStatus?: boolean;
  /** Return a reason to skip a row for a status change, else null. */
  beforeStatus?: (row: T, option: BulkStatusOption) => Promise<string | null>;
  /** Column that stores the assignee (`assigned_to` or `assigned_technician_id`). Omit to hide Assign. */
  assignField?: string;
  /** Provide when the page already has the list (jobs → technicians). Otherwise team members are lazy-loaded. */
  assignees?: Assignee[];
  /** Return a reason to protect a row from bulk deletion, else null. */
  canDelete?: (row: T) => string | null;
  /** Ids on the current page (for header checkbox when the table is paginated). Defaults to all rows. */
  pageIds?: string[];
  onRowsChanged: (updates: RowUpdate[]) => void;
  onRowsRemoved: (ids: string[]) => void;
  /** Undo of a delete: put these rows back into the page's list (see `mergeRestored`). */
  onRowsRestored: (rows: T[]) => void;
}

type Pending = { kind: 'delete' } | { kind: 'status'; option: BulkStatusOption } | null;

const client = supabase as unknown as BulkClient;
const rpc: AuditRpc = (fn, args) => supabase.rpc(fn, args) as unknown as ReturnType<AuditRpc>;
const rpcFn: RpcFn = (fn, args) => supabase.rpc(fn, args) as unknown as ReturnType<RpcFn>;
const revertClient = supabase as unknown as RevertClient;

export function useBulkTable<T extends BulkRow>(config: BulkTableConfig<T>) {
  const { user } = useAuth();
  const { toast } = useToast();
  const { offerUndo } = useUndo();
  const selection = useBulkSelection(config.rows);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [loadedAssignees, setLoadedAssignees] = useState<Assignee[] | null>(null);
  const [assigneesLoading, setAssigneesLoading] = useState(false);
  const cfg = useRef(config);
  cfg.current = config;

  const audit = useCallback(
    async (action: BulkAuditAction, ids: string[], metadata: Record<string, unknown>) => {
      const ok = await logBulkAudit({ action, table: cfg.current.table, ids, metadata }, rpc, user?.id);
      if (!ok) toast('Done, but the audit log entry could not be saved.', 'info');
    },
    [toast, user?.id],
  );

  /**
   * `undo` (optional) turns the summary toast into a 10-second Undo toast.
   * `audited` = the server already wrote the audit row (soft delete does), so don't double-log.
   */
  const finish = useCallback(
    async (
      result: BulkResult,
      verb: string,
      action: BulkAuditAction,
      metadata: Record<string, unknown>,
      undo?: () => Promise<UndoOutcome>,
      audited = false,
    ) => {
      const c = cfg.current;
      if (result.succeeded.length && !audited) {
        await audit(action, result.succeeded, { ...metadata, requested: result.requested, failed: result.failed.length, skipped: result.skipped.length });
      }
      selection.remove(result.succeeded);
      const ok = result.succeeded.length > 0;
      const clean = ok && !result.failed.length;
      const message = summarize(result, verb, c.noun);
      if (undo && ok) offerUndo({ message, undo, tone: clean ? 'success' : 'error' });
      else toast(message, clean ? 'success' : 'error');
    },
    [audit, offerUndo, selection, toast],
  );

  /** Builds the inverse for an update: snapshot the rows NOW, revert later (only rows still holding our value). */
  const makeRevert = useCallback(
    (rows: T[], ids: string[], keys: string[], guard: RevertGuard | undefined, action: BulkAuditAction) => {
      const done = new Set(ids);
      const snaps = snapshotRows(rows.filter((r) => done.has(r.id)), keys);
      const groups = planRevert(snaps);
      const beforeById = new Map(snaps.map((s) => [s.id, s.before]));
      return async (): Promise<UndoOutcome> => {
        const c = cfg.current;
        const r = await revertUpdates(revertClient, c.table, groups, guard);
        c.onRowsChanged(r.reverted.map((id) => ({ id, patch: beforeById.get(id) ?? {} })));
        if (r.reverted.length) await audit(action, r.reverted, { conflicts: r.conflicts.length, failed: r.failed.length });
        return summarizeRevert(r, c.noun);
      };
    },
    [audit],
  );

  const guarded = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Bulk action failed.', 'error');
    } finally {
      setBusy(false);
    }
  }, [toast]);

  const runStatus = useCallback(
    (option: BulkStatusOption) =>
      guarded(async () => {
        const c = cfg.current;
        const rows = selection.selectedRows;
        const byId = new Map(rows.map((r) => [r.id, r]));
        const patch = { [c.statusField]: option.value, ...(c.statusExtras?.(option.value) ?? {}) };
        const result = await bulkUpdate(client, c.table, rows.map((r) => r.id), patch, {
          perRow: c.perRowStatus,
          guard: c.beforeStatus ? (id) => c.beforeStatus!(byId.get(id) as T, option) : undefined,
        });
        c.onRowsChanged(result.succeeded.map((id) => ({ id, patch })));
        const undo = makeRevert(rows, result.succeeded, Object.keys(patch), { column: c.statusField, value: option.value }, 'undo_status_change');
        await finish(result, 'Updated', 'bulk_status_change', { field: c.statusField, to: option.value }, undo);
      }),
    [finish, guarded, makeRevert, selection.selectedRows],
  );

  const runAssign = useCallback(
    (assigneeId: string | null) =>
      guarded(async () => {
        const c = cfg.current;
        if (!c.assignField) return;
        const rows = selection.selectedRows;
        const patch = { [c.assignField]: assigneeId };
        const result = await bulkUpdate(client, c.table, rows.map((r) => r.id), patch);
        c.onRowsChanged(result.succeeded.map((id) => ({ id, patch })));
        const undo = makeRevert(rows, result.succeeded, [c.assignField], { column: c.assignField, value: assigneeId }, 'undo_assign');
        await finish(result, assigneeId ? 'Assigned' : 'Unassigned', 'bulk_assign', { field: c.assignField, to: assigneeId }, undo);
      }),
    [finish, guarded, makeRevert, selection.selectedRows],
  );

  const runTags = useCallback(
    (mode: 'add' | 'remove', tags: string[]) =>
      guarded(async () => {
        const c = cfg.current;
        const result = await bulkTags(client, c.table, selection.selectedRows, mode, tags);
        c.onRowsChanged(result.updates);
        const undo = makeRevert(selection.selectedRows, result.succeeded, ['tags'], undefined, 'undo_tags');
        await finish(result, mode === 'add' ? 'Tagged' : 'Untagged', mode === 'add' ? 'bulk_tag_add' : 'bulk_tag_remove', { tags }, undo);
      }),
    [finish, guarded, makeRevert, selection.selectedRows],
  );

  const runDelete = useCallback(
    () =>
      guarded(async () => {
        const c = cfg.current;
        const rows = selection.selectedRows;
        const protectedRows: { id: string; reason: string }[] = [];
        const deletable = rows.filter((r) => {
          const reason = c.canDelete?.(r) ?? null;
          if (reason) protectedRows.push({ id: r.id, reason });
          return !reason;
        });
        const result = await softDeleteRecords(rpcFn, c.table, deletable.map((r) => ({ id: r.id, label: c.getLabel(r) })));
        result.skipped = protectedRows;
        result.requested = rows.length;
        c.onRowsRemoved(result.succeeded);
        const gone = new Set(result.succeeded);
        const removed = deletable.filter((r) => gone.has(r.id));
        const undo = result.undoIds.length
          ? async (): Promise<UndoOutcome> => {
              const r = await restoreSoftDeleted(rpcFn, result.undoIds);
              const back = new Set(r.restored);
              cfg.current.onRowsRestored(removed.filter((x) => back.has(x.id)));
              return summarizeRestore(r, cfg.current.noun);
            }
          : undefined;
        // The server already wrote the audit row (with labels + undo id) — don't log twice.
        await finish(result, 'Deleted', 'bulk_delete', {}, undo, true);
      }),
    [finish, guarded, selection.selectedRows],
  );

  const runExport = useCallback(() => {
    const c = cfg.current;
    const rows = selection.selectedRows;
    exportToCsv(rows, c.exportColumns, `${c.exportFilename}-${new Date().toISOString().slice(0, 10)}`);
    void audit('bulk_export', rows.map((r) => r.id), { format: 'csv' });
    toast(`Exported ${rows.length} ${rows.length === 1 ? c.noun.singular : c.noun.plural}.`, 'success');
  }, [audit, selection.selectedRows, toast]);

  const loadAssignees = useCallback(async () => {
    if (cfg.current.assignees || loadedAssignees || assigneesLoading) return;
    setAssigneesLoading(true);
    try {
      const { data } = await supabase
        .from('team_members')
        .select('id, member_name, member_email')
        .eq('invite_status', 'active');
      setLoadedAssignees(
        ((data as { id: string; member_name: string | null; member_email: string }[]) ?? []).map((m) => ({
          id: m.id,
          name: m.member_name || m.member_email,
        })),
      );
    } finally {
      setAssigneesLoading(false);
    }
  }, [assigneesLoading, loadedAssignees]);

  const count = selection.count;
  const label = count === 1 ? config.noun.singular : config.noun.plural;
  const tagSuggestions = useMemo(
    () => Array.from(new Set(config.rows.flatMap((r) => r.tags ?? []))).sort(),
    [config.rows],
  );
  const pageIds = useMemo(() => config.pageIds ?? config.rows.map((r) => r.id), [config.pageIds, config.rows]);

  const confirmProps = (() => {
    if (pending?.kind === 'delete') {
      const protectedCount = config.canDelete ? selection.selectedRows.filter((r) => config.canDelete!(r)).length : 0;
      return {
        title: `Delete ${count} ${label}?`,
        description:
          `This removes the selected ${label} from your workspace and records it in your audit log. You'll have 10 seconds to undo.` +
          (protectedCount ? ` ${protectedCount} protected record${protectedCount === 1 ? '' : 's'} will be skipped.` : ''),
        confirmPhrase: count >= 10 ? 'delete' : undefined,
        confirmLabel: `Yes, delete ${count} ${label}`,
      };
    }
    if (pending?.kind === 'status') {
      return {
        title: `${pending.option.label} — ${count} ${label}?`,
        description: pending.option.confirm ?? 'This will update every selected record and is recorded in your audit log.',
        confirmPhrase: undefined,
        confirmLabel: 'Yes, apply',
      };
    }
    return { title: '', description: '', confirmPhrase: undefined, confirmLabel: '' };
  })();

  const bar: ReactNode = (
    <>
      <BulkActionBar
        count={count}
        noun={config.noun}
        busy={busy}
        totalMatching={config.rows.length}
        onSelectAllMatching={config.pageIds ? selection.selectAll : undefined}
        onClear={selection.clear}
        statusOptions={config.statusOptions}
        onStatus={config.statusOptions ? (o) => (o.confirm ? setPending({ kind: 'status', option: o }) : void runStatus(o)) : undefined}
        assignees={config.assignees ?? loadedAssignees ?? []}
        assigneesLoading={assigneesLoading}
        onOpenAssign={loadAssignees}
        onAssign={config.assignField ? (id) => void runAssign(id) : undefined}
        tagSuggestions={tagSuggestions}
        onTags={(mode, tags) => void runTags(mode, tags)}
        onExport={runExport}
        onDelete={() => setPending({ kind: 'delete' })}
      />
      <ConfirmDialog
        open={pending !== null}
        title={confirmProps.title}
        description={confirmProps.description}
        confirmPhrase={confirmProps.confirmPhrase}
        confirmLabel={confirmProps.confirmLabel}
        onCancel={() => setPending(null)}
        onConfirm={async () => {
          const p = pending;
          setPending(null);
          if (p?.kind === 'delete') await runDelete();
          else if (p?.kind === 'status') await runStatus(p.option);
        }}
      />
    </>
  );

  return {
    selection,
    bar,
    headerCheckbox: () => (
      <BulkCheckbox
        state={selection.stateFor(pageIds)}
        label={`Select all ${config.noun.plural}`}
        onToggle={() => selection.toggleMany(pageIds)}
      />
    ),
    rowCheckbox: (id: string, rowLabel: string) => (
      <BulkCheckbox
        state={selection.isSelected(id) ? 'all' : 'none'}
        label={`Select ${rowLabel}`}
        onToggle={(shift) => selection.toggle(id, shift)}
      />
    ),
  };
}
