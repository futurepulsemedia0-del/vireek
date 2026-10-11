import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react';
import type { Job, TeamMember } from '@/lib/supabase';
import { useToast } from '@/contexts/ToastContext';
import { useJobMoves } from '@/hooks/useJobMoves';
import {
  TERMINAL_STATUSES,
  describePatch,
  evaluateMove,
  resolveDrop,
  type DropTarget,
  type MoveContext,
  type MovePatch,
  type MovePlan,
} from '@/lib/scheduleDnd';

interface UseScheduleBoardOptions {
  jobs: Job[];
  setJobs: Dispatch<SetStateAction<Job[]>>;
  technicians: TeamMember[];
  /** Owner, or a team member with can_view_all_jobs. */
  canManage: boolean;
  /** Calendar day view: the day currently shown (YYYY-MM-DD). */
  viewDay?: string;
  onJobSynced?: (job: Job) => void;
  mapError?: (err: unknown) => string | null;
  /**
   * Async guard run after validation and before the optimistic update
   * (e.g. the compliance start dialog). Resolve false to abort silently.
   */
  beforeCommit?: (job: Job, patch: MovePatch) => Promise<boolean>;
}

/**
 * Page-level glue: turns "job X was dropped on target T" into
 * resolve → validate → (guard) → optimistic commit with Undo.
 * Calendar, Dispatch Board and Jobs Kanban all use this one hook.
 */
export function useScheduleBoard({
  jobs,
  setJobs,
  technicians,
  canManage,
  viewDay,
  onJobSynced,
  mapError,
  beforeCommit,
}: UseScheduleBoardOptions) {
  const { toast } = useToast();
  const moves = useJobMoves({ jobs, setJobs, onJobSynced, mapError });
  const { commit, isPending } = moves;

  const ctx = useMemo<MoveContext>(
    () => ({ jobs, technicians, canManage, viewDay }),
    [jobs, technicians, canManage, viewDay],
  );

  const plan = useCallback(
    (jobId: string, target: DropTarget): MovePlan | null => {
      const job = jobs.find((j) => j.id === jobId);
      if (!job) return null;
      const resolution = resolveDrop(job, target, ctx);
      if (!resolution) return null;
      return { resolution, check: evaluateMove(job, resolution.patch, ctx) };
    },
    [jobs, ctx],
  );

  const handleMove = useCallback(
    async (jobId: string, target: DropTarget): Promise<boolean> => {
      const job = jobs.find((j) => j.id === jobId);
      const p = plan(jobId, target);
      if (!job || !p) return false;
      if (!p.check.ok) {
        toast(p.check.reason, 'error');
        return false;
      }
      if (beforeCommit && !(await beforeCommit(job, p.resolution.patch))) return false;
      const what = describePatch(p.resolution.patch, technicians);
      const note = p.resolution.note ? ` ${p.resolution.note}` : '';
      return commit(jobId, p.resolution.patch, {
        successMessage: `${job.customer_name} moved ${what}.${note}`,
        warnings: p.check.warnings,
      });
    },
    [jobs, plan, toast, beforeCommit, technicians, commit],
  );

  /** Whether a card may be picked up at all (permission, finished jobs, in-flight saves). */
  const isDraggable = useCallback(
    (job: Job) => canManage && !TERMINAL_STATUSES.includes(job.job_status) && !isPending(job.id),
    [canManage, isPending],
  );

  return { plan, handleMove, isDraggable, moves };
}
