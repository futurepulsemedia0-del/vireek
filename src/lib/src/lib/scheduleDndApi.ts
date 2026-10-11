import { supabase, type Job } from '@/lib/supabase';
import { isDoubleBookingError, DOUBLE_BOOKING_MESSAGE } from '@/lib/bookingConflict';
import type { JobSnapshot, MovePatch } from '@/lib/scheduleDnd';

export type MoveJobStatus =
  | 'moved'
  | 'stale'
  | 'forbidden'
  | 'blocked'
  | 'blocked_compliance'
  | 'at_capacity'
  | 'conflict'
  | 'not_found';

export interface MoveJobResult {
  status: MoveJobStatus;
  reason?: string;
  /** Present for `moved` (the new row) and `stale` (the current server row). */
  job?: Job;
}

/**
 * Applies a drag-and-drop move through the `move_job` RPC (atomic, tenant-scoped,
 * capacity/compliance/overlap-checked, compare-and-swap on `expected`).
 * Business-rule refusals come back as a status; unexpected DB errors are thrown
 * so callers can reuse their existing quality-gate / evidence-chain parsing.
 */
export async function moveJob(jobId: string, patch: MovePatch, expected: JobSnapshot): Promise<MoveJobResult> {
  const { data, error } = await supabase.rpc('move_job', {
    p_job_id: jobId,
    p_patch: patch,
    p_expected: expected,
  });
  if (error) {
    if (isDoubleBookingError(error)) return { status: 'conflict', reason: DOUBLE_BOOKING_MESSAGE };
    throw error;
  }
  return data as MoveJobResult;
}
