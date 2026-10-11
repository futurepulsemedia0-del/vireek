import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Job } from '@/lib/supabase';
import { useToast } from '@/contexts/ToastContext';
import { moveJob, type MoveJobResult } from '@/lib/scheduleDndApi';
import { invertPatch, snapshotOf, applyPatch, type JobSnapshot, type MovePatch } from '@/lib/scheduleDnd';

interface UseJobMovesOptions {
  /** Always the latest jobs array of the page (read through a ref, never stale). */
  jobs: Job[];
  setJobs: Dispatch<SetStateAction<Job[]>>;
  /** Called with the final server row after a successful move/undo (e.g. keep a drawer in sync). */
  onJobSynced?: (job: Job) => void;
  /** Lets a page translate DB errors it already understands (quality gate, evidence chain…). */
  mapError?: (err: unknown) => string | null;
  /** Enable the Ctrl/Cmd+Z shortcut. Default true. */
  enableShortcut?: boolean;
}

export interface CommitOptions {
  /** Toast text on success, e.g. "Moved to Tue, Oct 14". */
  successMessage: string;
  /** Extra info toast, e.g. a capacity/skill warning. */
  warnings?: string[];
}

interface UndoEntry {
  jobId: string;
  restore: MovePatch;
  expected: JobSnapshot;
}

const UNDO_WINDOW_MS = 8000;
const FALLBACK_ERROR = 'Could not move the job. Please try again.';

/**
 * Optimistic drag-and-drop mutation engine shared by Calendar, Dispatch Board and Jobs Kanban.
 *
 * - applies the move locally first, then confirms through the atomic `move_job` RPC;
 * - rolls back (or adopts the server row when someone else won the race) on any refusal;
 * - exposes an Undo action in the success toast (and Ctrl/Cmd+Z) that is itself a
 *   compare-and-swap, so it can never overwrite a later change by another user;
 * - tells the page which jobs are mid-flight so realtime echoes don't flicker them.
 */
export function useJobMoves({ jobs, setJobs, onJobSynced, mapError, enableShortcut = true }: UseJobMovesOptions) {
  const { toast } = useToast();
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const pendingRef = useRef<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const lastUndoRef = useRef<UndoEntry | null>(null);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const setPending = useCallback((id: string, on: boolean) => {
    if (on) pendingRef.current.add(id);
    else pendingRef.current.delete(id);
    if (!unmountedRef.current) setPendingIds(new Set(pendingRef.current));
  }, []);

  const isPending = useCallback((id: string) => pendingRef.current.has(id), []);

  const replaceJob = useCallback(
    (row: Job) => {
      setJobs((prev) => (prev.some((j) => j.id === row.id) ? prev.map((j) => (j.id === row.id ? { ...j, ...row } : j)) : prev));
      onJobSynced?.(row);
    },
    [setJobs, onJobSynced],
  );

  const rollback = useCallback(
    (jobId: string, before: JobSnapshot, touched: MovePatch) => {
      const restore = invertPatch(before, touched);
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, ...restore } : j)));
      const current = jobsRef.current.find((j) => j.id === jobId);
      if (current) onJobSynced?.({ ...current, ...restore });
    },
    [setJobs, onJobSynced],
  );

  /** Runs one move (or undo) end-to-end. Resolves true when the server accepted it. */
  const run = useCallback(
    async (
      jobId: string,
      patch: MovePatch,
      expected: JobSnapshot,
      onSuccess: (row: Job, result: MoveJobResult) => void,
    ): Promise<boolean> => {
      if (pendingRef.current.has(jobId)) {
        toast('This job is still saving — try again in a moment.', 'info');
        return false;
      }
      setPending(jobId, true);
      setJobs((prev) => prev.map((j) => (j.id === jobId ? applyPatch(j, patch) : j)));
      const optimistic = jobsRef.current.find((j) => j.id === jobId);
      if (optimistic) onJobSynced?.(applyPatch(optimistic, patch));

      try {
        const result = await moveJob(jobId, patch, expected);
        if (result.status === 'moved' && result.job) {
          replaceJob(result.job);
          onSuccess(result.job, result);
          return true;
        }
        if (result.status === 'stale' && result.job) {
          replaceJob(result.job); // someone else won — adopt their version
        } else {
          rollback(jobId, expected, patch);
        }
        toast(result.reason ?? FALLBACK_ERROR, 'error');
        return false;
      } catch (err) {
        rollback(jobId, expected, patch);
        toast(mapError?.(err) ?? (err instanceof Error && err.message ? err.message : FALLBACK_ERROR), 'error');
        return false;
      } finally {
        setPending(jobId, false);
      }
    },
    [toast, setJobs, setPending, replaceJob, rollback, onJobSynced, mapError],
  );

  const undo = useCallback(
    async (entry: UndoEntry) => {
      if (lastUndoRef.current === entry) lastUndoRef.current = null;
      const ok = await run(entry.jobId, entry.restore, entry.expected, () => {
        toast('Move undone.', 'success');
      });
      return ok;
    },
    [run, toast],
  );

  const commit = useCallback(
    async (jobId: string, patch: MovePatch, opts: CommitOptions): Promise<boolean> => {
      const job = jobsRef.current.find((j) => j.id === jobId);
      if (!job) return false;
      const before = snapshotOf(job);

      return run(jobId, patch, before, (row) => {
        const entry: UndoEntry = { jobId, restore: invertPatch(before, patch), expected: snapshotOf(row) };
        lastUndoRef.current = entry;
        toast(opts.successMessage, 'success', {
          durationMs: UNDO_WINDOW_MS,
          action: { label: 'Undo', onClick: () => void undo(entry) },
        });
        opts.warnings?.forEach((w) => toast(w, 'info'));
      });
    },
    [run, toast, undo],
  );

  const undoLast = useCallback(() => {
    const entry = lastUndoRef.current;
    if (entry) void undo(entry);
    return Boolean(entry);
  }, [undo]);

  useEffect(() => {
    if (!enableShortcut) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'z' || e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (undoLast()) e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enableShortcut, undoLast]);

  return { commit, undoLast, isPending, pendingIds };
}
